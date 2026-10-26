// Training data for the learned mapper: per grid slot audio features + what the mapper did.
//
// Formats
//   --format v3 (mapgen v3 ML addendum §3; the dataset "mapper3"): reads the corpus index (tools/corpus-index.mjs), one
//      chart per corpus line, every beat on its own grid (4, 3, 6 or 8; D2 / snap-v2), labels of §3.4, split of §3.5.
//   --format v1 (default; the v1.5 dataset "mapper15"): 1/4 grid only, AUDIO_FEATURES, .f32 + .u8 [note, mask, family].
//   legacy: node tools/build-mapper-dataset.mjs "A:/Games/osu!/Songs" data/mapper [workers] [limit]   (v1, all = train)
//
// Usage (v3):
//   node tools/build-mapper-dataset.mjs --format v3 --corpus A:/SneezeyTrain/corpus/corpus.jsonl --out A:/SneezeyTrain/mapper3
//        [--workers 12] [--limit N] [--features v2|v3|FILE.json] [--sources hf,ranked,...] [--fun FILE|-] [--resume]
//   --features v2 (default): AUDIO_FEATURES_V2 slot columns and BEAT_FEATURES beat columns (what exists today).
//   --features v3: AUDIO_FEATURES_V3 and BEAT_FEATURES_V3 (stems + structure); needs stream S merged (see below).
//   --limit N: N charts, picked by a hash of the .osu path (a spread over sources and songs, the same N every time).
//   --fun: fun labels by beatmap id (tools/fun-labels.py; default A:/SneezeyTrain/corpus/fun-labels.jsonl if present).
//   --resume: keep the maps already in index.jsonl (ids are stable: sha1 of the .osu path) and build the rest.
// Usage (v1.5, unchanged apart from the fixes below):
//   node tools/build-mapper-dataset.mjs --corpus A:/SneezeyTrain/corpus/corpus.jsonl --out A:/SneezeyTrain/mapper15
//        [--workers 10] [--limit N] [--manifest A:/SneezeyTrain/manifest.json]
//        [--exclude C:/.../data/mapper/heldout.json --exclude-root "A:/Games/osu!/Songs"] [--resume] [--no-heldout-features]
//
// Both formats
//   - index lines are written with tools/lib/jsonl.mjs: no character in them breaks Python's str.splitlines();
//   - charts whose red lines leave 20..1000 BPM inside the played part (gimmick maps: up to 6,000,000 BPM gave inf
//     slot_ms in v1.5), or whose features are not all finite, are dropped and counted in the report.
//
// ---- mapper3 layout (--format v3) ---------------------------------------------------------------------------------
//   <out>/format.json              { format: "mapper3", version: 3, featureSet, files } (this description, short)
//   <out>/feature_names.json       slot columns of .f32, in order (F names)
//   <out>/beat_feature_names.json  beat columns of .b32, in order (B names)
//   <out>/index.jsonl              one line per built chart, every split ("train" | "val" | "test"); fields below
//   <out>/heldout.json             test + val song groups with every member song key, and the quarantined groups (§3.5)
//   <out>/report.json              counts, rejects per source, MSD calibration MAE, creators, dan bins, divisors, weights
//   <out>/maps/<id[0:2]>/<id>.*    per chart, little-endian, row-major; S = slots, T = beats:
//     .f32   Float32[S × F]   slot features (feature_names.json)
//     .u8    Uint8[S × 4]     [note 0/1, mask 0..15 (bit c = column c), family (FAMILIES index, 255 = none), div]
//     .t32   Float32[S]       slot time in ms
//     .b32   Float32[T × B]   beat features (beat_feature_names.json)
//     .bd8   Uint8[T]         divisor label of the beat: 4, 3, 6, 8, or 0 = no single grid holds all its rows (its slots
//                             are then cut on the grid holding most of them; the .u8 div column says which)
//     .bs32  Int32[T + 1]     CSR offsets: the slots of beat b are [bs[b], bs[b + 1])
//     .st.json               structure: { v, kind: "parts" | "structure", meter, parts: [{ startMs, endMs, kind, beat }],
//                             bars: [{ startMs, endMs, beat }] (beat = the bar's first beat, an index into the .b32 rows),
//                             phrases: [{ bar, bars }], repeats: [{ a, b, len, sim }], echoOf: [per bar, -1 = none],
//                             echoSim, novelty: [per bar] } (bars .. novelty are null under --features v2). The bars are
//                             src/gen/songParts.js barsOf(slots, meter), the very bars songStructure cut, so the
//                             trainer's echo links (tools/nn/infill_data.py) map bars to beats exactly as here.
//   The nn-v2 beat token of addendum §4.4 (145 values with v3 names) is assembled at training time, not stored:
//     8 lanes × [onset, low, mid, high, kick, snare, hat, harm, perc_share, energy, phase, present] taken from the .f32
//     columns of the beat's slots (bs32; lane k = the beat's k-th slot, lanes past its slot count are 0 with present 0;
//     a column missing from feature_names.json, like the stem columns under v2 names, is 0), then the B beat columns,
//     then a one-hot of the grid the beat's slots are cut on (4, 3, 6, 8: the .u8 div of its first slot).
//     tools/dataset3.py beat_tokens() does exactly this.
//   Mirroring (column c → 3 − c, masks bit-reversed) is applied on the fly in training (§3.6); nothing mirrored is stored.
//   Index line: id, source, osuPath, audioPath, set, version, songKey, songGroup, chartKey, audioKey, beatmapId,
//     beatmapSetId, rate (corpus-index guessRates; the corpus keeps one copy per chart key, so a rate other than 1 is a
//     chart that exists only as a rate edit), rateFrom, packId, creatorKey, creatorName, year, ranked, split, slots, beats, features, beatFeatures,
//     bpm, multiBpm, lnShare, residualOffgrid, offBeatShare, divShare, danOurs, primaryOurs, danTracker, primaryTracker,
//     msdOurs[8], msdTracker[8] | null, msdEtterna[8] | null (overall only), msdOverall, playCount, fun | null,
//     weight (src/corpus/weights.js over the built maps of the split, dan bins from danOurs), corpusWeight.
//     MSD order: overall, stream, jumpstream, handstream, stamina, jackspeed, chordjack, technical.
//   --features v3, per song: computeStemsSync(samples, 22050) (src/audio/stems.js; it clips the ffmpeg samples to ±1
//     like Chromium's decoder), then per chart songStructure({ stems, slots, parts, envelope }) (src/gen/structure.js),
//     slotFeatures(envelope, slots, bpm, AUDIO_FEATURES_V3, { stems, structure }) and beatFeaturesV3(envelope, beats,
//     { stems, structure }) (src/gen/beatFeatures.js, the same function the generator's prepare uses at inference).
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readdir, readFile, stat, mkdir, writeFile, appendFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonLine, parseJsonl } from "./lib/jsonl.mjs";
import {
    gridLabels, timingReject, allFinite, splitOf, heldoutList, mapBase, msdOursVector, msdTrackerVector, msdEtternaVector, MSD8,
} from "./lib/dataset3.mjs";
import { corpusWeights } from "../src/corpus/weights.js";

