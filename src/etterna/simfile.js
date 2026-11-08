// StepMania / Etterna .sm and .ssc → osu!mania 4K .osu text, one .osu per dance-single chart.
// Timing follows StepMania exactly: beats sit on a 48-rows-per-beat grid, the music time of beat 0 is -#OFFSET,
// #BPMS changes the tempo, a stop pauses AFTER the notes on its beat, a delay pauses BEFORE them.
// osu! time (ms) = (time of the beat - OFFSET) · 1000. Every BPM change, stop and delay gets a red line, so osu!'s
// beat grid stays on the notes after each pause. Charts with warps, negative/zero BPMs or stops, fakes or absurd
// BPMs are skipped with a reason; visual-only effects (#SPEEDS, #SCROLLS) do not move notes and are only noted.
import { createHash } from "node:crypto";

export const ROWS_PER_BEAT = 48;
const ROWS_PER_MEASURE = ROWS_PER_BEAT * 4;
const COLUMNS = 4;
const MAX_BPM = 3000; // above this a "tempo" is a warp trick, not music
const TIMING_TAGS = ["OFFSET", "BPMS", "STOPS", "FREEZES", "DELAYS", "WARPS", "TIMESIGNATURES", "TICKCOUNTS",
    "COMBOS", "SPEEDS", "SCROLLS", "FAKES", "LABELS"];

// Bytes of a simfile → text: UTF-8 when valid, else Shift-JIS (common in older Japanese files), else Windows-1252.
export function decodeSimfile(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
    for (const enc of ["utf-8", "shift_jis"]) {
        try {
            return new TextDecoder(enc, { fatal: true }).decode(body);
        } catch {
            // next encoding
        }
    }
    try {
        return new TextDecoder("windows-1252").decode(body);
    } catch {
        return body.toString("latin1");
    }
}

// StepMania's MSD format: #TAG:param:param;  "//" comments to the end of the line, "\" escapes the next character,
// and a "#" first on a line also ends a tag whose ";" is missing (as StepMania's own reader does).
export function parseMsd(text) {
    const tags = [];
    let cur = null;
    let val = "";
    const n = text.length;
    for (let i = 0; i < n; i += 1) {
        const c = text[i];
        if (c === "/" && text[i + 1] === "/") {
            while (i + 1 < n && text[i + 1] !== "\n") i += 1;
            continue;
        }
        if (!cur) {
            if (c === "#") {
                cur = [];
                val = "";
            }
            continue;
        }
        if (c === "\\" && i + 1 < n) {
            val += text[i + 1];
            i += 1;
        } else if (c === ":") {
            cur.push(val);
            val = "";
        } else if (c === ";") {
            cur.push(val);
            tags.push(cur);
            cur = null;
        } else if (c === "#" && /\n[ \t\r]*$/.test(val)) {
            cur.push(val);
            tags.push(cur);
            cur = [];
            val = "";
        } else val += c;
    }
    if (cur) {
        cur.push(val);
        tags.push(cur);
    }
    return tags.map(([name, ...params]) => ({ name: String(name).trim().toUpperCase(), params }));
}

const clean = (s) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

// { kind: "sm"|"ssc", song: { TAG: value }, charts: [{ tags: { TAG: value }, notes }] }
export function parseSimfile(text, { ext = "" } = {}) {
    const tags = parseMsd(String(text ?? "").replace(/^﻿/, ""));
    const kind = /ssc$/i.test(ext) || tags.some((t) => t.name === "NOTEDATA") ? "ssc" : "sm";
    const song = {};
    const charts = [];
    if (kind === "sm") {
        for (const t of tags) {
            if (t.name === "NOTES") {
                const p = t.params;
                const last = p.length - 1;
                charts.push({
                    tags: { STEPSTYPE: p[0] ?? "", DESCRIPTION: last >= 2 ? p[1] : "", DIFFICULTY: last >= 3 ? p[2] : "", METER: last >= 4 ? p[3] : "" },
                    notes: p[last] ?? "",
                });
            } else if (t.name !== "NOTES2") song[t.name] = t.params.join(":");
        }
        return { kind, song, charts };
    }
    let chart = null;
    for (const t of tags) {
        if (t.name === "NOTEDATA") {
            chart = { tags: {}, notes: null };
            continue;
        }
        if (!chart) {
            song[t.name] = t.params.join(":");
            continue;
        }
        if (t.name === "NOTES" || t.name === "NOTES2") {
            if (t.name === "NOTES") charts.push({ ...chart, notes: t.params.join(":") });
            chart = null;
            continue;
        }
        chart.tags[t.name] = t.params.join(":");
    }
    return { kind, song, charts };
}

