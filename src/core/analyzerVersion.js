// The analyzer fingerprint: a short hash of exactly what decides the answers kept in the shared result cache
// (app/main.js results-<fingerprint>, app/resultsFolder.js) and in the session library (app/sessionLibrary.js
// "analyzer"), so an app update that leaves the analysis alone keeps every saved result. Hashed, sorted by path from the
// app root with CRLF read as LF: the modules reachable by relative imports from the cached kinds' modules (ROOTS), the
// files they load at run time (DATA_FILES) and FORMAT. src/i18n is reachable (the dan's ends and the confidence word are
// worded into a result) but not hashed as code: only the messages the analysis names with t("…") are, so a UI text
// changes nothing here. Works the same in the packaged app (node:fs reads inside app.asar) and over a release's files
// in git (tools/analyzer-fingerprints.mjs, src/core/analyzerReleases.js).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// bumped by hand when what the cache holds changes shape although no file below changed
export const FORMAT = 1;
// the modules of every kind of result in the shared cache: the card's analyzeChart (src/core/analyze.js), the
// details under the card (the worker's "details" job), the dan by part (its "sections" job)
export const ROOTS = Object.freeze(["src/core/analyze.js", "src/analysis/timeline.js", "src/analysis/sections.js"]);
// read at run time, not imported: the dan model (src/core/model.js), MinaCalc's wasm (vendor ett/calc.js), Companella's
// model with the ONNX runtime it runs on under Node (vendor estimator/companellaEstimator.js)
export const DATA_FILES = Object.freeze([
    "models/dan_model.json",
    ...["68.0-unofficial", "70.0", "72.0", "72.3", "74.0", "75.0"]
        .map((v) => `vendor/leoblack/js/ett/versions/minaclac-${v}.wasm`),
    "vendor/leoblack/js/estimator/companella/dan_model.onnx",
    "vendor/leoblack/js/estimator/companella/ort/ort.node.min.mjs",
    "vendor/leoblack/js/estimator/companella/ort/ort-wasm-simd-threaded.mjs",
    "vendor/leoblack/js/estimator/companella/ort/ort-wasm-simd-threaded.wasm",
]);
const TEXTS = "src/i18n/";
const TEXT_EXT = /\.(?:[cm]?js|json)$/i;
export const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sha = (data) => createHash("sha256").update(data).digest("hex");
const asText = (bytes) => bytes.toString("utf8").replace(/\r\n/g, "\n");
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // not localeCompare: the same order everywhere

// read(path from the app root) → Buffer, or null when there is no such file
export const readFrom = (root) => (rel) => readFile(path.join(root, rel)).catch(() => null);

// Relative module specifiers of a source: import … from "./x", import "./x", export … from "./x", import("./x") (a
// computed import() is not followed: what it loads is in DATA_FILES).
const STATIC = String.raw`\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(["'])(\.{1,2}\/[^"'\n]+)\1`;
const DYNAMIC = String.raw`\bimport\s*\(\s*(["'\x60])(\.{1,2}\/[^"'\x60$\n]+)\3\s*\)`;
const IMPORT = new RegExp(`${STATIC}|${DYNAMIC}`, "g");
export function relativeImports(source) {
    return [...source.matchAll(IMPORT)].map((m) => m[2] ?? m[4]);
}

const resolve = (from, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));

// Every module reachable from roots by relative imports → { texts: path → source with LF, missing: the files named
// that are not there, sorted }.
export async function importGraph(read, roots = ROOTS) {
    const texts = new Map();
    const missing = new Set();
    const queue = [...roots];
    while (queue.length) {
        const rel = queue.shift();
        if (texts.has(rel) || missing.has(rel)) continue;
        const bytes = await read(rel);
        if (!bytes) {
            missing.add(rel);
            continue;
        }
        const text = asText(bytes);
        texts.set(rel, text);
        for (const spec of relativeImports(text)) queue.push(resolve(rel, spec));
    }
    return { texts, missing: [...missing].sort(byPath) };
}

// The message keys a source names literally: t("core.label.belowFirst").
export const messageKeys = (source) => [...source.matchAll(/\bt\(\s*(["'])([\w.-]+)\1/g)].map((m) => m[2]);

// From i to past the string, template or comment that starts there.
function skipLiteral(src, i) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
        const end = src.indexOf(src[i + 1] === "/" ? "\n" : "*/", i + 2);
        return end < 0 ? src.length : end + (src[i + 1] === "/" ? 0 : 2);
    }
    for (let j = i + 1; j < src.length; j += 1) {
        if (src[j] === "\\") j += 1;
        else if (src[j] === c) return j + 1;
        else if (c === "`" && src[j] === "$" && src[j + 1] === "{") j = valueEnd(src, j + 2);
    }
    return src.length;
}

// The end of the value that starts at i: the first , } or ) outside brackets, strings and comments.
function valueEnd(src, i) {
    let depth = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'" || c === "`" || (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*"))) {
            i = skipLiteral(src, i);
            continue;
        }
        if (c === "(" || c === "[" || c === "{") depth += 1;
        else if (c === ")" || c === "]" || c === "}") {
            if (depth === 0) return i;
            depth -= 1;
        } else if (c === "," && depth === 0) return i;
        i += 1;
    }
    return i;
}

// The source of a message's value in a messages file ({ ru: "…", en: "…" }), or null when the file has no such key.
export function messageSource(source, key) {
    const at = new RegExp(`(["'])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1\\s*:`).exec(source);
    if (!at) return null;
    const start = at.index + at[0].length;
    return source.slice(start, valueEnd(source, start)).trim();
}

// → { fingerprint (16 hex), code, texts, data, missing }: what went in, for the log and the tests. read defaults to
// the app's own files.
export async function analyzerFingerprint({
    read = readFrom(APP_ROOT), roots = ROOTS, dataFiles = DATA_FILES, format = FORMAT,
} = {}) {
    const { texts, missing } = await importGraph(read, roots);
    const all = [...texts.keys()].sort(byPath);
    const code = all.filter((rel) => !rel.startsWith(TEXTS));
    const messages = all.filter((rel) => rel.startsWith(TEXTS));
    const keys = [...new Set(code.flatMap((rel) => messageKeys(texts.get(rel))))].sort(byPath);
    const lines = [`format ${format}`];
    for (const rel of code) lines.push(`code ${rel} ${sha(texts.get(rel))}`);
    for (const rel of missing) lines.push(`code ${rel} missing`);
    for (const key of keys) {
        const found = messages.map((rel) => messageSource(texts.get(rel), key)).filter((s) => s !== null);
        lines.push(`text ${key} ${found.length ? sha(found.join("\n")) : "missing"}`);
    }
    const data = [...dataFiles].sort(byPath);
    for (const rel of data) {
        const bytes = await read(rel);
        lines.push(`data ${rel} ${bytes ? sha(TEXT_EXT.test(rel) ? asText(bytes) : bytes) : "missing"}`);
        if (!bytes) missing.push(rel);
    }
    return { fingerprint: sha(lines.join("\n")).slice(0, 16), code, texts: keys, data, missing };
}
