// Builds the browser extension "Lunacy mania: dans for osu!" (extension/DESIGN.md §3) into unpacked folders:
//   node tools/build-extension.mjs [--target chrome|firefox|all] [--out <dir>] [--allow-missing]
// → <out>/chrome and <out>/firefox (default out: extension/build). No bundler: the extension's own folders are copied
// as they are, and the app's analyzer (the import graph of src/core/analyze.js and src/core/labels.js, with the files
// it reads at run time) is copied unchanged into lib/, keeping its relative paths. Exactly one line of the COPY of
// src/core/model.js changes: its node:fs import points at analysis/readFileShim.js. The build fails when that line is
// not there exactly once, when any static node: or bare import is left, or when a relative import names a file that
// is not in the build.
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_FILES, analyzerFingerprint, importGraph, readFrom } from "../src/core/analyzerVersion.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = Object.freeze(["chrome", "firefox"]);
export const GRAPH_ROOTS = Object.freeze(["src/core/analyze.js", "src/core/labels.js"]);
export const MODEL_FILE = "src/core/model.js";
export const MODEL_IMPORT = 'import { readFile } from "node:fs/promises";';
export const MODEL_SHIM = 'import { readFile } from "../../../analysis/readFileShim.js";';
// the browser entry of ONNX Runtime Web: a computed import() in companellaEstimator.js, so not in DATA_FILES
export const ORT_BROWSER = "vendor/leoblack/js/estimator/companella/ort/ort.wasm.min.mjs";
export const LIB_DATA_FILES = Object.freeze([...DATA_FILES.filter((f) => !f.endsWith("/ort.node.min.mjs")), ORT_BROWSER]);

// extension/<dir> copied into every target; offscreen/ only for Chrome/Edge
const COMMON_DIRS = ["background", "analysis", "shared", "content", "player", "_locales"];
const TARGET_DIRS = { chrome: ["offscreen"], firefox: [] };
// each background entry belongs to one target
const ONLY_IN = { "background/sw.js": "chrome", "background/firefox.js": "firefox" };
const MARKER = ".lm-build";
const CODE = /\.(?:m?js)$/i;