const MAX_AUDIO_SEC = 480;
const SECTION_SLOTS = 32;
const SAMPLE_RATE = 22050;
const READ_CONCURRENCY = 32;
const DEFAULT_FUN = "A:/SneezeyTrain/corpus/fun-labels.jsonl";

const HELDOUT_SPLITS = new Set(["heldout", "held-out", "held_out", "test", "val", "valid", "validation", "eval"]);
const first = (o, keys) => {
    for (const k of keys) {
        const v = k.split(".").reduce((x, p) => (x == null ? undefined : x[p]), o);
        if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
};
const num = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const md5 = (s) => createHash("md5").update(s).digest("hex");
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const idOf = (text, key) => {
    const v = Number(new RegExp(`^${key}:\\s*(-?\\d+)`, "m").exec(text)?.[1]);
    return Number.isFinite(v) && v > 0 ? v : null;
};
// Difficulty name for matching: the tracker manifest prefixes "[4K] ", case and punctuation vary between copies.
const normVersion = (v) => String(v ?? "").toLowerCase().replace(/^\s*\[\d+k\]\s*/, "").replace(/[^\p{L}\p{N}.]+/gu, "");
const versionOf = (text) => /^Version:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? "";
const round = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const count = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };

async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            await fn(items[i], i);
        }
    }));
}

function decodeAudio(audioPath) {
    const dec = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", audioPath, "-t", String(MAX_AUDIO_SEC),
        "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"], { maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (dec.status !== 0 || !dec.stdout?.length) throw new Error(`ffmpeg: ${String(dec.stderr).slice(0, 200)}`);
    return new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
}

// The same checks as before v15: osu!mania 4K, at least 100 objects, at most 15% LNs, audio file exists.
function chartInfo(text) {
    if (/^Mode:\s*(\d)/m.exec(text)?.[1] !== "3") return { skip: "not mania" };
    if (Number(/^CircleSize:\s*([\d.]+)/m.exec(text)?.[1]) !== 4) return { skip: "not 4K" };
    const objs = text.slice(text.indexOf("[HitObjects]")).split(/\r?\n/).slice(1).filter((l) => l.includes(","));
    if (objs.length < 100) return { skip: "under 100 objects" };
    if (objs.filter((l) => (Number(l.split(",")[3]) & 128) !== 0).length / objs.length > 0.15) return { skip: "LN share over 15%" };
    const audio = /^AudioFilename:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!audio) return { skip: "no AudioFilename" };
    return { audio, noteCount: objs.length };
}

async function loadCorpus(corpusPath) {
    const { rows, bad } = parseJsonl(await readFile(corpusPath, "utf8"));
    return { entries: rows, bad };
}

async function legacyEntries(songsRoot) {
    const out = [];
    for (const d of await readdir(songsRoot, { withFileTypes: true })) if (d.isDirectory()) out.push({ dir: path.join(songsRoot, d.name), split: "train" });
    return out;
}

// ---- v1 (mapper15) planning ------------------------------------------------------------------------------------

// Corpus entries → candidate charts { osuPath, dir, set, split, rawDan?, beatmapId?, setId?, source? }. A corpus line in
// "quarantine" (a train-side song that looks like a held-out one, tools/corpus-index.mjs) is left out: v1.5 took it
// for train.
async function expandEntries(entries, corpusDir) {
    const charts = [];
    charts.quarantined = 0;
    await pool(entries, READ_CONCURRENCY, async (e) => {
        const rawSplit = String(first(e, ["split", "fold"]) ?? "train").toLowerCase();
        if (rawSplit === "quarantine") { charts.quarantined++; return; }
        const split = HELDOUT_SPLITS.has(rawSplit) ? "heldout" : "train";
        const base = first(e, ["dir", "setDir", "set_dir", "folder", "root"]);
        const baseDir = base ? path.resolve(corpusDir, String(base)) : null;
        const rel = first(e, ["osuPath", "osu_path", "osu", "path", "file", "chart"]);
        const common = {
            split, rawDan: num(first(e, ["labels.rawDan", "rawDan", "trackerDan", "tracker_dan", "trackerRawDan", "dan.rawDan", "tracker.rawDan", "tracker.dan"])),
            beatmapId: num(first(e, ["beatmapId", "beatmap_id", "BeatmapID"])), setId: num(first(e, ["beatmapSetId", "setId", "beatmapsetId", "beatmapset_id", "BeatmapSetID"])),
            source: first(e, ["source", "corpus", "origin"]) ?? null, setName: first(e, ["set", "setName", "set_name"]) ?? null,
            audioPath: first(e, ["audio", "audioPath", "audio_path"]) ?? null, group: first(e, ["group", "songKey"]) ?? null,
            rate: num(first(e, ["rate"])), danBin: first(e, ["danBin"]) ?? null, chartKey: first(e, ["chartKey"]) ?? null,
        };
        if (rel && String(rel).toLowerCase().endsWith(".osu")) {
            const osuPath = path.isAbsolute(String(rel)) ? String(rel) : path.resolve(baseDir ?? corpusDir, String(rel));
            charts.push({ ...common, osuPath, dir: path.dirname(osuPath) });
            return;
        }
        const dir = baseDir ?? (rel ? path.resolve(corpusDir, String(rel)) : null);
        if (!dir) return;
        const files = await readdir(dir).catch(() => []);
        for (const f of files.filter((x) => x.toLowerCase().endsWith(".osu"))) charts.push({ ...common, audioPath: null, osuPath: path.join(dir, f), dir });
    });
    return charts;
}

// Charts that must never be trained on (the old data/mapper held-out sets): set folder names, set ids, beatmap ids, .osu md5.
async function exclusionKeys(excludePath, excludeRoot) {
    const keys = { names: new Set(), setIds: new Set(), beatmapIds: new Set(), md5: new Set() };
    if (!excludePath) return keys;
    const names = JSON.parse(await readFile(excludePath, "utf8"));
    for (const n of names) {
        keys.names.add(n);
        const lead = /^(\d+)\s/.exec(n)?.[1];
        if (lead) keys.setIds.add(Number(lead));
    }
    if (excludeRoot) {
        await pool(names, READ_CONCURRENCY, async (n) => {
            const dir = path.join(excludeRoot, n);
            for (const f of (await readdir(dir).catch(() => [])).filter((x) => x.toLowerCase().endsWith(".osu"))) {
                const text = await readFile(path.join(dir, f), "utf8").catch(() => null);
                if (!text) continue;
                keys.md5.add(md5(text));
                const b = idOf(text, "BeatmapID");
                const s = idOf(text, "BeatmapSetID");
                if (b) keys.beatmapIds.add(b);
                if (s) keys.setIds.add(s);
            }
        });
    }
    return keys;
}

