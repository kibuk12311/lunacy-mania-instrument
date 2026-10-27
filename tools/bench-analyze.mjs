// Time of one chart analysis (src/core/analyze.js analyzeChart) and an exact-equality check of its results: every
// field of analyzeChart's result and of computeFeatures' (unrounded estimators, MSD, the model's feature vector, the
// pattern report), number for number (-0, NaN and ±Infinity count), key order included.
// Corpus: synthetic charts (tests/fixtures/makeChart.js, seeded tests/fixtures/randomChart.js), every .osu the tests
// ship, and any folder given with --dir (your own maps stay on disk: nothing is copied into the repo).
// Each checkout's analyser runs in a child process of its own, one analysis at a time, so the times are single-thread
// times (and two checkouts never share a process: ONNX Runtime keeps global state, and a second copy of it in the
// same process breaks Companella).
// Usage: node tools/bench-analyze.mjs [--base CHECKOUT] [--record FILE] [--check FILE] [--dir FOLDER …] [--limit 60]
//        [--reps 3] [--rates 1,1.25] [--no-time] [--only synthetic|fixtures|dir]
//   --base DIR     another checkout of this repo (e.g. a git worktree of the commit before a change): every case's
//                  results must be identical to its own, and the two take turns in the timing; exits 1 on a difference.
//   --record FILE  writes the results (exact numbers) to FILE: run it on the code before a change …
//   --check FILE   … and this one after it; exits 1 on the first difference, with its path.
//   --limit N      takes N 4K rice maps from the --dir folders (spread evenly over the sorted list).
import { fork } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chartInfo } from "../src/core/features.js";
import { isRice } from "../src/core/rice.js";
import { makeChart } from "../tests/fixtures/makeChart.js";
import { randomChart } from "../tests/fixtures/randomChart.js";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");

function parseArgs(argv) {
    const o = { dirs: [], limit: 60, reps: 3, rates: [1, 1.25], time: true, only: null };
    for (let i = 0; i < argv.length; i += 1) {
        const k = argv[i].replace(/^--/, "");
        if (k === "no-time") {
            o.time = false;
            continue;
        }
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`missing value for --${k}`);
        i += 1;
        if (k === "dir") o.dirs.push(v);
        else if (k === "limit") o.limit = Number(v);
        else if (k === "reps") o.reps = Number(v);
        else if (k === "rates") o.rates = v.split(",").map(Number);
        else if (["base", "record", "check", "only", "serve"].includes(k)) o[k] = v;
        else throw new Error(`unknown option --${k}`);
    }
    return o;
}

async function listOsu(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await listOsu(full)));
        else if (entry.name.toLowerCase().endsWith(".osu")) out.push(full);
    }
    return out.sort();
}

function syntheticCases() {
    const cases = [];
    for (const kind of ["stream", "jack", "jumpstream"]) {
        for (const bpm of [120, 170, 220, 280]) {
            for (const seconds of [40, 150]) cases.push({ id: `make:${kind}-${bpm}-${seconds}`, text: makeChart({ kind, bpm, seconds }) });
        }
    }
    cases.push({ id: "make:ln-0.1", text: makeChart({ kind: "ln", bpm: 180, seconds: 90, lnShare: 0.1 }) });
    cases.push({ id: "make:ln-0.6", text: makeChart({ kind: "ln", bpm: 180, seconds: 90, lnShare: 0.6 }) });
    cases.push({ id: "make:7k", text: makeChart({ kind: "stream", keys: 7, seconds: 60 }) });
    cases.push({ id: "make:short", text: makeChart({ kind: "stream", seconds: 2 }) });
    cases.push({ id: "make:std", text: makeChart({ kind: "stream", seconds: 60 }).replace("Mode: 3", "Mode: 0") });
    cases.push({ id: "make:long", text: makeChart({ kind: "jumpstream", bpm: 190, seconds: 420 }) });
    for (let seed = 1; seed <= 40; seed += 1) {
        cases.push({ id: `random:${seed}`, text: randomChart(seed, { seconds: 30 + ((seed * 37) % 200) }) });
    }
    return cases;
}