function rint(x) {
    // round half to even, as StepMania's lrintf does when beats become rows
    const r = Math.round(x);
    return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
const beatToRow = (beat) => rint(beat * ROWS_PER_BEAT);

function parsePairs(value, what) {
    const out = [];
    for (const item of String(value ?? "").split(",")) {
        const s = item.trim();
        if (!s) continue;
        const [a, b] = s.split("=");
        const beat = Number(a);
        const v = Number(b);
        if (!Number.isFinite(beat) || !Number.isFinite(v)) throw Object.assign(new Error(`bad ${what} entry "${s.slice(0, 40)}"`), { code: "badTiming" });
        out.push({ beat, value: v });
    }
    return out;
}

const fail = (code, detail) => Object.assign(new Error(detail), { code });

// The timing a chart plays with: an .ssc chart with any timing tag of its own uses its own segments
// (offset and BPMs fall back to the song's), as StepMania 5 does.
export function chartTiming(song, chartTags = {}) {
    const own = TIMING_TAGS.some((t) => chartTags[t] !== undefined);
    const src = own ? chartTags : song;
    const pick = (tag) => src[tag];
    return {
        own,
        offset: own && chartTags.OFFSET !== undefined ? chartTags.OFFSET : song.OFFSET,
        bpms: pick("BPMS") ?? (own ? song.BPMS : undefined),
        stops: pick("STOPS") ?? pick("FREEZES"),
        delays: pick("DELAYS"),
        warps: pick("WARPS"),
        fakes: pick("FAKES"),
        speeds: pick("SPEEDS"),
        scrolls: pick("SCROLLS"),
    };
}

// Clock over note rows: timeAt(row) in seconds of music time, and the red lines osu! needs.
export function buildClock(timing) {
    const offset = Number(String(timing.offset ?? "0").trim() || 0);
    if (!Number.isFinite(offset)) throw fail("badTiming", `bad offset "${timing.offset}"`);
    const bpmPairs = parsePairs(timing.bpms, "BPM");
    if (!bpmPairs.length) throw fail("noBpms", "no BPMs");
    for (const { value } of bpmPairs) {
        if (value < 0) throw fail("negativeBpm", `negative BPM ${value} (a warp)`);
        if (value === 0) throw fail("zeroBpm", "BPM of 0");
        if (value > MAX_BPM) throw fail("extremeBpm", `BPM ${value} (a warp trick)`);
    }
    for (const w of parsePairs(timing.warps, "warp")) if (w.value > 0) throw fail("warps", `warp at beat ${w.beat}`);
    for (const f of parsePairs(timing.fakes, "fake")) if (f.value > 0) throw fail("fakes", `fake segment at beat ${f.beat}`);
    const pauses = (value, what, code) => {
        const map = new Map();
        for (const { beat, value: sec } of parsePairs(value, what)) {
            if (sec < 0) throw fail(code, `negative ${what} ${sec} at beat ${beat} (a warp)`);
            const row = beatToRow(beat);
            if (sec > 0 && row >= 0) map.set(row, (map.get(row) ?? 0) + sec);
        }
        return [...map].map(([row, sec]) => ({ row, sec })).sort((a, b) => a.row - b.row);
    };
    const stops = pauses(timing.stops, "stop", "negativeStop");
    const delays = pauses(timing.delays, "delay", "negativeDelay");
    const byRow = new Map();
    for (const { beat, value } of bpmPairs) byRow.set(Math.max(0, beatToRow(beat)), value); // same row: last wins
    const segs = [...byRow].map(([row, bpm]) => ({ row, bpm })).sort((a, b) => a.row - b.row);
    segs[0].row = 0; // the first tempo also covers everything before it
    let acc = 0;
    for (let k = 0; k < segs.length; k += 1) {
        if (k > 0) acc += ((segs[k].row - segs[k - 1].row) / ROWS_PER_BEAT) * (60 / segs[k - 1].bpm);
        segs[k].start = acc;
    }
    const lastAtOrBefore = (list, row) => {
        let lo = 0;
        let hi = list.length - 1;
        let ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].row <= row) {
                ans = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        return ans;
    };
    const prefix = (list) => {
        const p = [0];
        for (const x of list) p.push(p.at(-1) + x.sec);
        return p;
    };
    const stopSum = prefix(stops);
    const delaySum = prefix(delays);
    const segAt = (row) => segs[Math.max(0, lastAtOrBefore(segs, row))];
    // stops count only for notes after their row, delays already for notes on it
    const timeAt = (row) => {
        const s = segAt(row);
        const beatsSec = s.start + ((row - s.row) / ROWS_PER_BEAT) * (60 / s.bpm);
        const iStop = lastAtOrBefore(stops, row - 1);
        const iDelay = lastAtOrBefore(delays, row);
        return beatsSec + stopSum[iStop + 1] + delaySum[iDelay + 1] - offset;
    };
    const stopAtRow = new Map(stops.map((s) => [s.row, s.sec]));
    const delayRows = new Set(delays.map((d) => d.row));
    const rows = [...new Set([...segs.map((s) => s.row), ...stops.map((s) => s.row), ...delays.map((d) => d.row)])].sort((a, b) => a - b);
    // beat 0 first (notes on it sit before a stop there), then a line after every tempo change and every pause
    const lines = [{ row: 0, sec: timeAt(0), bpm: segs[0].bpm }];
    for (const row of rows) {
        const bpm = segAt(row).bpm;
        const shifted = stopAtRow.has(row) || (delayRows.has(row) && row > 0);
        const last = lines.at(-1);
        const sec = timeAt(row) + (stopAtRow.get(row) ?? 0);
        if (Math.abs(last.sec - sec) < 1e-9) lines.pop(); // same moment: the later definition wins
        else if (last.bpm === bpm && !shifted) continue; // the same tempo again: the grid already runs on
        lines.push({ row, sec, bpm });
    }
    return { offset, timeAt, redLines: lines, stops, delays, segs };
}