async function trackerDans(manifestPath) {
    const byBeatmap = new Map();
    if (!manifestPath) return byBeatmap;
    const m = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "{}"));
    for (const s of m.sets ?? []) for (const d of s.diffs ?? []) {
        if (Number.isFinite(d.dan) && d.beatmapId) byBeatmap.set(Number(d.beatmapId), { dan: d.dan, version: d.version ? normVersion(d.version) : null });
    }
    return byBeatmap;
}

async function planV1(charts, { exclude, tracker, limit }) {
    const skipped = {};
    const skip = (why) => count(skipped, why);
    const read = new Array(charts.length);
    await pool(charts, READ_CONCURRENCY, async (c, i) => {
        const text = await readFile(c.osuPath, "utf8").catch(() => null);
        if (text === null) return skip("unreadable .osu");
        const info = chartInfo(text);
        if (info.skip) return skip(info.skip);
        // The corpus names the audio explicitly (hf/ renames it); otherwise AudioFilename next to the .osu.
        const audioPath = c.audioPath ? path.resolve(String(c.audioPath)) : path.join(path.dirname(c.osuPath), info.audio);
        if (!(await stat(audioPath).catch(() => null))) return skip("audio missing");
        read[i] = { ...c, audioPath, noteCount: info.noteCount, hash: md5(text), // text is not kept: 50k+ charts do not fit the heap
            beatmapId: c.beatmapId ?? idOf(text, "BeatmapID"), setId: c.setId ?? idOf(text, "BeatmapSetID"), version: normVersion(versionOf(text)) };
    });

    // Dedupe identical .osu files, and copies of one chart across corpus roots (hf/ rewrites the .osu, so md5 differs there).
    // A BeatmapID alone is not a chart: rate-variant pack copies ("Far Away 1.15x") and some packs keep one BeatmapID
    // for several charts. So a copy is the same BeatmapID + rate + difficulty name; with no rate known, the same audio file.
    // A chart seen in any held-out entry stays held out.
    const ok = read.filter(Boolean);
    const isExcluded = (c) => exclude.md5.has(c.hash) || (c.beatmapId && exclude.beatmapIds.has(c.beatmapId))
        || (c.setId && exclude.setIds.has(c.setId)) || exclude.names.has(path.basename(c.dir));
    let forced = 0;
    for (const c of ok) if (c.split === "train" && isExcluded(c)) { c.split = "heldout"; c.forcedHeldout = true; forced += 1; }
    const byKey = new Map();
    let dupes = 0;
    for (const c of ok) {
        const key = c.beatmapId ? `b${c.beatmapId}|${c.rate != null ? `r${c.rate}` : `a${c.audioPath}`}|v${c.version}` : `h${c.hash}`;
        const other = byKey.get(key) ?? byKey.get(`h${c.hash}`);
        if (other) {
            dupes += 1;
            if (c.split === "heldout") other.split = "heldout";
            // A tracker dan belongs to one rate: never move it onto a chart of another rate.
            if (other.rawDan == null && c.rawDan != null && (other.rate ?? null) === (c.rate ?? null)) other.rawDan = c.rawDan;
            continue;
        }
        byKey.set(key, c);
        byKey.set(`h${c.hash}`, c);
    }
    let kept = [...new Set(byKey.values())];
    // One song group (corpus `group`, else the beatmap set) never straddles the splits: the same song can sit in several
    // roots (sets/, hf/, the user's Songs). The corpus splits by group, so this is a safety net there.
    const groupOf = (c) => (c.group ? `g:${c.group}` : c.setId ? `s:${c.setId}` : null);
    const heldGroups = new Set(kept.filter((c) => c.split === "heldout" && groupOf(c)).map(groupOf));
    let bySet = 0;
    for (const c of kept) if (c.split === "train" && groupOf(c) && heldGroups.has(groupOf(c))) { c.split = "heldout"; bySet += 1; }
    if (limit > 0) kept = kept.slice(0, limit);

    // A whole audio file goes to one split: held out if any of its charts is held out.
    const groups = new Map();
    for (const c of kept) {
        // Manifest dan by BeatmapID, only for the very difficulty the tracker rated: a rate copy that kept the
        // ranked chart's BeatmapID ("Divine Will 1.05x" vs "[4K] Divine Will") must not take the 1.0x dan.
        const t = c.rawDan == null && c.beatmapId ? tracker.get(c.beatmapId) : null;
        if (t && (t.version ? t.version === c.version : (c.rate ?? 1) === 1)) c.rawDan = t.dan;
        if (!groups.has(c.audioPath)) groups.set(c.audioPath, []);
        groups.get(c.audioPath).push(c);
    }
    const jobs = [];
    for (const [audioPath, maps] of groups) {
        const split = maps.some((m) => m.split === "heldout") ? "heldout" : "train";
        maps.sort((a, b) => a.noteCount - b.noteCount);
        jobs.push({ audioPath, split, maps: maps.map(({ text, ...m }) => ({ ...m, set: m.setName ?? path.basename(m.dir) })) });
    }
    jobs.sort((a, b) => (a.audioPath < b.audioPath ? -1 : 1));
    return { jobs, skipped, dupes, forced, heldBySet: bySet, charts: kept.length };
}

// ---- v3 (mapper3) planning -------------------------------------------------------------------------------------

// Fun labels (tools/fun-labels.py): diff rows by beatmap id, set rows (tracker plays only) by set id.
export async function loadFun(file) {
    const byId = new Map();
    const bySet = new Map();
    if (!file || file === "-") return { byId, bySet };
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) return { byId, bySet };
    for (const r of parseJsonl(text).rows) {
        const { beatmapId, setId, ...fun } = r;
        if (beatmapId) byId.set(Number(beatmapId), fun);
        else if (setId) bySet.set(Number(setId), fun);
    }
    return { byId, bySet };
}

