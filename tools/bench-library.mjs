// The Session library's analysis speed, in real Electron utility processes: a synthetic Songs folder of N 4K maps
// (tests/fixtures/makeChart.js, in a temp folder) listed and analysed from an empty result cache, as maps per second,
// with the card's latency (a fresh chart analysed every 500 ms meanwhile, against the same charts with nothing else
// running) and the workers' memory.
// Modes: "line" = the background line, one map at a time (what 0.9.9 does; also the fallback with no pool),
// "pool" = the library's own workers (app/workerPool.js). --root: the checkout whose app/ is measured (another
// worktree for the code before the change, which has no pool: run it with --mode line).
// --no-probe: the library alone (the card's analyses take the line's worker from it in "line" mode).
// --job picks: the Picks plan's "rates" instead: a rate fit (src/recommend/rateFit.js, what rec-ours does once it has
// the .osu) for each of --cards synthetic cards, one card at a time in "line" mode (0.9.9's plan), four in "pool"
// (app/renderer/recPlan.js RATE_LANES).
// Usage: npx electron tools/bench-library.mjs [--mode line|pool] [--maps 200] [--root dir] [--out dir] [--size n]
//        [--default-heap] [--no-probe] [--job library|picks] [--cards 12]
// Touches nothing outside --out (userData included); not part of npm test.
import { app } from "electron";
import { utilityProcess } from "electron";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import path from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
    const k = process.argv.indexOf(`--${name}`);
    return k > 0 ? process.argv[k + 1] : dflt;
};
const root = path.resolve(arg("root", path.join(here, "..")));
const mode = arg("mode", "pool");
const N = Number(arg("maps", 200));
const outDir = path.resolve(arg("out", path.join(os.tmpdir(), "lunacy-bench-library")));
const PROBE_MS = 500;
const IDLE_PROBES = 8;
const PROBE = !process.argv.includes("--no-probe");
const JOB = arg("job", "library");
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };

// N one-chart sets, 90–210 s, 140–230 bpm, streams, jumpstreams and jacks; every .osu its own text
async function makeLibrary(dir) {
    const { makeChart } = await load("tests/fixtures/makeChart.js");
    const { withMeta } = await load("tests/fixtures/songsFolder.js");
    const kinds = ["stream", "jumpstream", "jack"];
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < N; i += 1) {
        const set = path.join(dir, `${900000 + i} Bench - Song ${i}`);
        mkdirSync(set, { recursive: true });
        const text = withMeta(makeChart({ kind: kinds[i % 3], bpm: 140 + ((i * 7) % 91), seconds: 90 + ((i * 13) % 121) }), {
            Title: `Song ${i}`, Artist: "Bench", Version: "Hard", Creator: "TestPlayer",
        });
        writeFileSync(path.join(set, `Bench - Song ${i} (TestPlayer) [Hard].osu`), text, "utf8");
    }
}

// the card's charts: not in the library, a fresh one each time (no cache hit)
async function probeCharts(count) {
    const { makeChart } = await load("tests/fixtures/makeChart.js");
    const { withMeta } = await load("tests/fixtures/songsFolder.js");
    return Array.from({ length: count }, (_, i) => withMeta(makeChart({ kind: "jumpstream", bpm: 180 + (i % 20), seconds: 150 }), { Title: `Probe ${i}` }));
}

// the analysis workers (the card's is "Node Utility Process", the pool's has its service name; not Chromium's own
// utility processes such as the network service): how many, their memory, their priorities (0 normal, 10 below)
const WORKER_NAMES = new Set(["Node Utility Process", "Lunacy mania library analysis", "Lunacy mania background analysis"]);
function workerMetrics() {
    const utility = app.getAppMetrics().filter((m) => m.type === "Utility" && WORKER_NAMES.has(m.name));
    return {
        count: utility.length,
        mb: Math.round(utility.reduce((s, m) => s + (m.memory?.workingSetSize ?? 0), 0) / 1024),
        each: utility.map((m) => ({ name: m.name, mb: Math.round((m.memory?.workingSetSize ?? 0) / 1024), priority: (() => { try { return os.getPriority(m.pid); } catch { return null; } })() })),
    };
}