// Rows of a 4-column note block → { taps: [{row, col}], holds: [{row, endRow, col}], stats }.
// Any subdivision per measure; 1 = tap, 2/4 = hold/roll head, 3 = tail, M/L/F/K and the rest are ignored.
export function parseNoteData(notes, columns = COLUMNS) {
    const taps = [];
    const holds = [];
    const stats = { unclosedHolds: 0, strayTails: 0, cancelledHolds: 0 };
    const pending = new Array(columns).fill(null);
    const measures = String(notes ?? "").split(",");
    for (let m = 0; m < measures.length; m += 1) {
        const lines = measures[m].split("\n")
            .map((l) => l.replace(/\{[^}]*\}|\[[^\]]*\]/g, "").trim())
            .filter(Boolean);
        const count = lines.length;
        for (let l = 0; l < count; l += 1) {
            const line = lines[l];
            if (line.length !== columns) throw fail("rowWidth", `row "${line.slice(0, 16)}" in measure ${m} is ${line.length} wide, not ${columns}`);
            const row = m * ROWS_PER_MEASURE + rint((l * ROWS_PER_MEASURE) / count);
            for (let c = 0; c < columns; c += 1) {
                const ch = line[c];
                if (ch === "1" || ch === "2" || ch === "4") {
                    if (pending[c] !== null) {
                        // a head that never got its tail before the next note: StepMania keeps it as a tap
                        taps.push({ row: pending[c], col: c });
                        stats.cancelledHolds += 1;
                        pending[c] = null;
                    }
                    if (ch === "1") taps.push({ row, col: c });
                    else pending[c] = row;
                } else if (ch === "3") {
                    if (pending[c] === null) stats.strayTails += 1;
                    else {
                        holds.push({ row: pending[c], endRow: row, col: c });
                        pending[c] = null;
                    }
                }
            }
        }
    }
    for (let c = 0; c < columns; c += 1) {
        if (pending[c] !== null) {
            taps.push({ row: pending[c], col: c });
            stats.unclosedHolds += 1;
        }
    }
    return { taps, holds, stats };
}