// One chart per corpus line (the corpus already deduped across sources and rates). Quarantine is skipped, --sources
// filters, --limit takes the first N by a hash of the .osu path. Charts of one audio file make one job.
export function planV3(lines, { limit = 0, sources = null, doneIds = new Set() } = {}) {
    const skipped = {};
    let charts = [];
    for (const l of lines) {
        const split = splitOf(l);
        if (!split) { count(skipped, "quarantine"); continue; }
        if (sources && !sources.has(l.source)) { count(skipped, "source not chosen"); continue; }
        const id = sha1(String(l.osu)).slice(0, 16);
        if (doneIds.has(id)) { count(skipped, "built before (--resume)"); continue; }
        charts.push({ id, split, line: l });
    }
    if (limit > 0) charts = charts.sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
    const byAudio = new Map();
    for (const c of charts) {
        const a = String(c.line.audio);
        if (!byAudio.has(a)) byAudio.set(a, []);
        byAudio.get(a).push(c);
    }
    const jobs = [...byAudio].map(([audioPath, maps]) => ({ audioPath, maps })).sort((a, b) => (a.audioPath < b.audioPath ? -1 : 1));
    return { jobs, skipped, charts: charts.length };
}

// Slot / beat column names of a feature set. v3 comes from stream S (src/gen/slotFeatures.js).
export async function featureSet(spec) {
    const sf = await import("../src/gen/slotFeatures.js");
    const { BEAT_FEATURES } = await import("../src/gen/snap.js");
    if (!spec || spec === "v2") return { key: "v2", slot: sf.AUDIO_FEATURES_V2, beat: BEAT_FEATURES };
    if (spec === "v3") {
        const { BEAT_FEATURES_V3 } = await import("../src/gen/beatFeatures.js");
        return { key: "v3", slot: sf.AUDIO_FEATURES_V3, beat: BEAT_FEATURES_V3 };
    }
    const j = JSON.parse(await readFile(spec, "utf8"));
    return { key: path.basename(spec), slot: j.slot ?? j, beat: j.beat ?? BEAT_FEATURES };
}

// ---- workers ---------------------------------------------------------------------------------------------------

async function workerV1(job, mods) {
    const { onsetEnvelope, parseRedTimingPoints, buildSlotsFromTiming, slotFeatures, parseRows, labelSlots, sectionFamily, FAMILIES, analyzeChart } = mods;
    const { outDir } = workerData;
    const done = [];
    const rejected = {};
    const reject = (why) => count(rejected, why);
    const samples = decodeAudio(job.audioPath);
    const envelope = onsetEnvelope(samples, SAMPLE_RATE);
    const audioEndMs = (samples.length / SAMPLE_RATE) * 1000;

    for (const m of job.maps) {
        const osuText = await readFile(m.osuPath, "utf8");
        const rows = parseRows(osuText, 4);
        const points = parseRedTimingPoints(osuText);
        if (!points.length || !rows.length) { reject("no timing or rows"); continue; }
        const endMs = Math.min(audioEndMs - 50, rows.at(-1).t + 1000);
        if (rows.at(-1).t > audioEndMs) { reject("longer than audio / 480 s"); continue; }
        const lead = Math.max(0, rows[0].t - 2000);
        if (timingReject(points, lead, rows.at(-1).t)) { reject("absurd BPM"); continue; }
        const slots = buildSlotsFromTiming(points, endMs).filter((s) => s.t >= lead);
        if (slots.length < 64) { reject("under 64 slots"); continue; }
        const { note, mask, offgrid } = labelSlots(rows, slots);
        if (offgrid / rows.length > 0.5) { reject("off the 1/4 grid"); continue; }

        // Pattern family per 8-beat section, from the rows that fall into it.
        const family = new Uint8Array(slots.length).fill(255);
        for (let a = 0; a < slots.length; a += SECTION_SLOTS) {
            const b = Math.min(slots.length, a + SECTION_SLOTS);
            const t0 = slots[a].t - 12;
            const t1 = (b < slots.length ? slots[b].t : slots[b - 1].t + 1) - 12;
            const inside = rows.filter((r) => r.t >= t0 && r.t < t1);
            const matched = [];
            for (let i = a; i < b; i += 1) if (note[i]) matched.push({ mask: mask[i] });
            const fam = sectionFamily(matched, inside.length ? 1 - matched.length / inside.length : 0);
            if (fam) family.fill(FAMILIES.indexOf(fam), a, b);
        }

        const { rows: feats, names } = slotFeatures(envelope, slots, 60000 / points[0].beatLength);
        if (!allFinite(feats)) { reject("non-finite features"); continue; }
        const analysed = await analyzeChart(osuText, 1);
        if (analysed.kind !== "ok") { reject(`analyzer: ${analysed.kind}`); continue; }
        const id = `${job.index}_${done.length}`;
        await writeFile(path.join(outDir, "maps", `${id}.f32`), Buffer.from(feats.buffer));
        const labels = new Uint8Array(slots.length * 3);
        for (let i = 0; i < slots.length; i += 1) labels.set([note[i], mask[i], family[i]], i * 3);
        await writeFile(path.join(outDir, "maps", `${id}.u8`), Buffer.from(labels.buffer));
        const tracker = Number.isFinite(m.rawDan);
        done.push({
            id, set: m.set, osu: path.basename(m.osuPath), slots: slots.length, features: names.length,
            dan: tracker ? Math.round(m.rawDan * 100) / 100 : analysed.numeric, danSource: tracker ? "tracker" : "analyzer",
            analyzerDan: analysed.numeric, rawDan: tracker ? m.rawDan : null,
            primary: analysed.primary, tech: analysed.tech, offgridShare: offgrid / rows.length,
            bpm: 60000 / points[0].beatLength, split: job.split, forcedHeldout: m.forcedHeldout ?? false,
            beatmapId: m.beatmapId ?? null, setId: m.setId ?? null, source: m.source, group: m.group ?? null, rate: m.rate ?? null,
            danBin: m.danBin ?? null, chartKey: m.chartKey ?? null, osuPath: m.osuPath, audio: job.audioPath,
        });
    }
    return { done, rejected };
}

let v3Extras; // stems + structure + beat features v3, loaded once per worker for --features v3
async function loadV3Extras() {
    if (v3Extras !== undefined) return v3Extras;
    const [{ computeStemsSync }, { songStructure }, { beatFeaturesV3 }, { barsOf }] = await Promise.all([
        import("../src/audio/stems.js"), import("../src/gen/structure.js"), import("../src/gen/beatFeatures.js"), import("../src/gen/songParts.js"),
    ]);
    v3Extras = { computeStemsSync, songStructure, beatFeaturesV3, barsOf };
    return v3Extras;
}

const plainArray = (a) => (a == null ? null : Array.from(a, (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x)));

