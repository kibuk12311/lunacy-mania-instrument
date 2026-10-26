// The critic's training data: human maps (positives) and maps a human would not make (negatives), all as
// criticFeatures vectors (src/gen/criticFeatures.js) on the human map's own grid.
//
// Positives: human 4K rice maps of the dataset (mapper15 today, mapper3 later), re-rendered from their labelled slots
// through the writer (toOsu: no LNs, slot times), so they look like generated maps to the critic except for the
// rows themselves. Negatives per positive (--neg, default gen:1,perturb:2):
//   gen     — the v3 generator (generateLearnedMap, --model = B0's model) on the same song at the human's dan,
//             the human's pattern families, seeds 1–3;
//   v2      — the generator of an older checkout (--v2-root <dir>, e.g. a worktree at the tag before v3);
//   perturb — the human map with one perturbation (PERTURBATIONS below, each a pure function).
// Every row (human or negative) gets a column-mirrored copy with probability --mirror (0.5): same song group, same
// split, `mirror: 1`; mirrored humans stay positives.
// Splits: held-out sets → "test" (evaluation only); train song groups → "val" when crc32(group) % 10 == 1, else
// "train" (a mapper3 index carries its split: test = the corpus's held-out, val = crc32 % 10 == 1). Negatives are made
// from the song's own split, and so are the donors of the section swap: one donor pool per split (train, val, test),
// so no train map's section ever lands in a val negative or the other way round.
// Datasets: mapper15 (dan, group, offgridShare, maps/<id>.f32) and mapper3 (danTracker ?? danOurs, songGroup,
// residualOffgrid, creatorKey, maps/<id[0:2]>/<id>.f32) index lines both work (normalizeMap). Creators are the corpus
// creatorKey ("u:<osu! id>" merged by user id, else "n:<name>"), never the bare lower-cased name.
//
// Output (--out): features.f32 (rows × CRITIC_FEATURES float32), index.jsonl (one line per row: row, song, group,
// split, kind, sub, mirror, map, chartKey, beatmapId, setId, creator, dan, seed, …), feature_names.json, report.json.
// --resume continues an interrupted run (songs already in index.jsonl are skipped).
// Every generated map is also kept in gen-rows.jsonl (row times and masks). --gen-cache <that file> serves them to a
// later run instead of the generator, so the features can be rebuilt (new CRITIC_FEATURES, stems, structure) in a
// fraction of the time; maps not in the cache are generated as usual.
//
// Usage: node tools/make-critic-negatives.mjs --data A:/SneezeyTrain/mapper15 --out A:/SneezeyTrain/critic/data
//          [--corpus A:/SneezeyTrain/corpus/corpus.jsonl] [--limit 0] [--test-limit 0] [--per-song 2]
//          [--neg gen:1,perturb:2] [--model models/mapper.json] [--v2-root <dir>] [--mirror 0.5]
//          [--audio auto|decode|f32] [--workers 8] [--seed 1] [--max-gen-sec 360] [--gen-cache <gen-rows.jsonl>]
//          [--resume]
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFile, writeFile, appendFile, mkdir, stat, truncate } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beatsFromTiming, slotsForBeats, parseRedTimingPoints, timingFromPoints } from "../src/gen/grid.js";
import { parseRows, labelSlots } from "../src/gen/mapRows.js";
import { toOsu } from "../src/gen/writer.js";
import { mulberry32, deriveSeed } from "../src/gen/rng.js";
import { criticFeatures, CRITIC_FEATURES, mirrorMask } from "../src/gen/criticFeatures.js";

const SELF = fileURLToPath(import.meta.url);
const SAMPLE_RATE = 22050;
const MAX_AUDIO_SEC = 480;
const MIN_ROWS = 100;
const MAX_OFFGRID = 0.2;
const NEG_KINDS = ["gen", "v2", "perturb"];

// ---- perturbations: (rows, slots, rng, opts) → new rows, sorted, one per slot, on slot times; inputs untouched ----