const num3 = (x) => String(Number(x.toFixed(3)));
const numLong = (x) => String(Number(x.toPrecision(15)));

function osuText({ meta, audioFilename, previewMs, redLines, objects }) {
    const lines = [
        "osu file format v14",
        "",
        "[General]",
        `AudioFilename: ${audioFilename}`,
        "AudioLeadIn: 0",
        `PreviewTime: ${previewMs}`,
        "Countdown: 0",
        "SampleSet: Soft",
        "StackLeniency: 0.7",
        "Mode: 3",
        "LetterboxInBreaks: 0",
        "SpecialStyle: 0",
        "WidescreenStoryboard: 0",
        "",
        "[Editor]",
        "DistanceSpacing: 1",
        "BeatDivisor: 4",
        "GridSize: 4",
        "TimelineZoom: 1",
        "",
        "[Metadata]",
        `Title:${meta.title}`,
        `TitleUnicode:${meta.titleUnicode}`,
        `Artist:${meta.artist}`,
        `ArtistUnicode:${meta.artistUnicode}`,
        `Creator:${meta.creator}`,
        `Version:${meta.version}`,
        "Source:",
        `Tags:${meta.tags}`,
        "BeatmapID:0",
        "BeatmapSetID:-1",
        "",
        "[Difficulty]",
        "HPDrainRate:8",
        "CircleSize:4",
        "OverallDifficulty:8",
        "ApproachRate:5",
        "SliderMultiplier:1.4",
        "SliderTickRate:1",
        "",
        "[Events]",
        "//Background and Video events",
        "//Break Periods",
        "//Storyboard Layer 0 (Background)",
        "",
        "[TimingPoints]",
        ...redLines.map((p) => `${num3(p.sec * 1000)},${numLong(60000 / p.bpm)},4,2,0,30,1,0`),
        "",
        "",
        "[HitObjects]",
        ...objects,
        "",
    ];
    return lines.join("\r\n");
}

const COLUMN_X = [64, 192, 320, 448];