async function fixtureCases() {
    const files = await listOsu(path.join(ROOT, "tests"));
    return Promise.all(files.map(async (f) => ({ id: `fixture:${path.relative(ROOT, f).replaceAll("\\", "/")}`, text: await readFile(f, "utf8") })));
}

async function dirCases(dirs, limit) {
    const rice = [];
    for (const dir of dirs) {
        for (const file of await listOsu(dir)) {
            const text = await readFile(file, "utf8").catch(() => null);
            if (text === null) continue;
            let info;
            try {
                info = chartInfo(text, 1);
            } catch {
                continue; // e.g. a chart too long for chartInfo's Math.min(...times)
            }
            if (info.mode === 3 && isRice(info) && info.noteCount >= 80) rice.push({ id: `dir:${path.relative(dir, file).replaceAll("\\", "/")}`, text });
        }
    }
    if (rice.length <= limit) return rice;
    return Array.from({ length: limit }, (_, i) => rice[Math.floor((i * rice.length) / limit)]);
}

// Exact JSON: numbers that JSON loses (-0, NaN, ±Infinity), undefined and typed arrays become tagged objects, so two
// results are identical exactly when their encodings are the same string.
function encode(value) {
    return JSON.stringify(value, function replacer(key, v) {
        if (v === undefined) return { $undef: 1 };
        if (typeof v === "number" && (!Number.isFinite(v) || Object.is(v, -0))) return { $num: Object.is(v, -0) ? "-0" : String(v) };
        if (ArrayBuffer.isView(v)) return { $typed: v.constructor.name, values: Array.from(v) };
        return v;
    });
}

function decode(text) {
    return JSON.parse(text, (key, v) => {
        if (v && typeof v === "object" && !Array.isArray(v) && "$num" in v) return v.$num === "-0" ? -0 : Number(v.$num);
        return v;
    });
}

// The first path where a and b (both decoded) differ, or null.
function firstDifference(a, b, at = "") {
    if (typeof a !== typeof b) return `${at}: ${typeof a} vs ${typeof b}`;
    if (a === null || b === null || typeof a !== "object") return Object.is(a, b) ? null : `${at}: ${String(a)} vs ${String(b)}`;
    if (Array.isArray(a) !== Array.isArray(b)) return `${at}: array vs object`;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join("\u0000") !== kb.join("\u0000")) return `${at}: keys [${ka}] vs [${kb}]`;
    for (const k of ka) {
        const d = firstDifference(a[k], b[k], `${at}.${k}`);
        if (d) return d;
    }
    return null;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];

// Child: analyses for the parent with the checkout at `dir`, one message at a time.
async function serve(dir) {
    const at = (file) => pathToFileURL(path.join(path.resolve(dir), file)).href;
    const { analyzeChart } = await import(at("src/core/analyze.js"));
    const { computeFeatures } = await import(at("src/core/features.js"));
    process.on("message", async ({ id, text, rate, full }) => {
        const t0 = performance.now();
        const result = await analyzeChart(text, rate);
        const ms = performance.now() - t0;
        let encoded = null;
        if (full) {
            const { est, msd, interlude, vector, patternReport } = await computeFeatures(text, rate);
            encoded = encode({ result, features: { est, msd, interlude, vector, patternReport } });
        }
        process.send({ id, ms, encoded });
    });
    process.send({ ready: true });
}