// The .st.json of one chart. `structure` is songStructure's output (null under --features v2); its bars get the beat
// index of their first slot, from barsOf over the same slots and meter (the bars songStructure cut).
export function structureFile(parts, structure, slots, barsOf) {
    if (!structure) return { v: 2, kind: "parts", meter: null, parts, bars: null, phrases: null, repeats: null, echoOf: null, echoSim: null, novelty: null };
    const cut = barsOf(slots, structure.meter);
    if (cut.length !== structure.bars.length) throw new Error(`structure has ${structure.bars.length} bars, barsOf ${cut.length}`);
    return {
        v: 2, kind: "structure", meter: structure.meter, parts,
        bars: structure.bars.map((b, k) => ({ startMs: b.startMs, endMs: b.endMs, beat: slots[cut[k].i0].beat })),
        phrases: structure.phrases, repeats: structure.repeats,
        echoOf: Array.from(structure.echoOf), echoSim: plainArray(structure.echoSim), novelty: plainArray(structure.novelty),
    };
}

async function workerV3(job, mods) {
    const { onsetEnvelope, parseRedTimingPoints, slotFeatures, parseRows, analyzeChart, beatFeatures, detectParts } = mods;
    const { outDir, names, beatNames, featureKey } = workerData;
    const done = [];
    const rejected = {};
    const rejectedBySource = {};
    const reject = (m, why) => {
        count(rejected, why);
        rejectedBySource[m.line.source] ??= {};
        count(rejectedBySource[m.line.source], why);
    };
    const samples = decodeAudio(job.audioPath);
    const envelope = onsetEnvelope(samples, SAMPLE_RATE);
    const audioEndMs = (samples.length / SAMPLE_RATE) * 1000;
    const extras = featureKey === "v3" ? await loadV3Extras() : null;
    const stems = extras ? extras.computeStemsSync(samples, SAMPLE_RATE) : null;

    for (const m of job.maps) {
        const l = m.line;
        const osuText = await readFile(l.osu, "utf8");
        const rows = parseRows(osuText, 4);
        const points = parseRedTimingPoints(osuText);
        if (!points.length || !rows.length) { reject(m, "no timing or rows"); continue; }
        if (rows.at(-1).t > audioEndMs) { reject(m, "longer than audio / 480 s"); continue; }
        const endMs = Math.min(audioEndMs - 50, rows.at(-1).t + 1000);
        const g = gridLabels(rows, points, endMs);
        if (g.reject) { reject(m, g.reject); continue; }
        const bpm = 60000 / points[0].beatLength;
        const S = g.slots.length;
        const T = g.beats.length;
        let k = 0;
        const parts = detectParts(envelope, g.slots).map((p) => {
            while (k < S && g.slots[k].t < p.startMs) k++;
            return { ...p, beat: k < S ? g.slots[k].beat : T };
        });
        const structure = extras ? extras.songStructure({ stems, slots: g.slots, parts, envelope }) : null;
        if (extras && !structure) { reject(m, "no structure"); continue; }
        const feats = extras ? slotFeatures(envelope, g.slots, bpm, names, { stems, structure }).rows : slotFeatures(envelope, g.slots, bpm, names).rows;
        if (!allFinite(feats)) { reject(m, "non-finite features"); continue; }
        const beatRows = extras ? extras.beatFeaturesV3(envelope, g.beats, { stems, structure }).rows : beatFeatures(envelope, g.beats).rows;
        if (beatRows.length !== g.beats.length * beatNames.length) throw new Error(`beat features: ${beatRows.length} values for ${g.beats.length} beats × ${beatNames.length}`);
        if (!allFinite(beatRows)) { reject(m, "non-finite features"); continue; }
        const analysed = await analyzeChart(osuText, 1);
        if (analysed.kind !== "ok") { reject(m, `analyzer: ${analysed.kind}`); continue; }

        const u8 = new Uint8Array(S * 4);
        const t32 = new Float32Array(S);
        for (let i = 0; i < S; i++) {
            u8[i * 4] = g.note[i]; u8[i * 4 + 1] = g.mask[i]; u8[i * 4 + 2] = g.family[i]; u8[i * 4 + 3] = g.slotDiv[i];
            t32[i] = g.slots[i].t;
        }
        const st = structureFile(parts, structure, g.slots, extras?.barsOf);
        const base = path.join(outDir, mapBase(m.id));
        await mkdir(path.dirname(base), { recursive: true });
        await writeFile(`${base}.f32`, Buffer.from(feats.buffer, feats.byteOffset, feats.byteLength));
        await writeFile(`${base}.u8`, Buffer.from(u8.buffer));
        await writeFile(`${base}.t32`, Buffer.from(t32.buffer));
        await writeFile(`${base}.b32`, Buffer.from(beatRows.buffer, beatRows.byteOffset, beatRows.byteLength));
        await writeFile(`${base}.bd8`, Buffer.from(g.divs.buffer, g.divs.byteOffset, g.divs.byteLength));
        await writeFile(`${base}.bs32`, Buffer.from(g.beatSlot0.buffer));
        await writeFile(`${base}.st.json`, JSON.stringify(st));

        const labels = l.labels ?? {};
        const bpms = new Set(points.map((p) => Math.round((60000 / p.beatLength) * 100)));
        done.push({
            id: m.id, source: l.source, osuPath: l.osu, audioPath: l.audio, set: path.basename(path.dirname(l.osu)), version: l.version,
            songKey: l.songKey, songGroup: l.group, chartKey: l.chartKey, audioKey: l.audioKey, beatmapId: l.beatmapId ?? null,
            beatmapSetId: l.beatmapSetId ?? null, rate: l.rate ?? 1, rateFrom: l.rateFrom ?? null, packId: l.pack ?? null, creatorKey: l.creatorKey ?? null,
            creatorName: l.creator ?? null, year: l.year ?? null, ranked: !!l.ranked, split: m.split,
            slots: S, beats: T, features: names.length, beatFeatures: beatNames.length,
            bpm: round(bpm, 3), multiBpm: bpms.size > 1, lnShare: l.lnShare ?? null,
            residualOffgrid: round(g.residualOffgrid), offBeatShare: round(g.offBeatShare), divShare: g.divShare,
            danOurs: analysed.numeric, primaryOurs: analysed.primary ?? null,
            danTracker: Number.isFinite(labels.rawDan) ? labels.rawDan : null, primaryTracker: labels.trackerPrimary ?? null,
            msdOurs: msdOursVector(analysed.msd), msdTracker: msdTrackerVector(labels.trackerMsd), msdEtterna: msdEtternaVector(labels.etternaMsd),
            msdOverall: analysed.msd?.overall ?? null, playCount: labels.playcount ?? null, fun: m.fun ?? null,
            corpusWeight: l.weight ?? null, weight: null,
        });
    }
    return { done, rejected, rejectedBySource };
}

