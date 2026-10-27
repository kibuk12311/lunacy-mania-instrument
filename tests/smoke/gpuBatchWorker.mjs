// Utility-process half of tools/bench-gpu-batch.mjs (stream W, D3/D4): the generator worker's GPU link exactly as
// app/analysisWorker.js wires it (app/gpuWorkerLink.js), then, with the shipped models and synthetic songs (stems
// included; tests/fixtures), on request:
//   { kind: "parity", size, song, builds }  the GPU batch's logits against the CPU decoder over the same rows, the rows
//                                           of the same seeds on the GPU batch and on the CPU, and a whole variant
//                                           (generateLearnedMap) on the CPU and through the batches: equal or not
//   { kind: "time", size, song, mode, candidates, deadlineMs }   one variant, timed (debug.timing): mode "cpu" (no GPU),
//                                           "d1" (GPU encoder, CPU builds: 0.10.2's path), "batch" (D3/D4), "old-d1"
//                                           (0.10.2's own code from --old <dir>, total time only)
//   { kind: "rtt", size }                   decode rounds alone: the round trip per round for 1 … 12 items
// Nothing here reads the user's files: songs come from tests/fixtures, models from the app's models/.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGpuWorkerLink } from "../../app/gpuWorkerLink.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { createGpuInfillSource } from "../../src/gen/nn/webgpu/gpuSource.js";
import { createLaneHead } from "../../src/gen/nn/webgpu/infillGpu.js";
import { infillSource, loadInfill, encodeBeats, createDecoder, createHistory, N_LANES, DIV_CLASSES } from "../../src/gen/nn/infillModel.js";
import { STEP_WAIT } from "../../src/gen/nn/webgpu/gpuBatch.js";
import { nnV2Source } from "../../src/gen/rowSources.js";
import { loadCritic } from "../../src/gen/critic.js";
import { analyzeChart } from "../../src/core/analyze.js";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { computeStemsSync } from "../../src/audio/stems.js";
import { mulberry32 } from "../../src/gen/rng.js";
import { clickTrack } from "../fixtures/clickTrack.js";
import { partsSong, PARTS_SONG, PARTS_SONG_BPM, PARTS_SONG_OFFSET } from "../fixtures/partsSong.js";
import { sectionSong } from "../fixtures/stemTracks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const link = createGpuWorkerLink({ post: (m) => process.parentPort.postMessage(m) });
const oldDir = process.argv.includes("--old") ? process.argv[process.argv.indexOf("--old") + 1] : null;

const models = new Map();
const modelOf = async (size) => {
    if (!models.has(size)) models.set(size, JSON.parse(await readFile(path.join(root, "models", `mapper-nn2-${size}.json`), "utf8")));
    return models.get(size);
};
let critic = null;
const criticOf = async () => (critic ??= loadCritic(JSON.parse(await readFile(path.join(root, "models", "critic.json"), "utf8"))));

