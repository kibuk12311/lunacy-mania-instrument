// Held-out songs for the model comparison: the assertion that every evaluated chart is on the held-out side of the
// training split (plan §10 Gate 0), the held-out pool from a corpus index, the stratified 180-song pick (plan D5:
// dan 3–18 × 5 families, ≥ 30 variable-BPM and ≥ 30 off-1/4 songs, an osu!-source share for the osu!-only view),
// and the per-chart labels the pick needs.
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { parseRedTimingPoints, timingFromPoints, sectionsToPoints, timingSections, beatsFromTiming } from "../../src/gen/grid.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { familyOf, beatGridStats } from "./compare.mjs";

// Sources whose charts are osu! maps (the osu!-only view); etterna and malody are converts.
export const OSU_SOURCES = new Set(["hf", "sets", "songs", "packs", "ranked"]);
export const isOsuSource = (s) => OSU_SOURCES.has(s);
export const normPath = (p) => String(p).replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
const sha1 = (x) => createHash("sha1").update(x).digest("hex");

async function* jsonLines(file) {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
        if (line.trim()) yield JSON.parse(line);
    }
}

// The split files every held-out check reads by default: the corpus, and the training sets of every candidate model
// that exist on this machine — mapper15 (v1.5: index.jsonl is its train split, index-heldout.jsonl its held-out) and
// mapper3 (mapper3/heldout.json, the one held-out list of dataset v3 that every wave-3 stream reads, and its
// index.jsonl). A pick passes only when no file puts it, its chart key or its song group on a training side.
export const CANDIDATE_SPLITS = [
    "A:/SneezeyTrain/mapper15/index.jsonl",
    "A:/SneezeyTrain/mapper15/index-heldout.jsonl",
    "A:/SneezeyTrain/mapper3/heldout.json",
    "A:/SneezeyTrain/mapper3/index.jsonl",
];
export function defaultSplitFiles(corpus, { extra = CANDIDATE_SPLITS, exists = existsSync } = {}) {
    return [corpus, ...extra.filter((f) => exists(f))];
}

// A split as this check ranks it: held out, quarantine, val (tuned on: never evaluated on), train.
export function normSplit(s) {
    const v = String(s ?? "").toLowerCase();
    if (v === "heldout" || v === "test" || v === "held-out") return "heldout";
    if (v === "val" || v === "valid" || v === "validation") return "val";
    return v || null;
}

// Split index from JSONL files whose lines carry a `split` (corpus.jsonl, mapper15/mapper3 index*.jsonl) and from
// mapper3/heldout.json ({ test, val, quarantine: [{ group, songKeys }] }): by normalised .osu path (duplicates
// included), by chartKey and by song group (and song key). mapper3's "test" counts as held out, "val" does not.
export async function loadSplitIndex(files) {
    const byPath = new Map();
    const byChartKey = new Map();
    const byGroup = new Map();
    const rank = { heldout: 0, quarantine: 1, val: 2, train: 3 }; // a key seen on two sides counts as the worse one
    const put = (map, key, entry) => {
        if (!key) return;
        const old = map.get(key);
        if (!old || (rank[entry.split] ?? 4) > (rank[old.split] ?? 4)) map.set(key, entry);
    };
    for (const file of files) {
        if (/\.json$/i.test(file)) {
            const list = JSON.parse(await readFile(file, "utf8"));
            for (const [side, split] of [["test", "heldout"], ["val", "val"], ["quarantine", "quarantine"]]) {
                for (const g of list[side] ?? []) {
                    const entry = { split, group: g.group ?? null, source: null };
                    put(byGroup, g.group, entry);
                    for (const k of g.songKeys ?? []) put(byGroup, k, entry);
                }
            }
            continue;
        }
        for await (const c of jsonLines(file)) {
            const split = normSplit(c.split);
            if (!split) continue;
            const group = c.group ?? c.songGroup ?? null;
            const entry = { split, group, source: c.source ?? null };
            put(byPath, normPath(c.osuPath ?? c.osu ?? ""), entry);
            for (const d of c.duplicates ?? []) put(byPath, normPath(d.osuPath ?? d.osu ?? ""), entry);
            put(byChartKey, c.chartKey, entry);
            put(byGroup, group, entry);
        }
    }
    return { byPath, byChartKey, byGroup, files };
}

