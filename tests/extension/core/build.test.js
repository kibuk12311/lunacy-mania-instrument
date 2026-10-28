// tools/build-extension.mjs: the analyzer's graph copied with its relative paths, model.js's import swapped exactly
// once, no static node:/bare import left, the data files there, the manifests and locales, the fingerprint.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzerFingerprint, importGraph, readFrom } from "../../../src/core/analyzerVersion.js";
import {
    GRAPH_ROOTS, LIB_DATA_FILES, MODEL_FILE, MODEL_IMPORT, MODEL_SHIM, ORT_BROWSER, buildExtension, checkModules,
    staticSpecifiers,
} from "../../../tools/build-extension.mjs";
import { ROOT, buildForTest } from "./buildHelper.js";

const exists = (p) => stat(p).then(() => true, () => false);
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

test("both targets: the analyzer graph, the shim line, data files, manifests, locales, fingerprint", async (t) => {
    const built = await buildForTest(t);
    const { texts } = await importGraph(readFrom(ROOT), [...GRAPH_ROOTS]);
    assert.ok(texts.size > 50, `graph of ${texts.size} files`);
    const { fingerprint } = await analyzerFingerprint();
    assert.equal(built.fingerprint, fingerprint);

    for (const target of ["chrome", "firefox"]) {
        const dir = built.targets[target];
        const lib = path.join(dir, "lib");
        for (const rel of texts.keys()) {
            assert.ok(await exists(path.join(lib, rel)), `${target}: lib/${rel}`);
            if (rel === MODEL_FILE) continue;
            const original = await readFile(path.join(ROOT, rel));
            assert.ok(original.equals(await readFile(path.join(lib, rel))), `${target}: lib/${rel} copied byte for byte`);
        }
        const model = await readFile(path.join(lib, MODEL_FILE), "utf8");
        assert.equal(model.split(MODEL_SHIM).length - 1, 1, "the shim import once");
        assert.ok(!model.includes(MODEL_IMPORT), "no node:fs import left in model.js");
        const original = await readFile(path.join(ROOT, MODEL_FILE), "utf8");
        assert.equal(model, original.replace(MODEL_IMPORT, MODEL_SHIM), "nothing else in model.js changed");
        assert.ok(await exists(path.join(dir, "analysis", "readFileShim.js")), "the shim the copy names");

        for (const rel of LIB_DATA_FILES) assert.ok(await exists(path.join(lib, rel)), `${target}: data ${rel}`);
        assert.ok(LIB_DATA_FILES.includes(ORT_BROWSER));
        assert.ok(!(await exists(path.join(lib, "vendor/leoblack/js/estimator/companella/ort/ort.node.min.mjs"))), "no Node ORT entry");
        assert.deepEqual(await checkModules(dir), [], `${target}: no static node:/bare import, no missing relative import`);

        const generated = await readFile(path.join(lib, "analyzerVersion.generated.js"), "utf8");
        const { ANALYZER } = await import(`data:text/javascript,${encodeURIComponent(generated)}`);
        const pkg = await readJson(path.join(ROOT, "package.json"));
        assert.equal(ANALYZER.fingerprint, fingerprint);
        assert.equal(ANALYZER.appVersion, pkg.version);
        assert.match(ANALYZER.vendor, /^[0-9a-f]{8}$/);

        for (const rel of ["LICENSE", "THIRD_PARTY_NOTICES.md", "icons/icon.png", "lib/vendor/leoblack/LICENSE",
            "_locales/en/messages.json", "_locales/ru/messages.json", "manifest.json", "background/router.js",
            "shared/protocol.js", "analysis/worker.js"]) {
            assert.ok(await exists(path.join(dir, rel)), `${target}: ${rel}`);
        }
        assert.match(await readFile(path.join(lib, "vendor/leoblack/LICENSE"), "utf8"), /Leo_Black/);
        assert.ok(!(await exists(path.join(dir, "DESIGN.md"))));
    }
    const chrome = built.targets.chrome;
    const firefox = built.targets.firefox;
    assert.ok(await exists(path.join(chrome, "offscreen", "offscreen.html")));
    assert.ok(await exists(path.join(chrome, "background", "sw.js")));
    assert.ok(!(await exists(path.join(chrome, "background", "firefox.js"))));
    assert.ok(!(await exists(path.join(firefox, "offscreen"))), "Firefox gets no offscreen/");
    assert.ok(await exists(path.join(firefox, "background", "firefox.js")));
    assert.ok(!(await exists(path.join(firefox, "background", "sw.js"))));
    assert.ok(built.bytes > 10e6 && built.bytes < 40e6, `${(built.bytes / 1e6).toFixed(1)} MB`);
});