// One chart → { ok: true, osu, hash, version, stats, … } or { ok: false, code, reason }.
function convertChart(song, chart, { kind, audioFilename, tags, fallbackTitle }) {
    const t = chart.tags;
    const stepsType = clean(t.STEPSTYPE).toLowerCase();
    const difficulty = clean(t.DIFFICULTY) || "Edit";
    const meterRaw = clean(t.METER);
    const meter = Number.isFinite(Number(meterRaw)) && meterRaw !== "" ? Number(meterRaw) : null;
    const description = clean(t.DESCRIPTION);
    const chartName = clean(t.CHARTNAME);
    const info = { stepsType, difficulty, meter, description };
    if (stepsType !== "dance-single") return { ...info, ok: false, code: "stepsType", reason: `steps type ${stepsType || "(none)"}, not dance-single` };
    let clock;
    let parsed;
    try {
        clock = buildClock(chartTiming(song, kind === "ssc" ? t : {}));
        parsed = parseNoteData(chart.notes);
    } catch (error) {
        return { ...info, ok: false, code: error.code ?? "parse", reason: String(error.message ?? error) };
    }
    const objs = [];
    for (const n of parsed.taps) objs.push({ col: n.col, ms: Math.round(clock.timeAt(n.row) * 1000), end: null });
    for (const h of parsed.holds) {
        const ms = Math.round(clock.timeAt(h.row) * 1000);
        const end = Math.round(clock.timeAt(h.endRow) * 1000);
        objs.push({ col: h.col, ms, end: end > ms ? end : null });
    }
    if (!objs.length) return { ...info, ok: false, code: "noNotes", reason: "no notes" };
    objs.sort((a, b) => a.ms - b.ms || a.col - b.col);
    if (objs[0].ms < 0) return { ...info, ok: false, code: "beforeAudio", reason: `a note at ${objs[0].ms} ms, before the audio starts` };
    const objects = objs.map((o) => (o.end === null
        ? `${COLUMN_X[o.col]},192,${o.ms},1,0,0:0:0:0:`
        : `${COLUMN_X[o.col]},192,${o.ms},128,0,${o.end}:0:0:0:0:`));
    const visual = [];
    const timing = chartTiming(song, kind === "ssc" ? t : {});
    for (const [tag, value] of [["speeds", timing.speeds], ["scrolls", timing.scrolls]]) {
        const trivial = String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean)
            .every((s) => Number(s.split("=")[1]) === 1);
        if (!trivial) visual.push(tag);
    }
    const name = difficulty.toLowerCase() === "edit" ? (chartName || description || "Edit") : difficulty;
    const version = clean(meter === null ? name : `${name} ${meterRaw}`);
    const titleUnicode = clean(song.TITLE) || clean(fallbackTitle) || "Unknown";
    const artistUnicode = clean(song.ARTIST) || "Unknown";
    // .sm keeps the charter in the description field; .ssc has #CREDIT per chart for that
    const creator = (kind === "ssc" ? clean(t.CREDIT) || clean(song.CREDIT) : description || clean(song.CREDIT)) || "Unknown";
    const sample = Number(song.SAMPLESTART);
    const meta = {
        title: clean(song.TITLETRANSLIT) || titleUnicode,
        titleUnicode,
        artist: clean(song.ARTISTTRANSLIT) || artistUnicode,
        artistUnicode,
        creator,
        version,
        tags: clean(["etterna", clean(song.SUBTITLE), tags].filter(Boolean).join(" ")),
    };
    const hash = createHash("sha1").update(objects.join("\n")).digest("hex");
    const osu = osuText({
        meta, audioFilename: clean(audioFilename ?? song.MUSIC),
        previewMs: Number.isFinite(sample) && sample > 0 ? Math.round(sample * 1000) : -1,
        redLines: clock.redLines, objects,
    });
    return {
        ...info, ok: true, version, creator, title: meta.title, artist: meta.artist, osu, hash, visual,
        ownTiming: timing.own,
        stats: {
            notes: objs.length, holds: objs.filter((o) => o.end !== null).length, redLines: clock.redLines.length,
            firstMs: objs[0].ms, lastMs: objs.reduce((m, o) => Math.max(m, o.end ?? o.ms), 0), ...parsed.stats,
        },
    };
}

// A whole simfile → { kind, song: { title, artist, music, credit }, charts: [converted or skipped, in file order] }.
// Versions are made unique within the file ("Hard 12", "Hard 12 (2)").
export function convertSimfile(text, { ext = "", audioFilename, tags = "", fallbackTitle = "" } = {}) {
    const { kind, song, charts } = parseSimfile(text, { ext });
    const out = charts.map((c, index) => ({ index, ...convertChart(song, c, { kind, audioFilename, tags, fallbackTitle }) }));
    const used = new Set();
    for (const c of out) {
        if (!c.ok) continue;
        let v = c.version;
        for (let k = 2; used.has(v.toLowerCase()); k += 1) v = `${c.version} (${k})`;
        if (v !== c.version) {
            c.osu = c.osu.replace(`\r\nVersion:${c.version}\r\n`, `\r\nVersion:${v}\r\n`);
            c.version = v;
        }
        used.add(v.toLowerCase());
    }
    return {
        kind,
        song: { title: clean(song.TITLE), artist: clean(song.ARTIST), music: clean(song.MUSIC), credit: clean(song.CREDIT), subtitle: clean(song.SUBTITLE) },
        charts: out,
    };
}

// "Artist - Title (Creator) [Version].osu", safe on Windows and kept short.
export function osuFileName({ artist, title, creator, version }) {
    const safe = (s, max) => String(s ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, max);
    const name = `${safe(artist, 40)} - ${safe(title, 60)} (${safe(creator, 30)}) [${safe(version, 50)}]`;
    return `${name.replace(/[. ]+$/, "")}.osu`;
}