// Is one corpus line (or pick) held out in every split file of the index? (path, chart key, group and song key)
export function isHeldoutIn(index, c) {
    const entries = [
        index.byPath.get(normPath(c.osuPath ?? c.osu ?? "")),
        ...(c.duplicates ?? []).map((d) => index.byPath.get(normPath(d.osuPath ?? d.osu ?? ""))),
        c.chartKey ? index.byChartKey.get(c.chartKey) : null,
        c.group ? index.byGroup.get(c.group) : null,
        c.songKey ? index.byGroup.get(c.songKey) : null,
    ].filter(Boolean);
    for (const e of [...entries]) if (e.group) entries.push(index.byGroup.get(e.group));
    return entries.length > 0 && entries.every((e) => !e || e.split === "heldout");
}

// Every pick must be found (by path, else chart key, else song group) and be held out. chartKeyOf(pick) may supply
// the chart key from the pick's own .osu when the pick has none.
export function checkHeldout(picks, index, { chartKeyOf = null } = {}) {
    const problems = [];
    let ok = 0;
    for (const [i, pick] of picks.entries()) {
        let entry = index.byPath.get(normPath(pick.osuPath ?? pick.osu ?? ""));
        const key = pick.chartKey ?? pick.id ?? null;
        if (!entry && key) entry = index.byChartKey.get(key);
        if (!entry && chartKeyOf) entry = index.byChartKey.get(chartKeyOf(pick));
        if (!entry && pick.group) entry = index.byGroup.get(pick.group);
        // a chart found by path or key still loses when its group (or the pick's own group) sits on another side
        // somewhere, and so does a pick whose path is held out in one file while another file trained on it
        const sides = [entry, entry?.group ? index.byGroup.get(entry.group) : null, pick.group ? index.byGroup.get(pick.group) : null,
            key ? index.byChartKey.get(key) : null].filter(Boolean);
        const worse = sides.find((e) => e.split !== "heldout");
        const split = worse ? worse.split : entry?.split;
        if (split === "heldout") ok += 1;
        else problems.push({ i, osuPath: pick.osuPath ?? pick.osu, reason: split ?? "not in the split index" });
    }
    return { ok, problems };
}

export function requireHeldout(picks, index, opts) {
    const r = checkHeldout(picks, index, opts);
    if (r.problems.length) {
        const list = r.problems.slice(0, 10).map((p) => `  #${p.i} ${p.reason}: ${p.osuPath}`).join("\n");
        throw new Error(`held-out check failed: ${r.problems.length} of ${picks.length} picks are not held out\n${list}`);
    }
    return r;
}

// One chart per held-out song group (rate 1 first, then osu! sources, then a seeded hash), groups in seeded order.
export function heldoutPool(lines, { seed = "v-heldout-1" } = {}) {
    const groups = new Map();
    for (const c of lines) {
        if (c.split !== "heldout" || !c.group) continue;
        if (!groups.has(c.group)) groups.set(c.group, []);
        groups.get(c.group).push(c);
    }
    const one = (c) => Math.abs((c.rate ?? 1) - 1) < 1e-9;
    const out = [];
    for (const [group, list] of groups) {
        const best = [...list].sort((a, b) => (one(b) - one(a)) || (isOsuSource(b.source) - isOsuSource(a.source))
            || (sha1(`${seed}|${a.osu}`) < sha1(`${seed}|${b.osu}`) ? -1 : 1))[0];
        out.push({ ...best, group, order: sha1(`${seed}|${group}`) });
    }
    return out.sort((a, b) => (a.order < b.order ? -1 : 1));
}

// maxSpanMs leaves out long charts (marathons) before a group picks its chart. `index` (loadSplitIndex over the
// candidates' split files, defaultSplitFiles): a line any candidate trained on (by path, duplicate, chart key, group or
// song key) never enters the pool; `dropped` counts them.
export async function readHeldoutPool(corpusFile, { maxSpanMs = Infinity, index = null, ...opts } = {}) {
    const lines = [];
    let dropped = 0;
    for await (const c of jsonLines(corpusFile)) {
        if (c.split !== "heldout" || c.spanMs > maxSpanMs) continue;
        if (index && !isHeldoutIn(index, c)) { dropped += 1; continue; }
        lines.push({ source: c.source, osu: c.osu, audio: c.audio, group: c.group, rate: c.rate, chartKey: c.chartKey, songKey: c.songKey, bpm: c.bpm, spanMs: c.spanMs, labels: c.labels, split: c.split });
    }
    const pool = heldoutPool(lines, opts);
    pool.dropped = dropped;
    return pool;
}