test("the manifests: valid, equal except background/offscreen/gecko/minimum_chrome_version", async () => {
    const chrome = await readJson(path.join(ROOT, "extension", "manifest.chrome.json"));
    const firefox = await readJson(path.join(ROOT, "extension", "manifest.firefox.json"));
    assert.deepEqual(chrome.background, { service_worker: "background/sw.js", type: "module" });
    assert.deepEqual(firefox.background, { scripts: ["background/firefox.js"], type: "module" });
    assert.equal(chrome.minimum_chrome_version, "116");
    assert.ok(chrome.permissions.includes("offscreen"));
    assert.ok(!firefox.permissions.includes("offscreen"));
    assert.equal(firefox.browser_specific_settings.gecko.id, "lunacy-mania-dans@lunacy-mania");
    assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "128.0");
    assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, { required: ["none"] });

    const common = (m) => {
        const { background, minimum_chrome_version, browser_specific_settings, ...rest } = m;
        return { ...rest, permissions: rest.permissions.filter((p) => p !== "offscreen") };
    };
    assert.deepEqual(common(chrome), common(firefox));
    const m = common(chrome);
    assert.equal(m.manifest_version, 3);
    assert.equal(m.name, "__MSG_extName__");
    assert.equal(m.default_locale, "en");
    assert.deepEqual(m.permissions, ["storage"]);
    assert.deepEqual(m.host_permissions, ["https://osu.ppy.sh/*", "https://b.ppy.sh/*", "https://*.ppy.sh/*"]);
    assert.deepEqual(m.content_scripts, [{ matches: ["https://osu.ppy.sh/*"], js: ["content/loader.js"], run_at: "document_idle" }]);
    assert.deepEqual(m.web_accessible_resources, [{ resources: ["content/*", "shared/*", "player/*", "icons/*"], matches: ["https://osu.ppy.sh/*"] }]);
    assert.equal(m.content_security_policy.extension_pages, "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    assert.equal(m.action, undefined);
    assert.equal(m.options_page, undefined);
});

test("locales: extName and extDescription in en and ru, description at most 132 characters, never 'official'", async () => {
    const names = { en: "Lunacy mania: dans for osu!", ru: "Lunacy mania: даны для osu!" };
    for (const lang of ["en", "ru"]) {
        const messages = await readJson(path.join(ROOT, "extension", "_locales", lang, "messages.json"));
        assert.equal(messages.extName.message, names[lang]);
        const description = messages.extDescription.message;
        assert.ok(description.length > 40 && description.length <= 132, `${lang}: ${description.length}`);
        assert.doesNotMatch(`${messages.extName.message} ${description}`, /official|официальн/i);
    }
});

test("the build refuses a model.js whose import line is not there exactly once, and static node:/bare imports", async (t) => {
    // a tiny tree: the graph roots and the files the build copies
    const root = await mkdtemp(path.join(tmpdir(), "lm-ext-tree-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (rel, data) => {
        await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await writeFile(path.join(root, rel), data);
    };
    await put("package.json", JSON.stringify({ version: "9.9.9" }));
    await put("LICENSE", "MIT");
    await put("vendor/leoblack/LICENSE", "MIT Leo_Black");
    await put("vendor/leoblack/VERSION", "0123456789abcdef");
    await put("app/assets/icon.png", Buffer.from([137, 80, 78, 71]));
    for (const rel of LIB_DATA_FILES) await put(rel, "x");
    await put("vendor/leoblack/js/estimator/companella/ort/ort.node.min.mjs", "x");
    await put("src/core/analyze.js", 'import { loadModel } from "./model.js";\nimport { numericToLabel } from "./labels.js";\nexport const a = 1;\n');
    const LABELS = 'import { t } from "../i18n/i18n.js";\nexport const numericToLabel = (n) => ({ text: t(String(n)) });\nexport const confidenceWord = (w) => w;\n';
    await put("src/core/labels.js", LABELS);
    await put("src/i18n/i18n.js", "export const setLang = (l) => l;\nexport const t = (k) => k;\n");
    await put("src/analysis/timeline.js", "export {};\n");
    await put("src/analysis/sections.js", "export {};\n");
    await cp(path.join(ROOT, "extension"), path.join(root, "extension"), { recursive: true, filter: (src) => !src.includes(`${path.sep}build`) });
    const out = path.join(root, "out");

    await put("src/core/model.js", "export const loadModel = 1;\n");
    await assert.rejects(buildExtension({ root, out, targets: ["chrome"] }), /exactly once, found 0/);
    await put("src/core/model.js", `${MODEL_IMPORT}\n${MODEL_IMPORT}\nexport const loadModel = 1;\n`);
    await assert.rejects(buildExtension({ root, out, targets: ["chrome"] }), /exactly once, found 2/);
    await put("src/core/model.js", `${MODEL_IMPORT}\nexport const loadModel = 1;\n`);
    const ok = await buildExtension({ root, out, targets: ["chrome"] });
    assert.equal(ok.appVersion, "9.9.9");
    await put("src/core/labels.js", `import os from "node:os";\n${LABELS}`);
    await assert.rejects(buildExtension({ root, out, targets: ["chrome"] }), /static import of node:os/);
    await put("src/core/labels.js", `import { x } from "left-pad";\n${LABELS}`);
    await assert.rejects(buildExtension({ root, out, targets: ["chrome"] }), /bare import of left-pad/);

    // never deletes a folder it did not make
    const foreign = path.join(root, "foreign");
    await put("foreign/chrome/keep.txt", "mine");
    await put("src/core/labels.js", LABELS);
    await assert.rejects(buildExtension({ root, out: foreign, targets: ["chrome"] }), /refusing to replace/);
    assert.equal(await readFile(path.join(foreign, "chrome", "keep.txt"), "utf8"), "mine");
    assert.ok((await readdir(path.join(out, "chrome"))).includes("manifest.json"));
});

test("staticSpecifiers: real imports, minified ones, not words in comments or strings", () => {
    const src = [
        'import { a } from "./a.js";',
        "import './side.js';",
        'export * from "../b.js";',
        "import {\n  c,\n  d,\n} from \"./multi.js\";",
        '// the history import\n    "profile.import.scan": 1,',
        'var x=1;import{createRequire}from"module";',
        "const u = import.meta.url;",
        'const lazy = () => import("./lazy.js");',
    ].join("\n");
    assert.deepEqual(staticSpecifiers(src), ["./a.js", "./side.js", "../b.js", "./multi.js", "module"]);
});