const POP = Uint8Array.from({ length: 16 }, (_, m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const MASKS_BY_SIZE = [1, 2, 3, 4].map((n) => Array.from({ length: 15 }, (_, k) => k + 1).filter((m) => POP[m] === n));
const onSlot = (slots, i, mask) => ({ t: slots[i].t, mask, i });
const byIndex = (rows) => rows.sort((a, b) => a.i - b.i);
const copyRows = (rows, slots) => rows.map((r) => onSlot(slots, r.i, r.mask));
const pickOf = (rng, list) => list[Math.floor(rng() * list.length)];

function shuffled(list, rng) {
    const out = list.slice();
    for (let k = out.length - 1; k > 0; k -= 1) {
        const j = Math.floor(rng() * (k + 1));
        [out[k], out[j]] = [out[j], out[k]];
    }
    return out;
}

const bitsOf = (m) => [0, 1, 2, 3].filter((c) => m & (1 << c));

// First slot and slot count of every beat (slot.beat).
function beatTable(slots) {
    const start = new Map();
    const count = new Map();
    slots.forEach((s, i) => {
        if (!start.has(s.beat)) start.set(s.beat, i);
        count.set(s.beat, (count.get(s.beat) ?? 0) + 1);
    });
    return { start, count };
}

// The slot of `beat` nearest to a phase (pos/div) of the beat, or −1 when the grid has no such beat.
function slotAtPhase(slots, table, beat, phase) {
    const i0 = table.start.get(beat);
    if (i0 === undefined) return -1;
    let best = i0;
    for (let i = i0; i < i0 + table.count.get(beat); i += 1) {
        const p = (slots[i].pos ?? slots[i].sub) / (slots[i].div ?? 4);
        const b = (slots[best].pos ?? slots[best].sub) / (slots[best].div ?? 4);
        if (Math.abs(p - phase) < Math.abs(b - phase)) best = i;
    }
    return best;
}

// Columns remapped at random within each row size: same times, same sizes.
export function remapColumns(rows, slots, rng) {
    return rows.map((r) => onSlot(slots, r.i, pickOf(rng, MASKS_BY_SIZE[POP[r.mask] - 1])));
}

// 1-beat segments shuffled inside each bar (4 beats of the same grid): same rows per bar, same in-beat positions.
export function shuffleBeats(rows, slots, rng, { barBeats = 4 } = {}) {
    const table = beatTable(slots);
    const byBeat = new Map();
    for (const r of rows) {
        const beat = slots[r.i].beat;
        if (!byBeat.has(beat)) byBeat.set(beat, []);
        byBeat.get(beat).push({ off: r.i - table.start.get(beat), mask: r.mask });
    }
    const bars = new Map();
    for (const beat of byBeat.keys()) bars.set(Math.floor(beat / barBeats), true);
    const out = [];
    for (const bar of bars.keys()) {
        const beats = Array.from({ length: barBeats }, (_, k) => bar * barBeats + k);
        const shape = (b) => (table.start.has(b) ? `${table.count.get(b)}:${slots[table.start.get(b)].div ?? 4}` : null);
        const same = beats.every((b) => shape(b) !== null && shape(b) === shape(beats[0]));
        const from = same ? shuffled(beats, rng) : beats;
        beats.forEach((b, k) => {
            for (const { off, mask } of byBeat.get(from[k]) ?? []) out.push(onSlot(slots, table.start.get(b) + off, mask));
        });
    }
    return byIndex(out);
}

// Jacks inserted: about `share` of the rows that do not jack yet take one column of the row before (same size).
export function insertJacks(rows, slots, rng, { share = 0.15 } = {}) {
    const out = copyRows(rows, slots);
    const candidates = [];
    for (let k = 1; k < out.length; k += 1) {
        const s = slots[out[k].i];
        const near = s.t - out[k - 1].t <= (s.beatMs ?? 60000 / s.bpm) / 2;
        if (near && !(out[k].mask & out[k - 1].mask) && POP[out[k].mask] < 4) candidates.push(k);
    }
    const chosen = shuffled(candidates, rng).slice(0, Math.round(share * rows.length)).sort((a, b) => a - b);
    for (const k of chosen) {
        const prev = out[k - 1].mask;
        const cur = out[k].mask;
        if (cur & prev) continue; // an earlier change made it a jack already
        const add = pickOf(rng, bitsOf(prev));
        const drop = pickOf(rng, bitsOf(cur));
        out[k] = onSlot(slots, out[k].i, (cur & ~(1 << drop)) | (1 << add));
    }
    return out;
}

// About `share` of the rows moved one slot earlier or later, where that slot is free; masks unchanged.
export function shiftRows(rows, slots, rng, { share = 0.3 } = {}) {
    const taken = new Set(rows.map((r) => r.i));
    const at = rows.map((r) => r.i);
    const target = Math.round(share * rows.length);
    let moved = 0;
    for (const k of shuffled(rows.map((_, k) => k), rng)) {
        if (moved >= target) break;
        const dirs = rng() < 0.5 ? [-1, 1] : [1, -1];
        for (const d of dirs) {
            const j = at[k] + d;
            if (j < 0 || j >= slots.length || taken.has(j)) continue;
            taken.delete(at[k]);
            taken.add(j);
            at[k] = j;
            moved += 1;
            break;
        }
    }
    return byIndex(rows.map((r, k) => onSlot(slots, at[k], r.mask)));
}

// ±`amount` density: remove that share of the rows, or add as many on free slots inside the map (masks drawn
// from the map's own rows). The other rows stay as they were.
export function densityNoise(rows, slots, rng, { amount = 0.15 } = {}) {
    const n = Math.round(amount * rows.length);
    if (rng() < 0.5) {
        const drop = new Set(shuffled(rows.map((_, k) => k), rng).slice(0, n));
        return copyRows(rows.filter((_, k) => !drop.has(k)), slots);
    }
    const taken = new Set(rows.map((r) => r.i));
    const free = [];
    for (let i = rows[0].i; i <= rows.at(-1).i; i += 1) if (!taken.has(i)) free.push(i);
    const added = shuffled(free, rng).slice(0, n).map((i) => onSlot(slots, i, pickOf(rng, rows).mask));
    return byIndex([...copyRows(rows, slots), ...added]);
}

// Sections of `beats` beats from the first row's beat: Map(section → rows), only those with at least `min` rows.
function sectionsOf(rows, slots, beats, min = 8) {
    const b0 = slots[rows[0].i].beat;
    const out = new Map();
    for (const r of rows) {
        const sec = Math.floor((slots[r.i].beat - b0) / beats);
        if (!out.has(sec)) out.set(sec, []);
        out.get(sec).push(r);
    }
    for (const [sec, rs] of out) if (rs.length < min) out.delete(sec);
    return { b0, sections: out };
}

// One 8-beat section replaced by an 8-beat section of another map of the same dan (`donor: { rows, slots }`),
// placed by beat and phase. Without a donor nothing changes.
export function swapSection(rows, slots, rng, { donor = null, beats = 8 } = {}) {
    if (!donor?.rows?.length || !rows.length) return copyRows(rows, slots);
    const mine = sectionsOf(rows, slots, beats);
    const theirs = sectionsOf(donor.rows, donor.slots, beats);
    if (!mine.sections.size || !theirs.sections.size) return copyRows(rows, slots);
    const sec = pickOf(rng, [...mine.sections.keys()]);
    const dsec = pickOf(rng, [...theirs.sections.keys()]);
    const tb = mine.b0 + sec * beats;
    const db = theirs.b0 + dsec * beats;
    const table = beatTable(slots);
    const kept = rows.filter((r) => slots[r.i].beat < tb || slots[r.i].beat >= tb + beats).map((r) => onSlot(slots, r.i, r.mask));
    const placed = new Map();
    for (const r of theirs.sections.get(dsec)) {
        const s = donor.slots[r.i];
        const i = slotAtPhase(slots, table, tb + (s.beat - db), (s.pos ?? s.sub) / (s.div ?? 4));
        if (i >= 0) placed.set(i, (placed.get(i) ?? 0) | r.mask);
    }
    return byIndex([...kept, ...[...placed].map(([i, mask]) => onSlot(slots, i, mask))]);
}

export const PERTURBATIONS = { remapColumns, shuffleBeats, insertJacks, shiftRows, densityNoise, swapSection };

const sameRows = (a, b) => a.length === b.length && a.every((r, k) => r.i === b[k].i && r.mask === b[k].mask);

// One perturbation picked at random; when it changed nothing (a full stream has no slot to shift into) the next
// kinds are tried. → { kind, rows }; kind is null when no kind changed anything.
export function perturb(rows, slots, rng, { kinds = Object.keys(PERTURBATIONS), donor = null } = {}) {
    const usable = kinds.filter((k) => k !== "swapSection" || donor?.rows?.length);
    if (!usable.length || !rows.length) return { kind: null, rows: copyRows(rows, slots) };
    const first = pickOf(rng, usable);
    for (const kind of [first, ...usable.filter((k) => k !== first)]) {
        const out = PERTURBATIONS[kind](rows, slots, rng, { donor });
        if (!sameRows(out, rows)) return { kind, rows: out };
    }
    return { kind: null, rows: copyRows(rows, slots) };
}

export const mirrorRows = (rows) => rows.map((r) => ({ ...r, mask: mirrorMask(r.mask) }));

// ---- grid, split, arguments ----

// The human map's grid (as the dataset builder makes it): every 1/4 slot of its red lines from 2 s before the first
// row to 1 s after the last (at most to 50 ms before the audio ends).
export function chartSlots(points, rows, audioEndMs = Infinity) {
    const endMs = Math.min(audioEndMs - 50, rows.at(-1).t + 1000);
    const from = Math.max(0, rows[0].t - 2000);
    return slotsForBeats(beatsFromTiming(points, endMs)).filter((s) => s.t >= from);
}

// "train" | "val" | "test" | null (quarantine and unknown splits are not used).
export function splitOf(m) {
    const s = m.split;
    if (s === "heldout" || s === "test") return "test";
    if (s === "val") return "val";
    if (s === undefined || s === "train") {
        const group = String(m.group ?? m.songGroup ?? m.set ?? m.id ?? "");
        return crc32(Buffer.from(group, "utf8")) % 10 === 1 ? "val" : "train";
    }
    return null;
}

export function parseList(text) {
    const out = {};
    for (const part of String(text).split(",").filter(Boolean)) {
        const [name, n] = part.split(":");
        if (!NEG_KINDS.includes(name)) throw new Error(`unknown negative kind: ${name}`);
        if (!/^\d+$/.test(n ?? "")) throw new Error(`bad count for ${name}: ${n}`);
        out[name] = Number(n);
    }
    return out;
}

function parseArgs(argv) {
    const o = {
        data: null, out: null, corpus: "A:/SneezeyTrain/corpus/corpus.jsonl", limit: 0, testLimit: 0, perSong: 2,
        neg: { gen: 1, perturb: 2 }, model: "models/mapper.json", v2Root: null, mirror: 0.5, audio: "auto", workers: 8,
        seed: 1, maxGenSec: 360, resume: false, genCache: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const v = () => argv[++i];
        if (a === "--data") o.data = v();
        else if (a === "--out") o.out = v();
        else if (a === "--corpus") o.corpus = v();
        else if (a === "--limit") o.limit = Number(v());
        else if (a === "--test-limit") o.testLimit = Number(v());
        else if (a === "--per-song") o.perSong = Number(v());
        else if (a === "--neg") o.neg = parseList(v());
        else if (a === "--model") o.model = v();
        else if (a === "--v2-root") o.v2Root = v();
        else if (a === "--mirror") o.mirror = Number(v());
        else if (a === "--audio") o.audio = v();
        else if (a === "--workers") o.workers = Number(v());
        else if (a === "--seed") o.seed = Number(v());
        else if (a === "--max-gen-sec") o.maxGenSec = Number(v());
        else if (a === "--resume") o.resume = true;
        else if (a === "--gen-cache") o.genCache = v();
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!o.data || !o.out) throw new Error("usage: --data <dataset dir> --out <dir> (see the header)");
    if (!["auto", "decode", "f32"].includes(o.audio)) throw new Error(`--audio auto|decode|f32, not ${o.audio}`);
    if ((o.neg.v2 ?? 0) > 0 && !o.v2Root) throw new Error("--neg v2:n needs --v2-root");
    return o;
}

// ---- worker: one song per job ----

const cleanPoints = (points) => points.filter((p) => 60000 / p.beatLength >= 40 && 60000 / p.beatLength <= 400);
// a red line before 0 moves forward by whole beats (the grid keeps its phase), as tools/eval-generator.mjs does
const shiftedTiming = (points) => timingFromPoints(points.map((p) => ({ ...p, time: p.time < 0 ? p.time + Math.ceil(-p.time / p.beatLength) * p.beatLength : p.time })));

function decode(audioPath) {
    const dec = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", audioPath, "-t", String(MAX_AUDIO_SEC),
        "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"], { maxBuffer: 512 * 1024 * 1024 });
    if (dec.status !== 0 || !dec.stdout?.length) throw new Error(`ffmpeg: ${String(dec.stderr).slice(0, 160)}`);
    return new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
}

