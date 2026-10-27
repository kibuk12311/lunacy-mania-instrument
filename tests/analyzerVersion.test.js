// The analyzer fingerprint (src/core/analyzerVersion.js) over a made-up tree and the real one, the shipped table of
// release fingerprints (src/core/analyzerReleases.js), and the result folders it names (app/resultsFolder.js) in temp
// folders only: the newest folder of the same analyzer renamed into place, the others' results moved in, the other old
// per-version folders removed, another analyzer's results-<16 hex> folder and everything else never touched.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    analyzerFingerprint, relativeImports, messageKeys, messageSource, readFrom, APP_ROOT, ROOTS, DATA_FILES, FORMAT,
} from "../src/core/analyzerVersion.js";
import { RELEASE_FINGERPRINTS } from "../src/core/analyzerReleases.js";
import { SAME_RESULTS, resultsIdOf } from "../src/core/analyzerSameResults.js";
import { prepareResultsDir, isResultsDir, resultsDirName } from "../app/resultsFolder.js";
import { releaseCommits } from "../tools/analyzer-fingerprints.mjs";

// the newest release whose analysis this tree still has; null once the analysis changed after the last release
// (an update then works every result out again, as it should)
const SAME_ANALYSIS_AS = "0.9.9";

// a small app: the analysis, its texts (one named by the analysis, the rest the UI's), a renderer file, a model
const TREE = {
    "src/core/analyze.js": 'import { f } from "./features.js";\nimport { t } from "../i18n/i18n.js";\nexport const a = () => t("core.x") + f;\n',
    "src/core/features.js": "export const f = 1;\n",
    "src/i18n/i18n.js": 'import { AREAS } from "./messages/index.js";\nexport const t = (k) => k;\n',
    "src/i18n/messages/index.js": 'import core from "./core.js";\nimport app from "./app.js";\nexport const AREAS = { core, app };\n',
    "src/i18n/messages/core.js": 'export default {\n    "core.x": { ru: "икс", en: "ex" },\n    "core.y": { ru: "игрек", en: "why" },\n};\n',
    "src/i18n/messages/app.js": 'export default {\n    "app.ui": { ru: "кнопка", en: "button" },\n};\n',
    "app/renderer/view.js": 'import { a } from "../../src/core/analyze.js";\nexport const show = () => a();\n',
    "models/dan_model.json": '{\n  "spread": [1, 2]\n}\n',
    "vendor/calc.wasm": Buffer.from([0, 97, 115, 109, 13, 10, 1]),
};
const OPTIONS = { roots: ["src/core/analyze.js"], dataFiles: ["models/dan_model.json", "vendor/calc.wasm"] };
const reader = (tree) => async (rel) => (rel in tree ? Buffer.from(tree[rel]) : null);
const fingerprintOf = async (tree, options = {}) => (await analyzerFingerprint({ read: reader(tree), ...OPTIONS, ...options })).fingerprint;
const crlf = (tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, typeof v === "string" ? v.replace(/\n/g, "\r\n") : v]));

test("relativeImports finds static, re-exported and literal dynamic imports, not bare or computed ones", () => {
    const source = [
        'import x from "./a.js";',
        "import {\n    b,\n    c as d,\n} from '../b.js';",
        'import "./side.js";',
        'import * as ns from "./ns.js";',
        'export { e } from "./e.js";',
        'export * from "./all.js";',
        'const m = await import("./dyn.js");',
        'const n = import(IS_NODE ? "./node.mjs" : "./web.mjs");',
        'import fs from "node:fs";',
        'import{y}from"./min.js";',
    ].join("\n");
    assert.deepEqual(relativeImports(source), ["./a.js", "../b.js", "./side.js", "./ns.js", "./e.js", "./all.js", "./dyn.js", "./min.js"]);
});