async function main() {
    await app.whenReady();
    const songs = path.join(outDir, `songs-${N}`);
    if (!existsSync(songs)) await makeLibrary(songs);
    const runDir = path.join(outDir, `run-${mode}-${Date.now()}`);
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir, { recursive: true });

    const { createWorkerClient } = await load("app/workerClient.js");
    const { createAnalysisService } = await load("app/analysisService.js");
    const { createCache } = await load("src/core/cache.js");
    const { createSessionLibrary } = await load("app/sessionLibrary.js");
    const workerFile = path.join(root, "app", "analysisWorker.js");
    const worker = createWorkerClient({ spawn: () => utilityProcess.fork(workerFile) });
    let pool = null;
    if (mode === "pool") {
        const { createWorkerPool, belowNormal, poolSize, POOL_WORKER_OPTIONS } = await load("app/workerPool.js");
        // --default-heap: the pool's workers without the smaller young generation (to compare)
        const options = process.argv.includes("--default-heap") ? { serviceName: POOL_WORKER_OPTIONS.serviceName } : POOL_WORKER_OPTIONS;
        pool = createWorkerPool({
            size: Number(arg("size", poolSize())), idleMs: 5000,
            spawn: () => belowNormal(utilityProcess.fork(path.join(root, "app", existsSync(path.join(root, "app", "analysisPoolWorker.js")) ? "analysisPoolWorker.js" : "analysisWorker.js"), [], options)),
        });
    }
    const analysis = createAnalysisService({ worker, pool, cache: createCache({ dir: path.join(runDir, "results") }) });
    const analyze = mode === "pool" ? analysis.bulk : (text, rate) => analysis.analyzeQueued(text, rate);
    if (JOB === "picks") return benchPicks({ analysis, pool, worker });

    // the card at rest: its worker warmed up, then one fresh chart at a time
    const probes = await probeCharts(IDLE_PROBES + 400);
    let p = 0;
    const timeCard = async () => {
        const t0 = performance.now();
        const r = await analysis.analyze(probes[p++], 1);
        if (r.kind !== "ok") throw new Error(`probe: ${r.kind} ${r.message ?? ""}`);
        return performance.now() - t0;
    };
    await timeCard();
    const idle = [];
    for (let i = 0; i < IDLE_PROBES; i += 1) idle.push(await timeCard());

    const lib = createSessionLibrary({ songsDir: async () => songs, analyze, file: path.join(runDir, "session-library.json"), analyzer: "bench" });
    let peak = { count: 0, mb: 0, each: [] };
    const sampler = setInterval(() => { const m = workerMetrics(); if (m.mb > peak.mb) peak = m; }, 250);
    const busy = [];
    let done = false;
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const prober = (async () => {
        while (!done && PROBE) {
            await new Promise((r) => setTimeout(r, PROBE_MS));
            if (!done) busy.push(await timeCard());
        }
    })();
    const t0 = performance.now();
    await lib.scan();
    const totalMs = performance.now() - t0;
    done = true;
    await prober;
    loop.disable();
    clearInterval(sampler);
    const st = await lib.status();
    const analyseMs = totalMs - st.lastScan.ms;
    const analysed = st.counts.total - st.counts.pending;
    const afterRun = workerMetrics();
    await new Promise((r) => setTimeout(r, 6500));
    const afterIdle = { ...workerMetrics(), pool: pool?.stats() ?? null };

    const result = {
        mode, root, maps: N, cores: os.availableParallelism(), poolSize: pool?.size ?? 0,
        counts: st.counts, phase: st.phase, listMs: st.lastScan.ms, analyseMs: Math.round(analyseMs),
        mapsPerSec: Math.round((analysed / (analyseMs / 1000)) * 100) / 100,
        card: {
            idle: { n: idle.length, medianMs: Math.round(median(idle)), p95Ms: Math.round(pct(idle, 0.95)) },
            duringLibrary: busy.length ? { n: busy.length, medianMs: Math.round(median(busy)), p95Ms: Math.round(pct(busy, 0.95)), maxMs: Math.round(Math.max(...busy)) } : null,
        },
        // main's event loop while the library ran (what the window's requests wait behind)
        mainLoopMs: { mean: Math.round(loop.mean / 1e5) / 10, p99: Math.round(loop.percentile(99) / 1e5) / 10, max: Math.round(loop.max / 1e5) / 10 },
        workers: { peak, afterRun, afterIdle },
        stats: analysis.stats(),
    };
    writeFileSync(path.join(outDir, `result-${mode}-${path.basename(root)}-${PROBE ? "probe" : "alone"}-${Date.now()}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    pool?.dispose();
    worker.dispose();
    app.exit(0);
}

// The plan's "rates": every card's rate fit towards a centre one dan above its tracker dan (a search over 1.0–1.6x).
async function benchPicks({ analysis, pool, worker }) {
    const { suggestRate } = await load("src/recommend/rateFit.js");
    const { makeChart } = await load("tests/fixtures/makeChart.js");
    const { withMeta } = await load("tests/fixtures/songsFolder.js");
    const kinds = ["stream", "jumpstream", "jack"];
    const cards = Array.from({ length: Number(arg("cards", 12)) }, (_, i) => withMeta(
        makeChart({ kind: kinds[i % 3], bpm: 150 + ((i * 11) % 60), seconds: 100 + ((i * 17) % 80) }), { Title: `Card ${i}`, Creator: "TestPlayer" }));
    const lanes = mode === "pool" ? 4 : 1;
    const each = [];
    let next = 0;
    let failed = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: lanes }, async () => {
        while (next < cards.length) {
            const k = next++;
            const c0 = performance.now();
            const r = await suggestRate({ analyze: (text, rate) => analysis.analyzeQueued(text, rate), osuText: cards[k], trackerDan: 12, center: 13 });
            if (!r.ok) failed += 1;
            each.push(performance.now() - c0);
        }
    }));
    const ms = performance.now() - t0;
    const stats = analysis.stats();
    const result = {
        job: "picks", mode, root, cards: cards.length, lanes, poolSize: pool?.size ?? 0, failed, ms: Math.round(ms),
        cardsPerSec: Math.round((cards.length / (ms / 1000)) * 100) / 100,
        analyses: stats.misses, analysesPerSec: Math.round((stats.misses / (ms / 1000)) * 100) / 100,
        perCard: { medianMs: Math.round(median(each)), maxMs: Math.round(Math.max(...each)) },
    };
    writeFileSync(path.join(outDir, `result-picks-${mode}-${path.basename(root)}-${Date.now()}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    pool?.dispose();
    worker.dispose();
    app.exit(0);
}

main().catch((error) => {
    console.error(error);
    app.exit(1);
});