// Generated rows ↔ a gen-rows.jsonl record: times as deltas (whole ms), masks as they are.
export function packRows(rows) {
    const t = [];
    let last = 0;
    for (const r of rows) {
        t.push(Math.round(r.t) - last);
        last = Math.round(r.t);
    }
    return { t, m: rows.map((r) => r.mask) };
}

export function unpackRows({ t, m }) {
    const out = [];
    let at = 0;
    for (let k = 0; k < t.length; k += 1) {
        at += t[k];
        out.push({ t: at, mask: m[k] });
    }
    return out;
}

// gen-rows.jsonl → Map(key → line), keeping the text (one JSON parse per use, in the worker).
export async function readGenCache(file) {
    const cache = new Map();
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.startsWith("{\"key\":")) continue;
        const end = line.indexOf("\",", 8);
        if (end > 8) cache.set(JSON.parse(line.slice(7, end + 1)), line);
    }
    return cache;
}

async function workerMain() {
    const { opts, featureNames } = workerData;
    const { onsetEnvelope } = await import("../src/audio/onset.js");
    const { slotFeatures } = await import("../src/gen/slotFeatures.js");
    const { analyzeChart } = await import("../src/core/analyze.js");
    const { analyzePatternFromText } = await import("../src/core/leoblack.js");
    const { patternShares } = await import("../src/core/patterns.js");
    const { NAME_FAMILY } = await import("../src/gen/search.js");
    const neg = { gen: 0, v2: 0, perturb: 0, ...opts.neg };
    const model = neg.gen > 0 || neg.v2 > 0 ? JSON.parse(await readFile(opts.model, "utf8")) : null;
    const v3 = neg.gen > 0 ? (await import("../src/gen/generateLearned.js")).generateLearnedMap : null;
    let v2 = null;
    if (neg.v2 > 0) {
        const root = path.resolve(opts.v2Root);
        v2 = {
            generate: (await import(pathToFileURL(path.join(root, "src/gen/generateLearned.js")).href)).generateLearnedMap,
            analyze: (await import(pathToFileURL(path.join(root, "src/core/analyze.js")).href)).analyzeChart,
        };
    }
    const decodeNeeded = opts.audio === "decode" || (opts.audio === "auto" && (neg.gen > 0 || neg.v2 > 0));

    // The human map's pattern families as the generator's request (pattern finder names → families, top 2).
    const familiesOf = (text, primary) => {
        const shares = new Map();
        try {
            for (const p of patternShares(analyzePatternFromText(text, 1)?.report) ?? []) {
                const f = NAME_FAMILY[p.name];
                if (f) shares.set(f, (shares.get(f) ?? 0) + p.share);
            }
        } catch { /* the primary below */ }
        const top = [...shares].sort((a, b) => b[1] - a[1]).slice(0, 2);
        const total = top.reduce((s, [, x]) => s + x, 0);
        if (!top.length || total <= 0) return [{ name: NAME_FAMILY[primary] ?? "Jumpstream", share: 1 }];
        return top.map(([name, x]) => ({ name, share: Math.round((x / total) * 1000) / 1000 }));
    };

    // rows of a chart (human or generated) on its grid: labelled slots → rows on slot times
    const onGrid = (rawRows, points, audioEndMs) => {
        const slots = chartSlots(points, rawRows, audioEndMs);
        const { note, mask, offgrid } = labelSlots(rawRows, slots);
        const rows = [];
        for (let i = 0; i < slots.length; i += 1) if (note[i]) rows.push({ t: slots[i].t, mask: mask[i], i });
        return { slots, rows, offgrid };
    };

    const readDonor = async (donor) => {
        if (!donor) return null;
        const text = await readFile(donor.osuPath, "utf8").catch(() => null);
        if (!text) return null;
        const raw = parseRows(text, 4);
        const points = cleanPoints(parseRedTimingPoints(text));
        if (!points.length || raw.length < MIN_ROWS) return null;
        const { slots, rows } = onGrid(raw, points, Infinity);
        return rows.length ? { rows, slots } : null;
    };

    async function processSong(job) {
        const out = [];
        const errors = [];
        const counts = {};
        const genRecords = [];
        const bump = (k, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
        let envelope = null;
        let audioEndMs = Infinity;
        if (decodeNeeded) {
            const samples = decode(job.audio);
            envelope = onsetEnvelope(samples, SAMPLE_RATE);
            audioEndMs = (samples.length / SAMPLE_RATE) * 1000;
        }
        const audioFor = (slots) => (envelope ? slotFeatures(envelope, slots, slots[0]?.bpm, ["onset", "energy"]) : null);
        for (const m of job.maps) {
            try {
                const text = await readFile(m.osuPath, "utf8");
                const raw = parseRows(text, 4);
                const points = cleanPoints(parseRedTimingPoints(text));
                if (!points.length || raw.length < MIN_ROWS) {
                    bump("skip: no timing or under 100 rows");
                    continue;
                }
                if (raw.at(-1).t > audioEndMs) {
                    bump("skip: longer than the audio");
                    continue;
                }
                const grid = onGrid(raw, points, audioEndMs);
                if (grid.offgrid / raw.length > MAX_OFFGRID) {
                    bump("skip: off the 1/4 grid");
                    continue;
                }
                // re-rendered through the writer and read back on the same grid, like every generated map
                const { slots } = grid;
                const rendered = toOsu({ rows: grid.rows, timingPoints: points, title: "critic", version: "human", audioFilename: "audio.mp3" });
                const back = labelSlots(parseRows(rendered, 4), slots);
                const human = [];
                for (let i = 0; i < slots.length; i += 1) if (back.note[i]) human.push({ t: slots[i].t, mask: back.mask[i], i });
                let audio = audioFor(slots);
                if (!audio && opts.audio !== "decode") {
                    // the dataset's own slot features (same grid rule, same onset/energy columns)
                    const buf = await readFile(path.join(opts.data, m.f32 ?? `maps/${m.id}.f32`)).catch(() => null);
                    const F = featureNames.length;
                    if (buf && buf.length === slots.length * F * 4 && featureNames.includes("onset")) {
                        audio = { names: featureNames, rows: new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4) };
                    } else bump("no audio features (f32 grid mismatch)");
                }
                const base = { song: job.song, group: m.group, split: job.split, map: m.id, chartKey: m.chartKey ?? null,
                    beatmapId: m.beatmapId ?? null, setId: m.setId ?? null, creator: m.creator ?? null, creatorName: m.creatorName ?? null,
                    dan: m.dan, source: m.source ?? null };
                const mapSeed = crc32(Buffer.from(String(m.id)));
                const mirrorRng = mulberry32(deriveSeed(opts.seed, mapSeed, 0x31a2));
                const emit = (kind, rows, gridSlots, gridAudio, ctx, extra = {}) => {
                    const f = criticFeatures(rows, gridSlots, gridAudio, null, null, ctx);
                    out.push({ meta: { ...base, kind, ...extra, mirror: 0 }, f });
                    bump(kind);
                    if (mirrorRng() < opts.mirror) {
                        out.push({ meta: { ...base, kind, ...extra, mirror: 1 }, f: criticFeatures(mirrorRows(rows), gridSlots, gridAudio, null, null, ctx) });
                    }
                };
                emit("human", human, slots, audio, { dan: m.dan });

                const spanSec = (raw.at(-1).t - raw[0].t) / 1000;
                const canGen = envelope && spanSec <= opts.maxGenSec;
                let perturbs = neg.perturb;
                if (!canGen && neg.gen + neg.v2 > 0) {
                    perturbs += neg.gen + neg.v2;
                    bump("generator negatives replaced by perturbations (long map or no audio)");
                }
                const donor = perturbs > 0 ? await readDonor(job.donors?.[m.id]) : null;
                for (let k = 0; k < perturbs; k += 1) {
                    const rng = mulberry32(deriveSeed(opts.seed, mapSeed, 0x5e7, k));
                    const { kind, rows } = perturb(human, slots, rng, { donor });
                    if (kind) emit("perturb", rows, slots, audio, { dan: m.dan }, { sub: kind });
                }
                if (canGen) {
                    const families = familiesOf(text, m.primary);
                    const durationMs = Math.min(audioEndMs, raw.at(-1).t + 1500);
                    const timing = shiftedTiming(points);
                    const engines = [["gen", v3, analyzeChart, neg.gen], ["v2", v2?.generate, v2?.analyze, neg.v2]];
                    for (const [kind, generate, analyze, n] of engines) {
                        for (let k = 0; k < n; k += 1) {
                            const seed = 1 + ((mapSeed + k + opts.seed - 1) % 3); // seeds 1–3; --seed shifts them
                            const t0 = Date.now();
                            try {
                                const key = `${m.id}|${kind}|${seed}`;
                                const hit = job.cache?.[key] ? JSON.parse(job.cache[key]) : null;
                                let r;
                                let genRows;
                                if (hit) {
                                    r = { stats: { forced: hit.forced }, result: { numeric: hit.genDan }, reachable: hit.inRange };
                                    genRows = unpackRows(hit);
                                    bump(`${kind}: from the cache`);
                                } else {
                                    const input = { timing, envelope, durationMs, meta: { title: "critic", audioFilename: "audio.mp3" },
                                        request: { range: { lo: m.dan - 0.5, hi: m.dan + 0.5 }, target: m.dan, patterns: families, mix: "sections", stamina: 0.5, burst: 0.3, seed } };
                                    r = await generate(input, analyze, model);
                                    genRows = parseRows(r.osuText, 4);
                                    genRecords.push(JSON.stringify({ key, map: m.id, kind, seed, forced: r.stats?.forced ?? 0, genDan: r.result?.numeric ?? null,
                                        inRange: r.reachable ?? null, families: families.map((q) => q.name), ...packRows(genRows) }));
                                }
                                const gen = onGrid(genRows, points, audioEndMs);
                                if (gen.rows.length < 16) {
                                    bump(`${kind}: under 16 rows`);
                                    continue;
                                }
                                emit(kind, gen.rows, gen.slots, audioFor(gen.slots), { dan: m.dan, forced: r.stats?.forced ?? 0 },
                                    { seed, genDan: r.result?.numeric ?? null, inRange: r.reachable ?? null, families: families.map((p) => p.name), ms: Date.now() - t0 });
                                bump(`${kind} seconds`, (Date.now() - t0) / 1000);
                            } catch (error) {
                                bump(`${kind}: failed`);
                                errors.push(`${kind} ${m.id}: ${String(error?.message ?? error).slice(0, 160)}`);
                            }
                        }
                    }
                }
            } catch (error) {
                bump("map failed");
                errors.push(`${m.id}: ${String(error?.message ?? error).slice(0, 160)}`);
            }
        }
        return { out, errors, counts, genRecords };
    }

    parentPort.on("message", async (job) => {
        if (job === "stop") process.exit(0);
        const t0 = Date.now();
        try {
            const { out, errors, counts, genRecords } = await processSong(job);
            const F = CRITIC_FEATURES.length;
            const features = new Float32Array(out.length * F);
            out.forEach((o, k) => features.set(o.f, k * F));
            parentPort.postMessage({ ok: true, song: job.song, metas: out.map((o) => o.meta), features, errors, counts, genRecords, ms: Date.now() - t0 }, [features.buffer]);
        } catch (error) {
            parentPort.postMessage({ ok: false, song: job.song, metas: [], features: new Float32Array(0), errors: [`${job.song}: ${String(error?.message ?? error).slice(0, 200)}`], counts: { "song failed": 1 }, ms: Date.now() - t0 });
        }
    });
}