export const STRATA_FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack"];
const OFF_QUARTER_MIN = 0.1;

// Stratified pick from labelled candidates { group, source, dan, family, variable, offQuarter } (one per group):
// first the variable-BPM and off-1/4 quotas, then the osu!-source share, then the rest, each time from the dan
// bin × family cell with the fewest picks so far (ties: lower bin, the candidates' own order). Returns
// { picks, notes } where notes list quotas the candidates could not meet.
export function selectHeldout(cands, { n = 180, danLo = 3, danHi = 18, minVariable = 30, minTriplet = 30, osuShare = 0.5 } = {}) {
    const pool = cands.filter((c) => Number.isFinite(c.dan) && Math.floor(c.dan) >= danLo && Math.floor(c.dan) <= danHi);
    const bins = Array.from({ length: danHi - danLo + 1 }, (_, k) => danLo + k);
    const fams = [...STRATA_FAMILIES, "other"];
    const cellOf = (c) => `${Math.floor(c.dan)}|${STRATA_FAMILIES.includes(c.family) ? c.family : "other"}`;
    const count = new Map();
    const binCount = new Map();
    const taken = new Set();
    const picks = [];
    const notes = [];
    const take = (c) => {
        taken.add(c.group);
        picks.push(c);
        count.set(cellOf(c), (count.get(cellOf(c)) ?? 0) + 1);
        binCount.set(Math.floor(c.dan), (binCount.get(Math.floor(c.dan)) ?? 0) + 1);
    };
    // lexicographic: fewest picks in the dan bin, then in the cell, then the lower bin, then the family order
    const keyOf = (c) => [binCount.get(Math.floor(c.dan)) ?? 0, count.get(cellOf(c)) ?? 0, bins.indexOf(Math.floor(c.dan)), fams.indexOf(cellOf(c).split("|")[1])];
    const less = (a, b) => {
        for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
        return false;
    };
    const next = (ok) => {
        let best = null;
        let bestKey = null;
        for (const c of pool) {
            if (taken.has(c.group) || !ok(c)) continue;
            const key = keyOf(c);
            if (!bestKey || less(key, bestKey)) {
                best = c;
                bestKey = key;
            }
        }
        return best;
    };
    const fill = (ok, want, what) => {
        let have = picks.filter(ok).length;
        while (have < want && picks.length < n) {
            const c = next(ok);
            if (!c) break;
            take(c);
            have += 1;
        }
        if (have < want) notes.push(`${what}: ${have} of ${want} (the pool has no more)`);
    };
    const isOff = (c) => (c.offQuarter ?? 0) >= OFF_QUARTER_MIN;
    if (minTriplet) fill(isOff, minTriplet, "off-1/4 songs");
    if (minVariable) fill((c) => !!c.variable, minVariable, "variable-BPM songs");
    if (osuShare > 0) fill((c) => isOsuSource(c.source), Math.round(osuShare * n), "osu!-source songs");
    fill(() => true, n, "songs");
    return { picks, notes };
}

// Labels of one human chart: our analyser's dan and pattern family, the BPM (first red line), whether it changes
// BPM, and the shares of its beats that need 1/3, 1/6 or 1/8 (or finer). Null when the analyser cannot read it.
export async function labelChart(text, analyze) {
    const result = await analyze(text, 1).catch(() => null);
    if (result?.kind !== "ok") return null;
    const points = parseRedTimingPoints(text).filter((p) => 60000 / p.beatLength >= 40 && 60000 / p.beatLength <= 400);
    if (!points.length) return null;
    const rows = parseRows(text, 4);
    const timing = timingFromPoints(points);
    const beats = beatsFromTiming(sectionsToPoints(timingSections(timing)), (rows.at(-1)?.t ?? 0) + 1000);
    const grid = beatGridStats(rows, beats);
    const bpms = new Set(points.map((p) => Math.round(6000000 / p.beatLength) / 100));
    return {
        dan: Math.round(result.numeric * 10) / 10,
        primary: result.primary ?? null,
        family: familyOf(result.primary),
        bpm: 60000 / points[0].beatLength,
        red: points.length,
        variable: bpms.size > 1,
        offQuarter: grid.offQuarter,
        triplet: grid.triplet,
        rows: rows.length,
    };
}