function runner(dir) {
    const child = fork(SELF, ["--serve", dir], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const waiting = new Map();
    let next = 0;
    const ready = new Promise((resolve) => {
        child.on("message", (m) => {
            if (m.ready) {
                resolve();
                return;
            }
            waiting.get(m.id)(m);
            waiting.delete(m.id);
        });
    });
    return {
        run: async (c, full = false) => {
            await ready;
            next += 1;
            const id = next;
            return new Promise((resolve) => {
                waiting.set(id, resolve);
                child.send({ id, text: c.text, rate: c.rate, full });
            });
        },
        close: () => child.disconnect(),
    };
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.serve) {
        await serve(o.serve);
        return;
    }
    const groups = {
        synthetic: () => syntheticCases(),
        fixtures: () => fixtureCases(),
        dir: () => dirCases(o.dirs, o.limit),
    };
    const cases = [];
    for (const [name, load] of Object.entries(groups)) {
        if (o.only && o.only !== name) continue;
        for (const c of await load()) for (const rate of o.rates) cases.push({ ...c, rate, key: `${c.id}@${rate}` });
    }
    console.log(`${cases.length} cases (${o.rates.join(", ")}x)`);

    const current = runner(ROOT);
    const base = o.base ? runner(o.base) : null;

    // Results first: analyzeChart's result plus computeFeatures' fields it is made of.
    const results = {};
    let failed = false;
    let sameAsBase = 0;
    for (const c of cases) {
        const { encoded } = await current.run(c, true);
        results[c.key] = decode(encoded);
        if (base) {
            const theirs = (await base.run(c, true)).encoded;
            if (theirs === encoded) sameAsBase += 1;
            else {
                console.log(`DIFFERENT from ${o.base}: ${firstDifference(decode(theirs), results[c.key], c.key)}`);
                failed = true;
            }
        }
    }
    if (base) console.log(`identical: ${sameAsBase} of ${cases.length} cases give exactly the results of ${o.base}`);
    const kinds = {};
    for (const r of Object.values(results)) kinds[r.result.kind] = (kinds[r.result.kind] ?? 0) + 1;
    console.log(`results: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")}`);

    if (o.record) {
        await writeFile(o.record, encode(results));
        console.log(`recorded ${Object.keys(results).length} results to ${o.record}`);
    }
    if (o.check) {
        const golden = decode(await readFile(o.check, "utf8"));
        let compared = 0;
        let differ = 0;
        for (const [key, value] of Object.entries(results)) {
            if (!(key in golden)) {
                console.log(`not in ${o.check}: ${key}`);
                continue;
            }
            compared += 1;
            const d = firstDifference(golden[key], value, key);
            if (d) {
                console.log(`DIFFERENT from ${o.check}: ${d}`);
                differ += 1;
            }
        }
        if (differ) failed = true;
        else console.log(`identical: ${compared} of ${Object.keys(results).length} cases match ${o.check} exactly`);
    }

    if (o.time) {
        // With --base the two take turns on every case (and swap who goes first), so load on the machine hits both.
        const variants = base ? [["base", base], ["current", current]] : [["current", current]];
        const timed = cases.filter((c) => results[c.key].result.kind === "ok");
        const perCase = Object.fromEntries(variants.map(([name]) => [name, []]));
        for (const c of timed) {
            const runs = Object.fromEntries(variants.map(([name]) => [name, []]));
            for (let r = 0; r < o.reps; r += 1) {
                for (const [name, code] of r % 2 ? [...variants].reverse() : variants) runs[name].push((await code.run(c)).ms);
            }
            for (const [name] of variants) perCase[name].push(runs[name].sort((a, b) => a - b)[Math.floor(o.reps / 2)]);
        }
        const stats = {};
        for (const [name] of variants) {
            const sorted = [...perCase[name]].sort((a, b) => a - b);
            const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
            stats[name] = { mean, median: pct(sorted, 0.5), p90: pct(sorted, 0.9), max: sorted[sorted.length - 1] };
            console.log(`${name}: analyzeChart over ${timed.length} ok cases (median of ${o.reps} runs each): `
                + `mean ${mean.toFixed(1)} ms, median ${stats[name].median?.toFixed(1)} ms, p90 ${stats[name].p90?.toFixed(1)} ms, `
                + `max ${stats[name].max?.toFixed(1)} ms`);
        }
        if (base) {
            const x = (k) => (stats.base[k] / stats.current[k]).toFixed(2);
            console.log(`speed-up: mean ×${x("mean")}, median ×${x("median")}, p90 ×${x("p90")}`);
        }
    }
    current.close();
    base?.close();
    if (failed) process.exitCode = 1;
}

await main();