// ---- main ----

async function readJsonl(file) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) return [];
    // split on \n only: names may hold U+2028 / U+0085 (see research notes)
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// corpus.jsonl → chartKey → { creator (the creatorKey), creatorName, beatmapId, setId } (streamed; ~55k lines)
async function corpusInfo(file) {
    const out = new Map();
    if (!file || !(await stat(file).catch(() => null))) return out;
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        let c;
        try {
            c = JSON.parse(line);
        } catch {
            continue;
        }
        if (!c.chartKey) continue;
        const name = typeof c.creator === "string" ? c.creator.trim() : null;
        out.set(c.chartKey, { creator: c.creatorKey ?? null, creatorName: name || null, beatmapId: c.beatmapId ?? null, setId: c.beatmapSetId ?? null });
    }
    return out;
}

// A mapper15 or mapper3 index line → the fields this tool reads (dan, group, offgridShare, audio, the .f32 path).
export function normalizeMap(m) {
    const v3 = m.danOurs !== undefined || m.songGroup !== undefined;
    if (!v3) return { ...m, f32: `maps/${m.id}.f32` };
    return {
        ...m,
        dan: Number.isFinite(m.dan) ? m.dan : Number.isFinite(m.danTracker) ? m.danTracker : m.danOurs,
        group: m.group ?? m.songGroup,
        offgridShare: m.offgridShare ?? m.residualOffgrid ?? 0,
        audio: m.audio ?? m.audioPath,
        setId: m.setId ?? m.beatmapSetId ?? null,
        primary: m.primary ?? m.primaryTracker ?? m.primaryOurs ?? null,
        f32: `maps/${String(m.id).slice(0, 2)}/${m.id}.f32`,
    };
}