async function worker() {
    const [{ onsetEnvelope }, grid, sf, rowsMod, { analyzeChart }, { beatFeatures }, { detectParts }] = await Promise.all([
        import("../src/audio/onset.js"), import("../src/gen/grid.js"), import("../src/gen/slotFeatures.js"),
        import("../src/gen/mapRows.js"), import("../src/core/analyze.js"), import("../src/gen/snap.js"), import("../src/gen/songParts.js"),
    ]);
    const mods = {
        onsetEnvelope, parseRedTimingPoints: grid.parseRedTimingPoints, buildSlotsFromTiming: grid.buildSlotsFromTiming,
        slotFeatures: sf.slotFeatures, parseRows: rowsMod.parseRows, labelSlots: rowsMod.labelSlots, sectionFamily: rowsMod.sectionFamily,
        FAMILIES: rowsMod.FAMILIES, analyzeChart, beatFeatures, detectParts,
    };
    parentPort.on("message", async (job) => {
        if (job === "stop") process.exit(0);
        try {
            const r = workerData.format === "v3" ? await workerV3(job, mods) : await workerV1(job, mods);
            parentPort.postMessage({ ok: true, ...r });
        } catch (error) {
            parentPort.postMessage({ ok: false, error: String(error?.message ?? error), done: [], rejected: {} });
        }
    });
}

function runPool({ jobs, workers, data, onResult, log }) {
    let next = 0;
    let finished = 0;
    const t1 = Date.now();
    return Promise.all(Array.from({ length: Math.max(1, Math.min(workers, jobs.length)) }, () => new Promise((resolve) => {
        const w = new Worker(fileURLToPath(import.meta.url), { workerData: data });
        const feed = () => {
            if (next >= jobs.length) {
                w.postMessage("stop");
                return resolve();
            }
            w.postMessage(jobs[next++]);
        };
        w.on("message", async (msg) => {
            finished += 1;
            await onResult(msg);
            if (finished % 25 === 0) log(`${finished}/${jobs.length} audio, ${((Date.now() - t1) / 60000).toFixed(1)} min`);
            feed();
        });
        w.on("error", (e) => { log(`worker error ${e.message}`); resolve(); });
        feed();
    })));
}

// ---- main ------------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
    const o = { workers: 10, limit: 0, manifest: "A:/SneezeyTrain/manifest.json", heldoutFeatures: true, resume: false, format: "v1", features: "v2", sources: null, fun: DEFAULT_FUN };
    if (argv[0] && !argv[0].startsWith("--")) {
        const [songs, out = "data/mapper", workers = "10", limit = "0"] = argv;
        return { ...o, songs, out, workers: Number(workers), limit: Number(limit), manifest: null };
    }
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const v = () => argv[++i];
        if (a === "--corpus") o.corpus = v();
        else if (a === "--out") o.out = v();
        else if (a === "--workers") o.workers = Number(v());
        else if (a === "--limit") o.limit = Number(v());
        else if (a === "--format") o.format = v();
        else if (a === "--features") o.features = v();
        else if (a === "--sources") o.sources = new Set(v().split(",").map((s) => s.trim()).filter(Boolean));
        else if (a === "--fun") o.fun = v();
        else if (a === "--manifest") o.manifest = v() || null;
        else if (a === "--no-manifest") o.manifest = null;
        else if (a === "--exclude") o.exclude = v();
        else if (a === "--exclude-root") o.excludeRoot = v();
        else if (a === "--resume") o.resume = true;
        else if (a === "--no-heldout-features") o.heldoutFeatures = false;
        else if (a === "--dry-run") o.dryRun = true;
        else throw new Error(`unknown option ${a}`);
    }
    if (!["v1", "v3"].includes(o.format)) throw new Error(`--format v1|v3, not ${o.format}`);
    if (!o.corpus || !o.out) throw new Error("need --corpus <corpus.jsonl> and --out <dir>");
    return o;
}

const readIndex = async (p) => parseJsonl(await readFile(p, "utf8").catch(() => "")).rows;
const appendLines = (file, rows) => (rows.length ? appendFile(file, rows.map((d) => `${jsonLine(d)}\n`).join("")) : null);