// the songs: a 4-minute A B A B' C … song at 175 BPM (701 beats, as the stream W bench), the six-part song, a click track
const SONGS = {
    sections175: () => {
        const letters = Array.from({ length: 22 }, (_, k) => ["A", "B", "A", "B'", "C", "A", "B", "C'"][k % 8].replace("C'", "C"));
        const s = sectionSong(letters, { bpm: 175 });
        return { samples: s.samples, sampleRate: s.sampleRate, timing: { bpm: 175, offsetMs: 0 } };
    },
    parts160: () => ({ samples: partsSong(), sampleRate: 22050, timing: { bpm: PARTS_SONG_BPM, offsetMs: PARTS_SONG_OFFSET } }),
    click174: () => {
        const s = clickTrack({ bpm: 174, offsetMs: 312, seconds: 90, div: 4, hats: [{ fromMs: 30000, toMs: 60000, div: 4 }] });
        return { samples: s.samples, sampleRate: s.sampleRate, timing: { bpm: 174, offsetMs: 312 } };
    },
};
const songs = new Map();
function songOf(name) {
    if (!songs.has(name)) {
        const s = SONGS[name]();
        songs.set(name, {
            envelope: onsetEnvelope(s.samples, s.sampleRate),
            stems: computeStemsSync(s.samples, s.sampleRate),
            durationMs: Math.round((s.samples.length / s.sampleRate) * 1000),
            timing: s.timing,
        });
    }
    return songs.get(name);
}
const inputOf = (name, request) => {
    const s = songOf(name);
    return {
        timing: s.timing, envelope: s.envelope, durationMs: s.durationMs, stems: s.stems,
        request: { range: { lo: 7, hi: 9 }, patterns: [{ name: "Stream", share: 0.5 }, { name: "Jumpstream", share: 0.5 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 7, repeats: true, ...request },
        meta: { title: `bench ${name}`, audioFilename: "a.mp3" },
    };
};

// the backend as each mode sees it: the full one (batches), one that only encodes (0.10.2's D1)
const encodeOnly = (backend) => ({ encode: (m, inputs) => backend.encode(m, inputs) });

async function time({ size, song, mode, candidates = 12, deadlineMs = 1e9, seed = 7 }) {
    const backend = await link.backend();
    if (mode !== "cpu" && !backend) return { skipped: "no GPU backend" };
    const model = await modelOf(size);
    const input = inputOf(song, { candidates, seed });
    const debug = {};
    const through = { cpu: {}, batch: { nnBackend: backend }, d1: { nnBackend: encodeOnly(backend) }, "old-d1": { nnBackend: encodeOnly(backend) } };
    const opts = { debug, critic: await criticOf(), deadlineMs, ...through[mode] };
    const gen = mode === "old-d1" ? (await import(pathToFileURL(path.join(oldDir, "src", "gen", "generateLearned.js")).href)).generateLearnedMap : generateLearnedMap;
    const started = Date.now();
    const t0 = performance.now();
    const out = await gen(input, analyzeChart, model, opts);
    const ms = performance.now() - t0;
    const t = debug.timing ?? null;
    return {
        size, song, mode, candidates, started, ended: Date.now(), ms: Math.round(ms),
        modelMs: t ? Math.round(t.prepareMs + t.buildMs + t.snapshotMs) : null, timing: t, batch: debug.batch ?? null,
        of: out.critic?.of ?? 1, numeric: out.result?.numeric ?? null, notes: out.noteCount, osuText: out.osuText,
    };
}

// the GPU batch's logits vs the CPU decoder over the very same rows, and the rows of the same seeds on both
// snapshotAt (0..1): the builds restore a GPU snapshot taken that far into the song (as own-range parts and block
// retries do) instead of starting from begin(); variants: whether to compare whole variants too
async function parity({ size, song, builds = 4, offset = 0, snapshotAt = 0, variants = true }) {
    const backend = await link.backend();
    if (!backend) return { skipped: "no GPU backend" };
    const model = await modelOf(size);
    const net = loadInfill(model);
    // the prepare arguments a real variant gives the source
    let args = null;
    const catcher = { kind: "nn-v2", caps: { infill: true }, prepare: (a) => { args = a; throw new Error("caught"); } };
    await generateLearnedMap(inputOf(song, { candidates: 1 }), analyzeChart, model, { source: catcher }).catch(() => {});
    const taps = new Map(); // slot "beat:lane" → the GPU logits, one per build in batch order
    const tapHead = (n) => {
        const head = createLaneHead(n);
        const hh = n.arch.lane_hidden;
        return (out, lane, hist, logits, b) => {
            head(out, lane * hh, hist, logits);
            const key = `${b}:${lane}`;
            (taps.get(key) ?? taps.set(key, []).get(key)).push(Float32Array.from(logits));
            return logits;
        };
    };
    const prep = await createGpuInfillSource(backend, { batch: { head: tapHead } }).prepare(args);
    if (!prep.batch) return { skipped: "no batch" };
    const inp = prep.inputs;
    const n = args.slots.length;
    const rngsOf = (s) => ({ fill: mulberry32(s), size: mulberry32(s ^ 0x51), pattern: mulberry32(s ^ 0xa3) });
    const seeds = Array.from({ length: builds }, (_, k) => 101 + k);
    const cut = Math.floor(n * snapshotAt);
    const t0 = performance.now();
    let snap = null;
    let gpuHead = null;
    if (cut) {
        const got = await prep.batch.snapshot(function* head(s) {
            const r = rngsOf(99);
            s.begin();
            const rows = new Uint8Array(cut);
            for (let i = 0; i < cut; i += 1) {
                let m = s.step(i, offset, null, r, null);
                if (m === STEP_WAIT) m = yield STEP_WAIT;
                rows[i] = m;
            }
            return { snap: s.snapshot(), rows };
        });
        snap = got?.snap ?? null;
        gpuHead = got?.rows ?? null;
        taps.clear(); // only the restored builds' logits are compared
    }
    const gpuRows = await prep.batch.run(seeds.map((seed) => function* build(s) {
        const r = rngsOf(seed);
        if (snap) s.restore(snap);
        else s.begin();
        const out = new Uint8Array(n);
        for (let i = cut; i < n; i += 1) {
            let m = s.step(i, offset, null, r, null);
            if (m === STEP_WAIT) m = yield STEP_WAIT;
            out[i] = m;
        }
        return out;
    }));
    const gpuMs = performance.now() - t0;
    const fellBack = prep.batch.off;
    prep.release();
    // the CPU: plain JS from the encoder on, same seeds (and the same head build before the cut)
    const t1 = performance.now();
    const cpu = infillSource.prepare(args);
    const headRows = new Uint8Array(n);
    let cpuSnap = null;
    if (cut) {
        const r = rngsOf(99);
        cpu.begin();
        for (let i = 0; i < cut; i += 1) headRows[i] = cpu.step(i, offset, null, r, null);
        cpuSnap = cpu.snapshot();
    }
    const cpuRows = seeds.map((seed) => {
        const r = rngsOf(seed);
        if (cpuSnap) cpu.restore(cpuSnap);
        else cpu.begin();
        const out = Uint8Array.from(headRows);
        for (let i = cut; i < n; i += 1) out[i] = cpu.step(i, offset, null, r, null);
        return out;
    });
    const cpuMs = performance.now() - t1;
    // the head build's rows on both (the restored builds go on from each one's own head)
    let headDiffer = 0;
    if (gpuHead) for (let i = 0; i < cut; i += 1) headDiffer += gpuHead[i] !== headRows[i] ? 1 : 0;
    for (const g of gpuRows) g.set(gpuHead ?? headRows.subarray(0, cut));
    let differ = 0;
    let firstDiff = null;
    gpuRows.forEach((g, k) => g.forEach((m, i) => {
        if (i >= cut && m !== cpuRows[k][i]) {
            differ += 1;
            firstDiff ??= { build: k, slot: i };
        }
    }));
    // teacher-forced on the CPU over each GPU build's own rows: the logits the CPU decoder gives that very history
    const enc = encodeBeats(net, inp);
    let worst = 0;
    let compared = 0;
    const posOf = (i) => inp.beatOf[i] + inp.laneOf[i] / DIV_CLASSES[inp.div[inp.beatOf[i]]];
    gpuRows.forEach((g, k) => {
        const dec = createDecoder(net, enc, inp);
        const hist = createHistory();
        const rows = new Uint8Array(inp.T * N_LANES);
        const h = new Float32Array(68);
        const logits = new Float32Array(16);
        for (let i = 0; i < n; i += 1) {
            const b = inp.beatOf[i];
            while (dec.beat <= b) {
                const pb = dec.beat;
                dec.advance(pb ? rows : null, (pb - 1) * N_LANES);
            }
            dec.laneLogits(inp.laneOf[i], hist.features(posOf(i), h), logits);
            const want = i >= cut ? taps.get(`${b}:${inp.laneOf[i]}`)?.[k] : null;
            if (want) {
                for (let c = 0; c < 16; c += 1) worst = Math.max(worst, Math.abs(want[c] - logits[c]));
                compared += 1;
            }
            rows[b * N_LANES + inp.laneOf[i]] = g[i];
            hist.push(g[i], posOf(i));
        }
    });
    const head = { size, song, beats: inp.T, slots: n, builds, cut, headDiffer, compared, worstLogit: worst, rowsDiffer: differ, rowsTotal: (n - cut) * builds, firstDiff, fellBack, gpuMs: Math.round(gpuMs), cpuMs: Math.round(cpuMs) };
    if (!variants) return head;
    // a whole variant on the CPU, with the GPU encoder only (0.10.2) and through the batches: the same map? (rows: the hit
    // objects only the CPU's map has)
    const whole = {};
    for (const mode of ["cpu", "d1", "batch"]) {
        const r = await time({ size, song, mode, candidates: 4 });
        whole[mode] = { osuText: r.osuText, numeric: r.numeric, notes: r.notes, batched: r.timing?.batched ?? 0 };
    }
    const lines = (text) => text.split("\n").filter((l) => /^\d+,\d+,\d+/.test(l));
    const cpuLines = lines(whole.cpu.osuText);
    const vs = (mode) => {
        const other = new Set(lines(whole[mode].osuText));
        return { same: whole[mode].osuText === whole.cpu.osuText, rowsOnlyCpu: cpuLines.filter((l) => !other.has(l)).length, notes: whole[mode].notes, dan: whole[mode].numeric, batched: whole[mode].batched };
    };
    return { ...head, variant: { cpu: { notes: whole.cpu.notes, dan: whole.cpu.numeric }, d1: vs("d1"), batch: vs("batch") } };
}

// decode rounds alone (no builds): the worker ↔ GPU round trip per round for B items of one beat, and the part of it
// spent in the renderer's decode op (serverMs)
async function rtt({ size, batches = [1, 2, 4, 8, 12], rounds = 200 }) {
    const backend = await link.backend();
    if (!backend) return { skipped: "no GPU backend" };
    const model = await modelOf(size);
    let args = null;
    const catcher = { kind: "nn-v2", caps: { infill: true }, prepare: (a) => { args = a; throw new Error("caught"); } };
    await generateLearnedMap(inputOf("sections175", { candidates: 1 }), analyzeChart, model, { source: catcher }).catch(() => {});
    const net = loadInfill(model);
    const { buildInfillInputs } = await import("../../src/gen/nn/infillModel.js");
    const inputs = buildInfillInputs(net, args);
    const got = await backend.encode(model, inputs, { keep: true });
    const out = [];
    for (const B of batches) {
        const times = [];
        const server = [];
        for (let r = 0; r < Math.min(rounds, inputs.T); r += 1) {
            const items = Array.from({ length: B }, (_, k) => ({ ref: k + 1, b0: r, n: 1, rows: new Uint8Array(8) }));
            const t0 = performance.now();
            const res = await backend.decode(got.session, { items }, { timeoutMs: 60_000 });
            times.push(performance.now() - t0);
            server.push(res.serverMs);
        }
        const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
        const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)];
        out.push({ B, rounds: times.length, medianMs: med(times.slice(5)), p90Ms: p90(times.slice(5)), meanMs: times.slice(5).reduce((a, b) => a + b, 0) / (times.length - 5), serverMedianMs: med(server.slice(5)) });
    }
    await backend.release(got.session);
    return { size, rtt: out };
}

const jobs = { time, parity, rtt, warm: async ({ size }) => ({ ms: (await time({ size, song: "click174", mode: "batch", candidates: 2 })).ms }), link: async () => ({ backend: Boolean(await link.backend()), capability: link.client.capability() }) };

process.parentPort.on("message", async ({ data, ports }) => {
    if (link.accept(data, ports)) return;
    let result;
    try {
        result = await jobs[data.payload.kind](data.payload);
        if (result?.osuText) delete result.osuText;
        result = { kind: "generated", ...result };
    } catch (error) {
        result = { kind: "error", message: String(error?.stack ?? error) };
    }
    process.parentPort.postMessage({ id: data.id, result });
});