test("messageKeys and messageSource: the keys named literally, a value whole however it is written", () => {
    assert.deepEqual(messageKeys('t("core.a"); t(\'core.b\', { n }); t(`gen.${id}`); split("x")'), ["core.a", "core.b"]);
    const messages = [
        "export default {",
        '    "k.plain": { ru: "а, б", en: "a, b" },',
        '    "k.fn": {',
        "        ru: ({ n }) => `${n} карт {x}`,",
        '        en: (p) => (p.n === 1 ? "map" : "maps"), // a comment, with a comma',
        "    },",
        '    "k.last": { ru: "в", en: "c" }',
        "};",
    ].join("\n");
    assert.equal(messageSource(messages, "k.plain"), '{ ru: "а, б", en: "a, b" }');
    assert.match(messageSource(messages, "k.fn"), /^\{\n\s+ru: \(\{ n \}\) => `\$\{n\} карт \{x\}`,[\s\S]*maps"\), \/\/ a comment, with a comma\n\s+\}$/);
    assert.equal(messageSource(messages, "k.last"), '{ ru: "в", en: "c" }');
    assert.equal(messageSource(messages, "k.none"), null);
    assert.equal(messageSource(messages, "k"), null, "a key is matched whole");
});

test("the fingerprint: 16 hex, the same with CRLF or LF and in any order of roots and data files", async () => {
    const base = await analyzerFingerprint({ read: reader(TREE), ...OPTIONS });
    assert.match(base.fingerprint, /^[0-9a-f]{16}$/);
    assert.deepEqual(base.code, ["src/core/analyze.js", "src/core/features.js"], "src/i18n is not hashed as code");
    assert.deepEqual(base.texts, ["core.x"]);
    assert.deepEqual(base.missing, []);
    assert.equal(await fingerprintOf(TREE), base.fingerprint, "worked out again");
    assert.equal(await fingerprintOf(crlf(TREE)), base.fingerprint, "CRLF reads as LF");
    assert.equal(await fingerprintOf(TREE, { roots: ["src/core/features.js", "src/core/analyze.js"], dataFiles: [...OPTIONS.dataFiles].reverse() }), base.fingerprint);
});

test("the fingerprint changes with the analysis, its model, a text it words results with, a missing file and FORMAT", async () => {
    const base = await fingerprintOf(TREE);
    const changed = (patch) => fingerprintOf({ ...TREE, ...patch });
    assert.notEqual(await changed({ "src/core/features.js": "export const f = 2;\n" }), base, "an analysis file");
    assert.notEqual(await changed({ "models/dan_model.json": '{\n  "spread": [1, 3]\n}\n' }), base, "the model");
    assert.notEqual(await changed({ "vendor/calc.wasm": Buffer.from([0, 97, 115, 109, 10, 1]) }), base, "binary data is not read as text");
    assert.notEqual(await changed({ "src/i18n/messages/core.js": TREE["src/i18n/messages/core.js"].replace("икс", "икс!") }), base, "a text a result holds");
    const { "src/core/features.js": _gone, ...withoutFeatures } = TREE;
    const missing = await analyzerFingerprint({ read: reader(withoutFeatures), ...OPTIONS });
    assert.notEqual(missing.fingerprint, base);
    assert.deepEqual(missing.missing, ["src/core/features.js"]);
    assert.notEqual(await fingerprintOf(TREE, { format: FORMAT + 1 }), base, "FORMAT, bumped by hand");
});

test("the fingerprint stays when only the UI changes: a renderer file, another text, a new messages area", async () => {
    const base = await fingerprintOf(TREE);
    const same = (patch) => fingerprintOf({ ...TREE, ...patch });
    assert.equal(await same({ "app/renderer/view.js": "export const show = () => 0;\n" }), base);
    assert.equal(await same({ "src/i18n/messages/core.js": TREE["src/i18n/messages/core.js"].replace("игрек", "игрек!") }), base);
    assert.equal(await same({ "src/i18n/messages/app.js": 'export default {\n    "app.ui": { ru: "кнопочка", en: "button" },\n};\n' }), base);
    assert.equal(await same({
        "src/i18n/messages/index.js": 'import core from "./core.js";\nimport app from "./app.js";\nimport more from "./more.js";\nexport const AREAS = { core, app, more };\n',
        "src/i18n/messages/more.js": 'export default { "more.ui": { ru: "ещё", en: "more" } };\n',
    }), base);
    assert.equal(await same({ "src/i18n/i18n.js": `// the texts\n${TREE["src/i18n/i18n.js"]}` }), base);
});

test("the real tree: every root and data file is there, the graph holds the analysis and no UI", async () => {
    const r = await analyzerFingerprint();
    assert.deepEqual(r.missing, []);
    for (const root of ROOTS) assert.ok(r.code.includes(root), root);
    for (const file of ["src/core/model.js", "src/core/labels.js", "src/analysis/sectionCalibration.js", "src/core/leoblack.js", "vendor/leoblack/js/ett/calc.js"]) {
        assert.ok(r.code.includes(file), file);
    }
    assert.ok(r.code.every((f) => !f.startsWith("src/i18n/") && !f.startsWith("app/")), "no texts, no app modules");
    assert.ok(r.texts.includes("core.label.belowFirst") && r.texts.includes("core.confidence.high"));
    assert.deepEqual(r.data, [...DATA_FILES].sort());
    assert.equal((await analyzerFingerprint({ read: readFrom(APP_ROOT) })).fingerprint, r.fingerprint);
});

// what the analysis loads at run time and does not import: every such file next to its code must be hashed
test("every model, wasm and ONNX file the analysis reads at run time is in DATA_FILES", async () => {
    const r = await analyzerFingerprint();
    const near = (dir) => readdirSync(path.join(APP_ROOT, dir), { recursive: true }).map((f) => `${dir}/${String(f).replace(/\\/g, "/")}`);
    const runtime = [...near("vendor/leoblack/js/ett/versions"), ...near("vendor/leoblack/js/estimator/companella")]
        .filter((f) => /\.(wasm|onnx|json)$/.test(f) || /companella\/ort\/.*\.mjs$/.test(f))
        .filter((f) => !f.endsWith("ort.wasm.min.mjs")); // the browser's build of the runtime, never loaded under Node
    for (const file of [...runtime, "models/dan_model.json"]) assert.ok(DATA_FILES.includes(file), file);
    // and every `new URL("./…", import.meta.url)` of the graph points at a data file, a folder of them, or code
    for (const rel of r.code) {
        const source = await readFile(path.join(APP_ROOT, rel), "utf8");
        for (const m of source.matchAll(/new URL\(\s*["'`](\.{1,2}\/[^"'`$]*)["'`]\s*,\s*import\.meta\.url/g)) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
            assert.ok(DATA_FILES.some((d) => d === target || d.startsWith(target)) || r.code.includes(target), `${rel} → ${target}`);
        }
    }
});

test(`the shipped table: today's analyzer is the one of ${SAME_ANALYSIS_AS}`, { skip: SAME_ANALYSIS_AS === null }, async () => {
    const { fingerprint } = await analyzerFingerprint();
    // an analyzer shown to give the same answers takes that one's results (src/core/analyzerSameResults.js)
    assert.equal(RELEASE_FINGERPRINTS[SAME_ANALYSIS_AS], resultsIdOf(fingerprint),
        "the analysis changed since that release: set SAME_ANALYSIS_AS to null (an update then analyses again) or rerun tools/analyzer-fingerprints.mjs --write if the rules changed");
});

test("same answers, same results: a proven row maps to the earlier fingerprint, anything else is its own", () => {
    for (const [from, to] of Object.entries(SAME_RESULTS)) {
        assert.match(from, /^[0-9a-f]{16}$/);
        assert.ok(Object.values(RELEASE_FINGERPRINTS).includes(to), `${to} is a released analyzer`);
        assert.equal(resultsIdOf(from), to);
    }
    assert.equal(resultsIdOf("00000000000000aa"), "00000000000000aa");
    assert.ok(Object.isFrozen(SAME_RESULTS));
});

test("the shipped table: a 16-hex fingerprint for every release from 0.9.0 to 0.9.9", () => {
    for (let i = 0; i <= 9; i += 1) assert.match(RELEASE_FINGERPRINTS[`0.9.${i}`] ?? "", /^[0-9a-f]{16}$/, `0.9.${i}`);
    assert.ok(Object.isFrozen(RELEASE_FINGERPRINTS));
});

test("releaseCommits: one commit per released version, oldest first", () => {
    const log = "2a688ae release 0.9.9: any number of patterns\n578c9ac release 0.9.8: Auto\nfff5c2c docs: README\n"
        + "1111111 release 0.9.8: an older commit of the same name\n6f5eb7c Lunacy mania 0.8.0: first public release\r\n";
    assert.deepEqual(releaseCommits(log), [{ version: "0.9.8", commit: "578c9ac" }, { version: "0.9.9", commit: "2a688ae" }]);
});

// ---- the result folders, in a temp userData ----

const FP = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const RELEASES = { "0.9.6": OTHER, "0.9.7": FP, "0.9.8": FP, "0.9.9": FP };
const exists = (p) => stat(p).then(() => true, () => false);

async function userDataWith(layout) {
    const dir = await mkdtemp(path.join(tmpdir(), "results-dir-"));
    for (const [name, files] of Object.entries(layout)) {
        if (typeof files === "string") {
            await writeFile(path.join(dir, name), files);
            continue;
        }
        await mkdir(path.join(dir, name));
        for (const [file, text] of Object.entries(files)) await writeFile(path.join(dir, name, file), text);
    }
    return dir;
}

test("isResultsDir: results-<x.y.z> and results-<16 hex> only", () => {
    for (const name of ["results-0.9.9", "results-0.1.1", "results-10.20.30", `results-${FP}`]) assert.ok(isResultsDir(name), name);
    for (const name of ["results", "results-0.9", "results-0.9.9.bak", "results-beta", "results-0123456789ABCDEF", "results-0123456789abcde", "Cache", "x-results-0.9.9"]) {
        assert.ok(!isResultsDir(name), name);
    }
    assert.equal(resultsDirName(FP), `results-${FP}`);
});

test("an update with the same analyzer: the newest such folder renamed into place, the others' results moved in", async () => {
    const userData = await userDataWith({
        "results-0.9.7": { "a.json": "0.9.7", "old.json": "0.9.7" },
        "results-0.9.8": { "a.json": "0.9.8", "b.json": "0.9.8" },
        "results-0.9.9": { "a.json": "0.9.9", "c.json": "0.9.9" },
        "results-0.9.6": { "x.json": "0.9.6" },
    });
    const lines = [];
    const { dir, done } = await prepareResultsDir({ userData, fingerprint: FP, releases: RELEASES, log: (l) => lines.push(l) });
    assert.equal(dir, path.join(userData, `results-${FP}`));
    assert.ok(!(await exists(path.join(userData, "results-0.9.9"))), "renamed, not copied");
    assert.deepEqual((await readdir(dir)).sort(), ["a.json", "c.json"], "ready before the rest is moved in");
    await done;
    assert.deepEqual((await readdir(dir)).sort(), ["a.json", "b.json", "c.json", "old.json"]);
    assert.equal(await readFile(path.join(dir, "a.json"), "utf8"), "0.9.9", "the newest copy is kept");
    assert.equal(await readFile(path.join(dir, "b.json"), "utf8"), "0.9.8");
    assert.deepEqual((await readdir(userData)).sort(), [`results-${FP}`], "0.9.6 (another analyzer) and the moved-out folders removed");
    assert.ok(lines.some((l) => l.includes(`results-0.9.9 kept as results-${FP}`)), lines.join("\n"));
    assert.ok(lines.some((l) => /1 kept from results-0\.9\.8/.test(l)) && lines.some((l) => /1 kept from results-0\.9\.7/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /removed .*results-0\.9\.6/.test(l)), lines.join("\n"));
    await rm(userData, { recursive: true, force: true });
});

test("only the folder of the same analyzer is renamed; another analyzer's results are not taken", async () => {
    const userData = await userDataWith({ "results-0.9.9": { "a.json": "0.9.9" }, "results-0.9.8": { "b.json": "0.9.8" } });
    const { dir, done } = await prepareResultsDir({ userData, fingerprint: FP, releases: { "0.9.9": FP, "0.9.8": OTHER } });
    await done;
    assert.deepEqual(await readdir(dir), ["a.json"]);
    assert.deepEqual((await readdir(userData)).sort(), [`results-${FP}`]);
    // nothing of today's analyzer: a new, empty folder (made by the cache on its first write), every old one removed
    const fresh = await userDataWith({ "results-0.9.9": { "a.json": "0.9.9" } });
    const next = await prepareResultsDir({ userData: fresh, fingerprint: OTHER, releases: RELEASES });
    await next.done;
    assert.deepEqual(await readdir(fresh), []);
    await rm(userData, { recursive: true, force: true });
    await rm(fresh, { recursive: true, force: true });
});

test("the cleanup removes only the app's old per-version folders, never anything else", async () => {
    const userData = await userDataWith({
        "results-0.1.1": { "a.json": "1" },
        [`results-${OTHER}`]: { "a.json": "2" },
        [`results-${FP}`]: { "mine.json": "3" },
        "results-0.9.9.bak": { "a.json": "4" },
        "results-beta": { "a.json": "5" },
        "results-ABCDEF0123456789": { "a.json": "6" }, // upper case: no name the app writes
        Cache: { "data_0": "7" },
        "results-0.9.5": "a file, not a folder",
        "session-library.json": "{}",
    });
    const lines = [];
    const { dir, done } = await prepareResultsDir({ userData, fingerprint: FP, releases: RELEASES, log: (l) => lines.push(l) });
    await done;
    assert.deepEqual(await readdir(dir), ["mine.json"], "today's folder kept as it is");
    assert.deepEqual((await readdir(userData)).sort(), [
        "Cache", `results-${FP}`, `results-${OTHER}`, "results-0.9.5", "results-0.9.9.bak", "results-ABCDEF0123456789", "results-beta",
        "session-library.json",
    ].sort(), "another analyzer's folder (a dev run sharing userData with the installed app) stays");
    assert.ok(lines.some((l) => l.includes("removed") && l.includes("results-0.1.1") && !l.includes(`results-${OTHER}`)), lines.join("\n"));
    await rm(userData, { recursive: true, force: true });
});

test("tidy: false (a dev run, or a start that could not read its own files) renames, moves and removes nothing", async () => {
    const userData = await userDataWith({ "results-0.9.9": { "a.json": "0.9.9" }, "results-0.9.8": { "b.json": "0.9.8" }, "results-0.1.1": {} });
    for (const fingerprint of ["00000000000000ff", FP]) {
        const { dir, done } = await prepareResultsDir({ userData, fingerprint, releases: RELEASES, tidy: false });
        await done;
        assert.deepEqual((await readdir(userData)).sort(), ["results-0.1.1", "results-0.9.8", "results-0.9.9"], fingerprint);
        assert.ok(!(await exists(dir)));
    }
    await rm(userData, { recursive: true, force: true });
});

test("a folder that will not rename stays for the next start; a removal that fails is logged and the app goes on", async () => {
    const userData = await userDataWith({ "results-0.9.9": { "a.json": "0.9.9" }, "results-0.9.8": { "b.json": "0.9.8" }, "results-0.1.1": {} });
    const lines = [];
    const fs = {
        ...nodeFs,
        rename: async () => { throw new Error("in use"); },
        rm: async (p, o) => (p.endsWith("results-0.1.1") ? Promise.reject(new Error("denied")) : nodeFs.rm(p, o)),
    };
    const { dir, done } = await prepareResultsDir({ userData, fingerprint: FP, releases: RELEASES, fs, log: (l) => lines.push(l) });
    await done;
    assert.equal(dir, path.join(userData, `results-${FP}`));
    assert.deepEqual((await readdir(userData)).sort(), ["results-0.1.1", "results-0.9.8", "results-0.9.9"], "nothing of the same analyzer lost");
    assert.ok(lines.some((l) => l.includes("could not keep results-0.9.9")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("could not remove results-0.1.1")), lines.join("\n"));
    // no userData folder at all (a first start)
    const none = await prepareResultsDir({ userData: path.join(userData, "missing"), fingerprint: FP });
    await none.done;
    assert.equal(none.dir, path.join(userData, "missing", `results-${FP}`));
    await rm(userData, { recursive: true, force: true });
});