// Specifiers of static imports/exports ("import x from 'y'", "import 'y'", "export * from 'y'") and of import() with
// a plain string literal. A static one starts a line or follows ; or } (as in minified code), so a word "import" at
// the end of a comment line is not taken for one.
const STATIC = /(?:^|[;}])[ \t]*(?:import|export)\b\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(["'])([^"'\n]+)\1/gm;
const DYNAMIC = /(?:^|[^\w$.])import\s*\(\s*(["'`])([^"'`$\n]+)\1\s*\)/g;
export const staticSpecifiers = (source) => [...source.matchAll(STATIC)].map((m) => m[2]);
export const literalDynamicSpecifiers = (source) => [...source.matchAll(DYNAMIC)].map((m) => m[2]);
const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");

async function exists(p) {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
}

async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (entry.isFile()) out.push(full);
    }
    return out;
}

const posix = (p) => p.split(path.sep).join("/");

// Removes a previous build of this tool (it carries MARKER) or refuses: never deletes a folder it did not make.
async function cleanTarget(dir) {
    if (!(await exists(dir))) return;
    const names = await readdir(dir);
    if (names.length && !names.includes(MARKER)) throw new Error(`refusing to replace ${path.basename(dir)}: not a build folder of this tool`);
    await rm(dir, { recursive: true, force: true });
}

async function writeFileIn(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
}

async function copyIn(from, to) {
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
}

// The analyzer for lib/: { files: Map(rel → Buffer), fingerprint, appVersion, vendor } (built once for all targets).
async function analyzerFiles(root) {
    const read = readFrom(root);
    const { texts, missing } = await importGraph(read, [...GRAPH_ROOTS]);
    if (missing.length) throw new Error(`the analyzer's import graph names missing files: ${missing.join(", ")}`);
    const files = new Map();
    for (const rel of texts.keys()) {
        const bytes = await read(rel);
        if (rel !== MODEL_FILE) {
            files.set(rel, bytes);
            continue;
        }
        const text = bytes.toString("utf8");
        const found = text.split(MODEL_IMPORT).length - 1;
        if (found !== 1) throw new Error(`${MODEL_FILE}: expected the line «${MODEL_IMPORT}» exactly once, found ${found}`);
        files.set(rel, Buffer.from(text.replace(MODEL_IMPORT, MODEL_SHIM), "utf8"));
    }
    if (!files.has(MODEL_FILE)) throw new Error(`${MODEL_FILE} is not in the analyzer's import graph`);
    for (const rel of LIB_DATA_FILES) {
        const bytes = await read(rel);
        if (!bytes) throw new Error(`analyzer data file missing: ${rel}`);
        files.set(rel, bytes);
    }
    const { fingerprint } = await analyzerFingerprint({ read });
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const vendor = String((await read("vendor/leoblack/VERSION")) ?? "").trim().slice(0, 8) || null;
    return { files, fingerprint, appVersion: String(pkg.version), vendor };
}

// Every problem with the modules of a built folder: static node:/bare imports, relative imports of missing files.
export async function checkModules(dir) {
    const problems = [];
    for (const file of (await walk(dir)).filter((f) => CODE.test(f))) {
        const rel = posix(path.relative(dir, file));
        const source = await readFile(file, "utf8");
        for (const spec of staticSpecifiers(source)) {
            if (spec.startsWith("node:")) problems.push(`${rel}: static import of ${spec}`);
            else if (!isRelative(spec)) problems.push(`${rel}: bare import of ${spec}`);
        }
        for (const spec of [...staticSpecifiers(source), ...literalDynamicSpecifiers(source)].filter(isRelative)) {
            const target = path.resolve(path.dirname(file), spec.split(/[?#]/)[0]);
            if (!target.startsWith(dir + path.sep) || !(await exists(target))) problems.push(`${rel}: imports ${spec}, which is not in the build`);
        }
    }
    return problems;
}

// The files a manifest names that the folder does not have.
async function missingFromManifest(dir, manifest) {
    const named = [
        manifest.background?.service_worker,
        ...(manifest.background?.scripts ?? []),
        ...(manifest.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
        ...Object.values(manifest.icons ?? {}),
    ].filter(Boolean);
    const out = [];
    for (const rel of new Set(named)) if (!(await exists(path.join(dir, rel)))) out.push(rel);
    return out;
}

// → { targets: { name: dir }, files, bytes, fingerprint, appVersion, warnings: [manifest-named files not there] }
export async function buildExtension({ root = ROOT, out = path.join(root, "extension", "build"), targets = TARGETS } = {}) {
    const unknown = targets.filter((t) => !TARGETS.includes(t));
    if (unknown.length || !targets.length) throw new Error(`unknown target ${unknown.join(", ") || "(none)"}`);
    const ext = path.join(root, "extension");
    const lib = await analyzerFiles(root);
    const generated = `// Written by tools/build-extension.mjs: the app's analyzer fingerprint (src/core/analyzerVersion.js) and version.\n`
        + `export const ANALYZER = Object.freeze(${JSON.stringify({ fingerprint: lib.fingerprint, appVersion: lib.appVersion, vendor: lib.vendor })});\n`;
    const result = { targets: {}, files: 0, bytes: 0, fingerprint: lib.fingerprint, appVersion: lib.appVersion, warnings: [] };

    for (const target of targets) {
        const dir = path.resolve(out, target);
        await cleanTarget(dir);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, MARKER), "built by tools/build-extension.mjs\n");

        for (const name of [...COMMON_DIRS, ...TARGET_DIRS[target]]) {
            const from = path.join(ext, name);
            if (!(await exists(from))) continue;
            for (const file of await walk(from)) {
                const rel = posix(path.relative(ext, file));
                if (ONLY_IN[rel] && ONLY_IN[rel] !== target) continue;
                if (/(^|\/)\./.test(rel) || /\.md$/i.test(rel)) continue;
                await copyIn(file, path.join(dir, rel));
            }
        }
        for (const [rel, bytes] of lib.files) await writeFileIn(path.join(dir, "lib", rel), bytes);
        await writeFileIn(path.join(dir, "lib", "analyzerVersion.generated.js"), generated);
        await copyIn(path.join(root, "vendor", "leoblack", "LICENSE"), path.join(dir, "lib", "vendor", "leoblack", "LICENSE"));
        await copyIn(path.join(root, "LICENSE"), path.join(dir, "LICENSE"));
        await copyIn(path.join(ext, "THIRD_PARTY_NOTICES.md"), path.join(dir, "THIRD_PARTY_NOTICES.md"));
        await copyIn(path.join(root, "app", "assets", "icon.png"), path.join(dir, "icons", "icon.png"));

        const manifest = JSON.parse(await readFile(path.join(ext, `manifest.${target}.json`), "utf8"));
        await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

        const problems = await checkModules(dir);
        if (problems.length) throw new Error(`build ${target}: ${problems.length} module problem(s):\n  ${problems.join("\n  ")}`);
        for (const rel of await missingFromManifest(dir, manifest)) result.warnings.push(`${target}: manifest names ${rel}, which is not there`);

        const files = (await walk(dir)).filter((f) => path.basename(f) !== MARKER);
        result.files += files.length;
        for (const f of files) result.bytes += (await stat(f)).size;
        result.targets[target] = dir;
    }
    return result;
}

function parseArgs(argv) {
    const args = { targets: [...TARGETS], out: undefined, allowMissing: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--target") {
            const v = argv[++i];
            args.targets = v === "all" ? [...TARGETS] : [v];
        } else if (a === "--out") args.out = path.resolve(argv[++i]);
        else if (a === "--allow-missing") args.allowMissing = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const built = await buildExtension({ targets: args.targets, ...(args.out ? { out: args.out } : {}) });
        for (const [name, dir] of Object.entries(built.targets)) console.log(`${name}: ${path.relative(process.cwd(), dir) || dir}`);
        console.log(`${built.files} files, ${(built.bytes / 1024 / 1024).toFixed(1)} MB, analyzer ${built.fingerprint} (app ${built.appVersion})`);
        for (const w of built.warnings) console.warn(`warning: ${w}`);
        if (built.warnings.length && !args.allowMissing) process.exitCode = 1;
    } catch (error) {
        console.error(String(error?.message ?? error));
        process.exitCode = 1;
    }
}