async function mainV1(opt) {
    const outDir = opt.out;
    await mkdir(path.join(outDir, "maps"), { recursive: true });
    const { AUDIO_FEATURES } = await import("../src/gen/slotFeatures.js");
    await writeFile(path.join(outDir, "feature_names.json"), JSON.stringify(AUDIO_FEATURES));

    const t0 = Date.now();
    const { entries, bad } = opt.songs ? { entries: await legacyEntries(opt.songs), bad: 0 } : await loadCorpus(opt.corpus);
    const charts = await expandEntries(entries, opt.corpus ? path.dirname(path.resolve(opt.corpus)) : process.cwd());
    const exclude = await exclusionKeys(opt.exclude, opt.excludeRoot);
    const tracker = await trackerDans(opt.manifest);
    const planned = await planV1(charts, { exclude, tracker, limit: opt.limit });
    if (charts.quarantined) planned.skipped.quarantine = charts.quarantined;
    let jobs = planned.jobs.map((j, index) => ({ ...j, index }));
    if (!opt.heldoutFeatures) jobs = jobs.filter((j) => j.split === "train");
    const countMaps = (js, split) => js.filter((j) => j.split === split).reduce((s, j) => s + j.maps.length, 0);
    console.log(`corpus lines ${entries.length} (${bad} unparsable), .osu candidates ${charts.length}, usable charts ${planned.charts}, duplicates dropped ${planned.dupes}, forced to held-out ${planned.forced} (excluded list) + ${planned.heldBySet} (set held out elsewhere)`);
    console.log(`skipped: ${JSON.stringify(planned.skipped)}`);
    console.log(`audio files ${jobs.length}: train charts ${countMaps(jobs, "train")}, held-out charts ${countMaps(jobs, "heldout")}, with tracker dan ${jobs.reduce((s, j) => s + j.maps.filter((m) => Number.isFinite(m.rawDan)).length, 0)} (scan ${((Date.now() - t0) / 1000).toFixed(0)} s)`);

    const indexPath = path.join(outDir, "index.jsonl");
    const heldIndexPath = path.join(outDir, "index-heldout.jsonl");
    let doneAudio = new Set();
    let indexBase = 0;
    if (opt.resume) {
        const prev = [...(await readIndex(indexPath)), ...(await readIndex(heldIndexPath))];
        doneAudio = new Set(prev.map((m) => m.audio));
        indexBase = prev.reduce((mx, m) => Math.max(mx, Number(String(m.id).split("_")[0]) + 1), 0);
        console.log(`resume: ${prev.length} charts from ${doneAudio.size} audio files already built`);
    } else if (!opt.dryRun) {
        await writeFile(indexPath, "");
        await writeFile(heldIndexPath, "");
    }
    jobs = jobs.filter((j) => !doneAudio.has(j.audioPath)).map((j, k) => ({ ...j, index: indexBase + k }));

    // Held-out list from the plan (whether or not their features get built): set folder names, set ids, beatmap ids.
    // Legacy mode (positional Songs root) has no held-out split and never wrote these files: leave an existing
    // heldout.json alone there (tools/eval-generator.mjs reads it from data/mapper).
    const heldMaps = planned.jobs.filter((j) => j.split === "heldout").flatMap((j) => j.maps);
    const heldSets = [...new Set(heldMaps.map((m) => m.set))].sort();
    if (!opt.dryRun && !opt.songs) {
        await writeFile(path.join(outDir, "heldout.json"), JSON.stringify(heldSets, null, 0));
        await writeFile(path.join(outDir, "heldout-ids.json"), JSON.stringify({
            setIds: [...new Set(heldMaps.map((m) => m.setId).filter(Boolean))].sort((a, b) => a - b),
            beatmapIds: [...new Set(heldMaps.map((m) => m.beatmapId).filter(Boolean))].sort((a, b) => a - b),
            groups: [...new Set(heldMaps.map((m) => m.group).filter(Boolean))].sort(),
            osuPaths: heldMaps.map((m) => m.osuPath),
        }));
    }
    if (opt.dryRun) return;

    let audio = 0;
    let mapsDone = 0;
    let failed = 0;
    const rejected = {};
    const errors = [];
    await runPool({
        jobs, workers: opt.workers, data: { outDir, format: "v1" }, log: console.log,
        onResult: async (msg) => {
            audio += 1;
            if (!msg.ok) { failed += 1; if (errors.length < 50) errors.push(msg.error); }
            for (const [k, v] of Object.entries(msg.rejected ?? {})) rejected[k] = (rejected[k] ?? 0) + v;
            mapsDone += msg.done.length;
            await appendLines(indexPath, msg.done.filter((d) => d.split === "train"));
            await appendLines(heldIndexPath, msg.done.filter((d) => d.split !== "train"));
        },
    });
    const train = await readIndex(indexPath);
    const held = await readIndex(heldIndexPath);
    const report = {
        finishedAt: new Date().toISOString(), corpus: opt.corpus ?? opt.songs, limit: opt.limit, audio, failedAudio: failed,
        charts: mapsDone, rejected, skippedAtScan: planned.skipped, duplicatesDropped: planned.dupes, forcedHeldout: planned.forced, heldBySet: planned.heldBySet,
        index: { train: train.length, heldout: held.length, trainTracker: train.filter((m) => m.danSource === "tracker").length,
            heldoutTracker: held.filter((m) => m.danSource === "tracker").length }, heldoutSets: heldSets.length, errors,
        minutes: (Date.now() - t0) / 60000,
    };
    await writeFile(path.join(outDir, "build-report.json"), JSON.stringify(report, null, 1));
    console.log(`done: ${mapsDone} charts from ${audio} audio files (${failed} failed), index ${train.length} train / ${held.length} held-out, rejected ${JSON.stringify(rejected)}, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

const danBinOf = (d) => (Number.isFinite(d) ? `dan:${String(Math.max(0, Math.min(20, Math.floor(d)))).padStart(2, "0")}` : "none");

// Training weights over the built maps, per split, with dan bins from our own dan (src/corpus/weights.js).
export function datasetWeights(rows) {
    const stats = {};
    for (const split of ["train", "val", "test"]) {
        const members = rows.filter((r) => r.split === split);
        const res = corpusWeights(members.map((r) => ({
            group: r.songGroup, source: r.source, ranked: r.ranked, pack: r.packId, creator: r.creatorKey, bin: danBinOf(r.danOurs),
        })));
        members.forEach((r, i) => { r.weight = Number(res.weights[i].toPrecision(5)); });
        stats[split] = { maps: members.length, capsHeld: res.capsHeld, rounds: res.rounds, ...Object.fromEntries(Object.entries(res.stats).map(([k, v]) => [k, round(v, 4)])) };
    }
    return stats;
}

// report.json of mapper3: what was built from each source and why the rest was not, MSD calibration, creators, bins.
export function reportV3(rows, { rejected, rejectedBySource, skipped, failed, errors, minutes, opt, weightStats, planned }) {
    const blank = () => ({ built: 0, train: 0, val: 0, test: 0, slots: 0, beats: 0, rejected: {} });
    const bySource = {};
    for (const r of rows) {
        const s = (bySource[r.source] ??= blank());
        s.built++; s[r.split]++; s.slots += r.slots; s.beats += r.beats;
    }
    for (const [src, rej] of Object.entries(rejectedBySource)) (bySource[src] ??= blank()).rejected = rej;
    const mae = (pairs) => (pairs.length ? round(pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / pairs.length, 3) : null);
    const etterna = rows.filter((r) => r.msdEtterna?.[0] != null && r.msdOurs?.[0] != null).map((r) => [r.msdOurs[0], r.msdEtterna[0]]);
    const tracker = rows.filter((r) => r.msdTracker?.[0] != null && r.msdOurs?.[0] != null).map((r) => [r.msdOurs[0], r.msdTracker[0]]);
    const danPairs = rows.filter((r) => Number.isFinite(r.danTracker) && Number.isFinite(r.danOurs)).map((r) => [r.danOurs, r.danTracker]);
    const creators = new Map();
    for (const r of rows) {
        if (!r.creatorKey || r.split !== "train") continue;
        const c = creators.get(r.creatorKey) ?? { name: r.creatorName, maps: 0, groups: new Set() };
        c.maps++; c.groups.add(r.songGroup);
        creators.set(r.creatorKey, c);
    }
    const eligible = [...creators].filter(([, c]) => c.maps >= 30 && c.groups.size >= 8)
        .sort((a, b) => b[1].maps - a[1].maps).map(([key, c]) => ({ key, name: c.name, maps: c.maps, groups: c.groups.size }));
    const bins = {};
    for (const r of rows) bins[danBinOf(r.danOurs)] = (bins[danBinOf(r.danOurs)] ?? 0) + 1;
    const div = { 4: 0, 3: 0, 6: 0, 8: 0, 0: 0 };
    let beats = 0;
    for (const r of rows) { for (const k of Object.keys(div)) div[k] += (r.divShare?.[k] ?? 0) * r.beats; beats += r.beats; }
    for (const k of Object.keys(div)) div[k] = round((100 * div[k]) / Math.max(1, beats), 2);
    return {
        format: "mapper3", finishedAt: new Date().toISOString(), corpus: opt.corpus, features: opt.features, limit: opt.limit, minutes: round(minutes, 2),
        planned: planned.charts, built: rows.length, failedAudio: failed, errors, rejected, skippedAtPlan: skipped,
        splits: { train: rows.filter((r) => r.split === "train").length, val: rows.filter((r) => r.split === "val").length, test: rows.filter((r) => r.split === "test").length },
        slots: rows.reduce((s, r) => s + r.slots, 0), beats,
        bySource,
        msdCalibration: {
            note: "MAE of msdOurs.overall against Etterna's / the tracker's overall; above 1.5 against Etterna = stop and report (§3.4)",
            etternaMae: mae(etterna), etternaPairs: etterna.length, trackerMae: mae(tracker), trackerPairs: tracker.length,
        },
        danCalibration: { trackerVsOursMae: mae(danPairs), pairs: danPairs.length },
        creators: { known: creators.size, eligibleStyles: eligible.length, eligible: eligible.slice(0, 100) },
        danBinsOurs: Object.fromEntries(Object.entries(bins).sort()),
        danBinGate: Object.fromEntries(Array.from({ length: 16 }, (_, i) => danBinOf(i + 3)).map((b) => [b, (bins[b] ?? 0) >= 150])),
        divisorPercent: div,
        fun: { withFun: rows.filter((r) => r.fun).length },
        weights: weightStats,
    };
}

async function mainV3(opt) {
    const t0 = Date.now();
    const outDir = opt.out;
    await mkdir(path.join(outDir, "maps"), { recursive: true });
    const fs = await featureSet(opt.features);
    const namesFile = path.join(outDir, "feature_names.json");
    const prevNames = await readFile(namesFile, "utf8").then(JSON.parse).catch(() => null);
    if (opt.resume && prevNames && JSON.stringify(prevNames) !== JSON.stringify(fs.slot)) throw new Error(`--resume with other features than ${namesFile}`);
    await writeFile(namesFile, JSON.stringify(fs.slot));
    await writeFile(path.join(outDir, "beat_feature_names.json"), JSON.stringify(fs.beat));
    await writeFile(path.join(outDir, "format.json"), JSON.stringify({
        format: "mapper3", version: 3, featureSet: fs.key, msd: MSD8,
        files: { f32: "Float32[slots x features]", u8: "Uint8[slots x 4] note,mask,family,div", t32: "Float32[slots] ms",
            b32: "Float32[beats x beatFeatures]", bd8: "Uint8[beats] divisor label (0 = none)", bs32: "Int32[beats+1] CSR slot offsets",
            "st.json": "structure" },
        layout: "maps/<id[0:2]>/<id>.<ext>; see the header of tools/build-mapper-dataset.mjs",
    }, null, 1));

    const { entries, bad } = await loadCorpus(opt.corpus);
    const indexPath = path.join(outDir, "index.jsonl");
    const doneIds = new Set();
    if (opt.resume) for (const r of await readIndex(indexPath)) doneIds.add(r.id);
    else if (!opt.dryRun) await writeFile(indexPath, "");
    const planned = planV3(entries, { limit: opt.limit, sources: opt.sources, doneIds });
    const fun = await loadFun(opt.fun);
    for (const j of planned.jobs) {
        for (const m of j.maps) {
            const l = m.line;
            m.fun = (l.beatmapId && fun.byId.get(Number(l.beatmapId))) || (l.beatmapSetId && fun.bySet.get(Number(l.beatmapSetId))) || null;
            m.line = { ...l, duplicates: undefined };
        }
    }
    if (!opt.dryRun) await writeFile(path.join(outDir, "heldout.json"), JSON.stringify(heldoutList(entries)));
    console.log(`corpus lines ${entries.length} (${bad} unparsable), charts to build ${planned.charts} from ${planned.jobs.length} audio files, skipped ${JSON.stringify(planned.skipped)}, fun labels ${fun.byId.size} diffs (${opt.fun})`);
    if (opt.dryRun) return;

    let failed = 0;
    const rejected = {};
    const rejectedBySource = {};
    const errors = [];
    let built = 0;
    await runPool({
        jobs: planned.jobs, workers: opt.workers, log: console.log,
        data: { outDir, format: "v3", names: fs.slot, beatNames: fs.beat, featureKey: fs.key },
        onResult: async (msg) => {
            if (!msg.ok) { failed += 1; if (errors.length < 50) errors.push(msg.error); }
            for (const [k, v] of Object.entries(msg.rejected ?? {})) rejected[k] = (rejected[k] ?? 0) + v;
            for (const [src, rej] of Object.entries(msg.rejectedBySource ?? {})) {
                rejectedBySource[src] ??= {};
                for (const [k, v] of Object.entries(rej)) rejectedBySource[src][k] = (rejectedBySource[src][k] ?? 0) + v;
            }
            built += msg.done.length;
            await appendLines(indexPath, msg.done);
        },
    });
    // weights need every built map of a split: rewrite the index once at the end
    const rows = await readIndex(indexPath);
    const weightStats = datasetWeights(rows);
    // On a small split (a --limit slice) the pack / creator / dan-bin caps often cannot all hold: corpusWeights stops at
    // the stall (capsHeld false) with the capped groups at equal shares. Not an error; logged so it is not missed.
    for (const [split, s] of Object.entries(weightStats)) {
        if (s.maps && !s.capsHeld) console.log(`weights: the caps cannot all hold on the ${split} split (${s.maps} maps): stopped after ${s.rounds} rounds (max pack share ${s.maxPackShare}, creator ${s.maxCreatorShare}, dan bin ratio ${s.maxBinRatio})`);
    }
    await writeFile(`${indexPath}.tmp`, rows.map((r) => `${jsonLine(r)}\n`).join(""));
    await rename(`${indexPath}.tmp`, indexPath);
    const report = reportV3(rows, {
        rejected, rejectedBySource, skipped: planned.skipped, failed, errors, minutes: (Date.now() - t0) / 60000,
        opt: { ...opt, sources: opt.sources ? [...opt.sources] : null }, weightStats, planned,
    });
    await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 1));
    console.log(`done: ${built} charts built now, ${rows.length} in the index (${JSON.stringify(report.splits)}), ${failed} audio failed, rejected ${JSON.stringify(rejected)}, MSD MAE vs Etterna ${report.msdCalibration.etternaMae} (${report.msdCalibration.etternaPairs} pairs), ${report.minutes} min`);
}

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
    const opt = parseArgs(process.argv.slice(2));
    await (opt.format === "v3" ? mainV3(opt) : mainV1(opt));
} else if (!isMainThread && workerData?.outDir) {
    await worker();
}