// Songs (one audio file each, all maps of one split) → jobs: up to perSong maps spread over the dan range, and for
// each a section-swap donor — a map of the same rounded dan from another song of the SAME split (train, val and test
// each have their own pool, so the swap never carries a section across splits).
export function planJobs(songs, { perSong = 2, seed = 1 } = {}) {
    const byBin = new Map();
    for (const s of songs) for (const m of s.maps) {
        const k = `${s.split}:${Math.round(m.dan)}`;
        if (!byBin.has(k)) byBin.set(k, []);
        byBin.get(k).push(m);
    }
    return songs.map((s) => {
        const chosen = spread(s.maps, perSong);
        const rng = mulberry32(deriveSeed(seed, crc32(Buffer.from(s.song)), 0xd0));
        const donors = {};
        for (const m of chosen) {
            const list = (byBin.get(`${s.split}:${Math.round(m.dan)}`) ?? []).filter((x) => x.audio !== m.audio);
            if (list.length) donors[m.id] = { osuPath: list[Math.floor(rng() * list.length)].osuPath, split: s.split };
        }
        return { song: s.song, audio: s.audio, split: s.split, maps: chosen, donors };
    });
}

// Up to n maps of one song, spread from its easiest to its hardest.
function spread(maps, n) {
    const sorted = [...maps].sort((a, b) => a.dan - b.dan);
    if (sorted.length <= n) return sorted;
    if (n === 1) return [sorted[Math.floor(sorted.length / 2)]];
    return Array.from({ length: n }, (_, k) => sorted[Math.round((k * (sorted.length - 1)) / (n - 1))]);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.out, { recursive: true });
    const featureNames = JSON.parse(await readFile(path.join(opts.data, "feature_names.json"), "utf8").catch(() => "[]"));
    const info = await corpusInfo(opts.corpus);
    const all = [
        ...(await readJsonl(path.join(opts.data, "index.jsonl"))),
        ...(await readJsonl(path.join(opts.data, "index-heldout.jsonl"))).map((m) => ({ ...m, split: m.split ?? "heldout" })),
    ];
    const maps = [];
    for (const raw of all) {
        const m = normalizeMap(raw);
        const split = splitOf(m);
        if (!split || !Number.isFinite(m.dan) || !m.osuPath || !(m.audio || m.audioPath)) continue;
        if ((m.offgridShare ?? 0) > MAX_OFFGRID) continue;
        const c = info.get(m.chartKey) ?? {};
        maps.push({ ...m, split, audio: m.audio ?? m.audioPath, osuPath: m.osuPath.replaceAll("\\", "/"),
            creator: m.creatorKey ?? c.creator ?? null, creatorName: m.creatorName ?? c.creatorName ?? null,
            beatmapId: m.beatmapId ?? c.beatmapId ?? null, setId: m.setId ?? c.setId ?? null });
    }
    // songs = one audio file; a song's split is its maps' (they share a song group)
    const songs = new Map();
    for (const m of maps) {
        const key = m.audio.replaceAll("\\", "/").toLowerCase();
        if (!songs.has(key)) songs.set(key, { song: key, audio: m.audio, split: m.split, maps: [] });
        if (songs.get(key).split === m.split) songs.get(key).maps.push(m);
    }
    // the song order (and so --limit's pick) does not depend on --seed: a second run with another --seed gives the
    // same humans with other negatives (the second critic of the anti-gaming check)
    const order = (s) => deriveSeed(1, crc32(Buffer.from(s.song)));
    const pool = [...songs.values()].sort((a, b) => order(a) - order(b));
    const trainPool = pool.filter((s) => s.split !== "test");
    const testPool = pool.filter((s) => s.split === "test");
    const picked = [...(opts.limit > 0 ? trainPool.slice(0, opts.limit) : trainPool), ...(opts.testLimit > 0 ? testPool.slice(0, opts.testLimit) : testPool)];
    const jobs = planJobs(picked, { perSong: opts.perSong, seed: opts.seed });

    const F = CRITIC_FEATURES.length;
    const featFile = path.join(opts.out, "features.f32");
    const indexFile = path.join(opts.out, "index.jsonl");
    const genFile = path.join(opts.out, "gen-rows.jsonl");
    if (opts.genCache) {
        if (path.resolve(opts.genCache).toLowerCase() === path.resolve(genFile).toLowerCase() && !opts.resume) {
            throw new Error("--gen-cache is this --out's own gen-rows.jsonl, which a new run empties: use another --out");
        }
        const cache = await readGenCache(opts.genCache);
        const byMap = new Map();
        for (const [key, line] of cache) {
            const map = key.slice(0, key.indexOf("|"));
            if (!byMap.has(map)) byMap.set(map, {});
            byMap.get(map)[key] = line;
        }
        for (const job of jobs) job.cache = Object.assign({}, ...job.maps.map((m) => byMap.get(m.id) ?? {}));
        console.log(`generator cache: ${cache.size} maps from ${opts.genCache}`);
    }
    let rowCount = 0;
    const done = new Set();
    if (opts.resume) {
        const old = await readJsonl(indexFile);
        for (const r of old) done.add(r.song);
        rowCount = old.length;
        const size = (await stat(featFile).catch(() => ({ size: 0 }))).size;
        if (size < rowCount * F * 4) throw new Error(`features.f32 is shorter than index.jsonl (${size} < ${rowCount * F * 4}); start without --resume`);
        if (size > rowCount * F * 4) await truncate(featFile, rowCount * F * 4);
    } else {
        await writeFile(featFile, Buffer.alloc(0));
        await writeFile(indexFile, "");
        await writeFile(genFile, "");
    }
    await writeFile(path.join(opts.out, "feature_names.json"), JSON.stringify(CRITIC_FEATURES));
    const todo = jobs.filter((j) => !done.has(j.song));
    console.log(`songs: ${todo.length} to do (${jobs.length - todo.length} done before), maps: ${todo.reduce((s, j) => s + j.maps.length, 0)}, `
        + `train/val/test songs: ${todo.filter((j) => j.split === "train").length}/${todo.filter((j) => j.split === "val").length}/${todo.filter((j) => j.split === "test").length}, `
        + `negatives ${JSON.stringify(opts.neg)}, workers ${opts.workers}`);

    const counts = {};
    const errors = [];
    let finished = 0;
    let writing = Promise.resolve();
    const t0 = Date.now();
    const write = (msg) => {
        writing = writing.then(async () => {
            if (msg.metas.length) {
                await appendFile(featFile, Buffer.from(msg.features.buffer, msg.features.byteOffset, msg.features.byteLength));
                await appendFile(indexFile, msg.metas.map((m, k) => JSON.stringify({ row: rowCount + k, ...m })).join("\n") + "\n");
                rowCount += msg.metas.length;
            }
            if (msg.genRecords?.length) await appendFile(genFile, `${msg.genRecords.join("\n")}\n`);
        });
        return writing;
    };
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.workers, todo.length)) }, () => new Promise((resolve) => {
        const w = new Worker(SELF, { workerData: { criticWorker: true, opts, featureNames } });
        const feed = () => {
            if (next >= todo.length) {
                w.postMessage("stop");
                resolve();
                return;
            }
            w.postMessage(todo[next++]);
        };
        w.on("message", async (msg) => {
            await write(msg);
            finished += 1;
            for (const [k, v] of Object.entries(msg.counts ?? {})) counts[k] = (counts[k] ?? 0) + v;
            for (const e of msg.errors ?? []) if (errors.length < 100) errors.push(e);
            if (finished % 10 === 0 || finished === todo.length) {
                const min = (Date.now() - t0) / 60000;
                console.log(`${finished}/${todo.length} songs, ${rowCount} rows, ${min.toFixed(1)} min, eta ${((min / finished) * (todo.length - finished)).toFixed(1)} min`);
            }
            feed();
        });
        w.on("error", (e) => {
            errors.push(`worker: ${e.message}`);
            resolve();
        });
        feed();
    })));
    await writing;
    const report = { finishedAt: new Date().toISOString(), opts, songs: todo.length, rows: rowCount, features: F, minutes: (Date.now() - t0) / 60000, counts, errors };
    await writeFile(path.join(opts.out, "report.json"), JSON.stringify(report, null, 1));
    console.log(`done: ${rowCount} rows in ${report.minutes.toFixed(1)} min`, JSON.stringify(counts));
}

if (!isMainThread && workerData?.criticWorker) {
    await workerMain();
} else if (isMainThread && process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
