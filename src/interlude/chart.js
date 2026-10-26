// Interlude's chart format, re-implemented in our own JS from reading Prelude (github.com/YAVSRG/YAVSRG, prelude/,
// MIT): the binary chart kept in Songs/charts.db (prelude/src/Charts/Chart.fs, NoteRow.fs, Shared/TimeArray.fs,
// Shared/Bitmask.fs), its id (Chart.Hash), the osu! → Interlude conversion that id is taken of
// (Formats/Conversions/OsuConverter.fs, Conversions.fs, Formats/osu!/*.fs) and an .osu made from a chart
// (Data/Exports/OsuExport.fs). Interlude works in float32 (System.Single): every step of the id's sums is rounded
// to float32 here too (Math.fround), and .NET rounds halves to even (Math.Round, Convert.ToInt32).
import { createHash } from "node:crypto";

export const NOTE = Object.freeze({ NOTHING: 0, NORMAL: 1, HOLDHEAD: 2, HOLDBODY: 3, HOLDTAIL: 4 });
const f32 = Math.fround;

// .NET's Math.Round / Convert.ToInt32: to the nearest integer, a half to the even one.
export function roundEven(x) {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

class Reader {
    constructor(buf) {
        this.buf = buf;
        this.at = 0;
    }
    need(n) {
        if (this.at + n > this.buf.length) throw new Error("chart data ends too early");
    }
    i32() { this.need(4); const v = this.buf.readInt32LE(this.at); this.at += 4; return v; }
    u16() { this.need(2); const v = this.buf.readUInt16LE(this.at); this.at += 2; return v; }
    u8() { this.need(1); return this.buf[this.at++]; }
    f32() { this.need(4); const v = this.buf.readFloatLE(this.at); this.at += 4; return v; }
}

function timeArray(r, item) {
    const count = r.i32();
    if (count < 0 || count > 10_000_000) throw new Error("bad chart data");
    const out = new Array(count);
    for (let i = 0; i < count; i += 1) {
        const time = r.f32();
        out[i] = { time, data: item(r) };
    }
    return out;
}

// The Chart column of charts.db (Chart.ReadFromStreamHeadless) with the Keys column → { keys, notes, bpm, sv }:
// notes [{ time, data: [type per column] }], bpm [{ time, data: { meter, msPerBeat } }], sv [{ time, data }].
export function decodeChart(blob, keys) {
    if (!(keys >= 3 && keys <= 10)) throw new Error(`unsupported key count ${keys}`);
    const r = new Reader(Buffer.from(blob));
    const notes = timeArray(r, (rd) => {
        const row = new Array(keys).fill(NOTE.NOTHING);
        let bits = rd.u16();
        for (let column = 0; bits; column += 1, bits >>>= 1) {
            if (!(bits & 1)) continue;
            if (column >= keys) throw new Error("note outside the chart's columns");
            const type = rd.u8();
            if (type < 1 || type > 4) throw new Error(`unexpected note type in chart data: ${type}`);
            row[column] = type;
        }
        return row;
    });
    const bpm = timeArray(r, (rd) => ({ meter: rd.i32(), msPerBeat: rd.f32() }));
    const sv = timeArray(r, (rd) => rd.f32());
    const chart = { keys, notes, bpm, sv };
    checkChart(chart);
    return chart;
}

// The other way (Chart.WriteToStreamHeadless): how charts.db holds a chart. The app only reads charts.db; this
// makes the test fixtures.
export function encodeChart({ notes, bpm, sv }) {
    const parts = [];
    const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); };
    const fl = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); parts.push(b); };
    i32(notes.length);
    for (const { time, data } of notes) {
        fl(time);
        let mask = 0;
        const types = [];
        data.forEach((n, k) => { if (n !== NOTE.NOTHING) { mask |= 1 << k; types.push(n); } });
        const m = Buffer.alloc(2);
        m.writeUInt16LE(mask);
        parts.push(m, Buffer.from(types));
    }
    i32(bpm.length);
    for (const { time, data } of bpm) { fl(time); i32(data.meter); fl(data.msPerBeat); }
    i32(sv.length);
    for (const { time, data } of sv) { fl(time); fl(data); }
    return Buffer.concat(parts);
}

// The parts of Chart.CheckForErrors the rest relies on: notes and BPMs present, rows in order, holds closed.
export function checkChart({ keys, notes, bpm }) {
    if (!notes.length) throw new Error("Chart must have notes");
    if (!bpm.length) throw new Error("Chart must have at least one BPM marker");
    const holding = new Array(keys).fill(false);
    let last = -Infinity;
    for (const { time, data } of notes) {
        if (!(time > last) || !Number.isFinite(time)) throw new Error(`Note row out of order at ${time}`);
        last = time;
        for (let k = 0; k < keys; k += 1) {
            const n = data[k];
            if (n === NOTE.HOLDHEAD) {
                if (holding[k]) throw new Error(`Hold head inside hold at ${time}`);
                holding[k] = true;
            } else if (n === NOTE.HOLDBODY) {
                if (!holding[k]) throw new Error(`Hold middle with no head at ${time}`);
            } else if (n === NOTE.NOTHING) {
                if (holding[k]) throw new Error(`Hold middle missing at ${time}`);
            } else if (n === NOTE.HOLDTAIL) {
                if (!holding[k]) throw new Error(`Hold tail with no head at ${time}`);
                holding[k] = false;
            }
        }
    }
    if (holding.some(Boolean)) throw new Error("Unterminated hold notes at end of chart");
}

// Chart.Hash: uppercase hex SHA-256 over the key count, every row's note types, each change of scroll speed
// (time from the first note × 0.2, rounded, and the speed as a double) and the length (× 0.01, rounded).
export function chartHash({ keys, notes, sv }) {
    const parts = [];
    const head = Buffer.alloc(4);
    head.writeInt32LE(keys);
    parts.push(head);
    const types = Buffer.alloc(notes.length * keys);
    let i = 0;
    for (const { data } of notes) for (let k = 0; k < keys; k += 1) types[i++] = data[k];
    parts.push(types);
    const offset = notes[0].time;
    let speed = 1.0;
    for (const { time, data } of sv) {
        const f = data; // a float32 widened to a double, as `float f` does
        if (speed !== f) {
            const b = Buffer.alloc(12);
            b.writeInt32LE(roundEven(f32(f32(time - offset) * f32(0.2))));
            b.writeDoubleLE(f, 4);
            parts.push(b);
            speed = f;
        }
    }
    const tail = Buffer.alloc(4);
    tail.writeInt32LE(roundEven(f32(f32(notes[notes.length - 1].time - offset) * f32(0.01))));
    parts.push(tail);
    return createHash("sha256").update(Buffer.concat(parts)).digest("hex").toUpperCase();
}

// ---- osu! → Interlude (OsuConverter.convert), to know the id Interlude will give an .osu ----

class SkipConversion extends Error {}

// .NET's Double/Single.TryParse with the invariant culture, near enough: a plain decimal number (or NaN/Infinity).
function parseNumber(value) {
    if (value === undefined) return null;
    const s = String(value).trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
    if (s === "NaN") return NaN;
    if (/^[+-]?Infinity$/.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    return null;
}
const parseInt32 = (value) => (value !== undefined && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : null);

function invalid(line) {
    throw new SkipConversion(`unreadable line: ${line}`);
}

// HitObject.FromString, the parts that matter for mania: column x, start time, end time of a hold.
function hitObject(line) {
    if (line.startsWith(" ")) invalid(line);
    const v = line.split(",");
    let x = parseNumber(v[0]);
    if (x === null || Number.isNaN(x) || !Number.isFinite(x)) invalid(line);
    x = Math.trunc(Math.min(512, Math.max(0, f32(x))));
    let time = parseNumber(v[2]);
    if (time === null || Number.isNaN(time) || !Number.isFinite(time) || time < 0) invalid(line);
    time = Math.trunc(f32(time));
    const type = parseInt32(v[3]);
    if (type === null || parseInt32(v[4]) === null) invalid(line);
    if (type & 1) return { kind: "circle", x, time };
    if (type & 2) return { kind: "slider", x, time };
    if (type & 8) return { kind: "spinner", x, time };
    if (type & 128) {
        if (v[5] === undefined) invalid(line);
        let end = parseNumber(v[5].split(":")[0].trim());
        if (end === null) invalid(line);
        end = Number.isNaN(end) ? -2147483648 : f32(end);
        if (end < -2147483648 || end > 2147483647) end = -2147483648;
        return { kind: "hold", x, time, end: Math.trunc(end) };
    }
    return invalid(line);
}

// TimingPoint.FromString
function timingPoint(line) {
    const v = line.split(",");
    if (v.length === 3) invalid(line);
    const time = parseNumber(v[0]);
    if (time === null || Number.isNaN(time) || !Number.isFinite(time)) invalid(line);
    const meterRaw = v[2] === undefined ? 4 : parseInt32(v[2]);
    if (meterRaw === null) invalid(line);
    const meter = meterRaw === 0 ? 4 : meterRaw;
    const uninherited = (v[6] ?? "1").startsWith("1");
    if (uninherited) {
        let ms = parseNumber(v[1]);
        if (ms === null || Number.isNaN(ms)) invalid(line);
        if (ms === 0) ms = Infinity;
        if (!Number.isFinite(ms)) invalid(line);
        return { uninherited: true, time, msPerBeat: Math.abs(ms), meter };
    }
    const sv = parseNumber(v[1]);
    if (sv === null || (Number.isFinite(sv) === false && !Number.isNaN(sv))) invalid(line);
    const multiplier = sv >= 0 || Number.isNaN(sv) ? 1.0 : Math.max(0.01, Math.min(10.0, -100.0 / sv));
    return { uninherited: false, time, multiplier };
}

// The sections of an .osu the conversion reads (Beatmap.FromLines). → { mode, keys, objects, timing }
export function readOsu(text) {
    const header = new Map();
    const objects = [];
    const timing = [];
    let state = null;
    for (const raw of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, "");
        if (line === "" || line.startsWith("//")) continue;
        if (/^\[(General|Editor|Metadata|Difficulty)\]$/.test(line)) { state = "header"; continue; }
        if (line === "[Events]") { state = "events"; continue; }
        if (line === "[TimingPoints]") { state = "timing"; continue; }
        if (line === "[HitObjects]") { state = "objects"; continue; }
        if (line === "[Colours]") { state = "colours"; continue; }
        if (state === "header") {
            const at = line.indexOf(":");
            if (at >= 0) header.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
        } else if (state === "timing") {
            timing.push(timingPoint(line));
        } else if (state === "objects") {
            objects.push(hitObject(line));
        }
    }
    const stable = (list) => list.map((x, i) => [x, i]).sort((a, b) => a[0].time - b[0].time || a[1] - b[1]).map((p) => p[0]);
    return {
        mode: parseInt32(header.get("Mode")) ?? 0,
        keys: Math.trunc(parseNumber(header.get("CircleSize")) ?? 4),
        objects: stable(objects),
        timing: stable(timing),
    };
}

// OsuConverter.convert_hit_objects: rows of note types, hold bodies filled in, tails where holds end.
function convertObjects(objects, keys) {
    const column = (x) => Math.max(0, Math.min(keys - 1, Math.trunc((x / 512.0) * keys)));
    const holding = new Array(keys).fill(null);
    const out = [];
    let last = { time: -Infinity, data: [] };
    const newRow = (time) => {
        last = { time, data: new Array(keys).fill(NOTE.NOTHING) };
        out.push(last);
        for (let k = 0; k < keys; k += 1) if (holding[k] !== null) last.data[k] = NOTE.HOLDBODY;
    };
    const earliest = () => holding.reduce((m, h) => (h !== null && h < m ? h : m), Infinity);
    const finishHolds = (time) => {
        let release = earliest();
        while (release < time) {
            for (let k = 0; k < keys; k += 1) {
                if (holding[k] !== release) continue;
                if (release > last.time) newRow(release);
                const n = last.data[k];
                if (n !== NOTE.NOTHING && n !== NOTE.HOLDBODY) throw new SkipConversion("impossible");
                last.data[k] = NOTE.HOLDTAIL;
                holding[k] = null;
            }
            release = earliest();
        }
    };
    const addNote = (k, time) => {
        finishHolds(time);
        if (time > last.time) newRow(time);
        const n = last.data[k];
        if (n === NOTE.NOTHING) last.data[k] = NOTE.NORMAL;
        else if (n !== NOTE.NORMAL && n !== NOTE.HOLDHEAD) throw new SkipConversion(`Stacked note at ${time}, column ${k + 1}`);
    };
    const startHold = (k, time, end) => {
        finishHolds(time);
        if (time > last.time) newRow(time);
        const n = last.data[k];
        if (n === NOTE.NOTHING || n === NOTE.NORMAL) {
            last.data[k] = NOTE.HOLDHEAD;
            holding[k] = end;
        } else {
            throw new SkipConversion(`Stacked LN at ${time}, column ${k + 1}`);
        }
    };
    for (const o of objects) {
        if (o.kind === "circle") addNote(column(o.x), f32(o.time));
        else if (o.kind === "hold" && o.end > o.time) startHold(column(o.x), f32(o.time), f32(o.end));
        else if (o.kind === "hold") addNote(column(o.x), f32(o.time));
    }
    finishHolds(Infinity);
    return out;
}

// find_most_common_beat_length: the beat length held longest up to endTime (the first of a tie).
function mostCommonBeat(points, endTime) {
    const reds = points.filter((p) => p.uninherited);
    const data = new Map();
    let current = f32(Math.abs(f32(reds[0].msPerBeat)));
    let time = f32(reds[0].time);
    for (const b of reds.slice(1)) {
        if (!data.has(current)) data.set(current, 0);
        data.set(current, f32(f32(data.get(current) + f32(b.time)) - time));
        time = f32(b.time);
        current = f32(Math.abs(f32(b.msPerBeat)));
    }
    if (!data.has(current)) data.set(current, 0);
    data.set(current, f32(data.get(current) + Math.max(f32(endTime - time), 0)));
    let best = null;
    for (const [key, value] of data) if (best === null || value > best[1]) best = [key, value];
    return best[0];
}

// The last of every run of points on the same time (Conversions.remove_stacked_points).
function removeStacked(points) {
    const out = [];
    for (let i = 0; i < points.length; i += 1) if (i === points.length - 1 || points[i + 1].time > points[i].time) out.push(points[i]);
    return out;
}

// OsuConverter.convert_timing_points → { bpm, sv }
function convertTiming(points, endTime) {
    if (!points.length) throw new SkipConversion("This beatmap has no timing points");
    if (!points[0].uninherited) throw new SkipConversion("First timing point must be uninherited");
    const common = mostCommonBeat(points, endTime);
    const bpm = [];
    const sv = [];
    let mult = 1.0;
    for (const p of points) {
        if (p.uninherited) {
            const beat = f32(Math.abs(f32(p.msPerBeat)));
            bpm.push({ time: f32(p.time), data: { meter: p.meter, msPerBeat: beat } });
            mult = f32(common / beat);
            sv.push({ time: f32(p.time), data: mult });
        } else {
            sv.push({ time: f32(p.time), data: f32(mult * f32(p.multiplier)) });
        }
    }
    let previous = f32(1.0);
    const cleaned = [];
    for (const s of removeStacked(sv)) {
        if (f32(Math.abs(f32(s.data - previous))) > f32(0.005)) {
            cleaned.push(s);
            previous = s.data;
        }
    }
    return { bpm: removeStacked(bpm), sv: cleaned };
}

// An .osu's text → the chart Interlude makes of it ({ keys, notes, bpm, sv }), or throws why it would skip it.
export function osuToChart(text) {
    const b = readOsu(text);
    if (b.mode !== 3) throw new SkipConversion("Beatmap is not osu!mania gamemode");
    if (b.keys < 3 || b.keys > 10) throw new SkipConversion("Keymode not supported");
    if (b.objects.length < 20) throw new SkipConversion("Beatmap has less than 20 notes");
    const notes = convertObjects(b.objects, b.keys);
    if (!notes.length) throw new SkipConversion("Beatmap has no notes");
    const { bpm, sv } = convertTiming(b.timing, notes[notes.length - 1].time);
    return { keys: b.keys, notes, bpm, sv };
}

// The id Interlude gives an .osu once imported, or null when it would not import it.
export function osuChartHash(text) {
    try {
        return chartHash(osuToChart(text));
    } catch {
        return null;
    }
}

// The lower-case MD5 of an .osu's bytes, as Interlude keeps it in a chart's osu! origin (Beatmap.Hash).
export const osuMd5 = (bytes) => createHash("md5").update(bytes).digest("hex");

// ---- Interlude → osu! (an .osu to analyse or to make rate copies of) ----

// a number as .NET writes a double (the shortest text that reads back the same), as osu! reads it
const num = (x) => String(Number(x));
const cleanLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

// The most common beat length of a chart (Chart.find_most_common_bpm), weighted by time until the last note.
function chartCommonBeat({ bpm, notes }) {
    const end = notes[notes.length - 1].time;
    const data = new Map();
    let current = bpm[0].data.msPerBeat;
    let time = bpm[0].time;
    for (const b of bpm.slice(1)) {
        data.set(current, f32(f32((data.get(current) ?? 0) + b.time) - time));
        time = b.time;
        current = b.data.msPerBeat;
    }
    data.set(current, f32((data.get(current) ?? 0) + Math.max(f32(end - time), 0)));
    let best = null;
    for (const [key, value] of data) if (best === null || value > best[1]) best = [key, value];
    return best[0];
}

// OsuExport.convert_timing_points: a red line per BPM and a green line per scroll change, the speed given against
// the most common BPM as Interlude keeps it.
function timingLines(chart) {
    const common = chartCommonBeat(chart);
    const lines = [];
    let bpmMult = 1;
    let scroll = 1;
    const red = (b) => `${num(b.time)},${num(b.data.msPerBeat)},${b.data.meter > 0 ? b.data.meter : 4},2,0,30,1,0`;
    const green = (time, mult) => `${num(time)},${num(-100 / Math.max(0.01, Math.min(100, mult)))},4,2,0,30,0,0`;
    // float32 sums, as OsuExport makes them
    let i = 0;
    let j = 0;
    const { bpm, sv } = chart;
    while (i < bpm.length || j < sv.length) {
        if (j >= sv.length || (i < bpm.length && bpm[i].time <= sv[j].time)) {
            const b = bpm[i++];
            bpmMult = f32(common / b.data.msPerBeat);
            lines.push(red(b), green(b.time, f32(scroll / bpmMult)));
        } else {
            const s = sv[j++];
            scroll = s.data;
            lines.push(green(s.time, f32(scroll / bpmMult)));
        }
    }
    return lines;
}

// meta: { title, titleNative, artist, artistNative, creator, version, source, tags, previewTime, audio, background, od }
// → the chart as an .osu (v14): notes and holds (HitObject.CreateManiaNote/Hold), the timing above.
export function chartToOsu(chart, meta = {}) {
    const { keys, notes } = chart;
    const x = (k) => Math.trunc(((k + 0.5) * 512) / keys);
    const at = (time) => roundEven(f32(time));
    const objects = [];
    for (let i = 0; i < notes.length; i += 1) {
        const { time, data } = notes[i];
        for (let k = 0; k < keys; k += 1) {
            if (data[k] === NOTE.NORMAL) {
                objects.push(`${x(k)},192,${at(time)},1,0,0:0:0:0:`);
            } else if (data[k] === NOTE.HOLDHEAD) {
                let end = time;
                for (let j = i + 1; j < notes.length; j += 1) if (notes[j].data[k] === NOTE.HOLDTAIL) { end = notes[j].time; break; }
                objects.push(`${x(k)},192,${at(time)},128,0,${at(end)}:0:0:0:0:`);
            }
        }
    }
    const od = Number.isFinite(meta.od) ? Math.max(0, Math.min(10, Math.round(meta.od * 10) / 10)) : 8;
    return [
        "osu file format v14",
        "",
        "[General]",
        `AudioFilename: ${cleanLine(meta.audio) || "audio.mp3"}`,
        "AudioLeadIn: 0",
        `PreviewTime: ${Number.isFinite(meta.previewTime) ? Math.round(meta.previewTime) : -1}`,
        "Countdown: 0",
        "SampleSet: Soft",
        "StackLeniency: 0.7",
        "Mode: 3",
        "LetterboxInBreaks: 0",
        "SpecialStyle: 0",
        "WidescreenStoryboard: 0",
        "",
        "[Metadata]",
        `Title:${cleanLine(meta.title)}`,
        `TitleUnicode:${cleanLine(meta.titleNative || meta.title)}`,
        `Artist:${cleanLine(meta.artist)}`,
        `ArtistUnicode:${cleanLine(meta.artistNative || meta.artist)}`,
        `Creator:${cleanLine(meta.creator)}`,
        `Version:${cleanLine(meta.version)}`,
        `Source:${cleanLine(meta.source)}`,
        `Tags:${cleanLine(Array.isArray(meta.tags) ? meta.tags.join(" ") : meta.tags)}`,
        "BeatmapID:0",
        "BeatmapSetID:-1",
        "",
        "[Difficulty]",
        "HPDrainRate:8",
        `CircleSize:${keys}`,
        `OverallDifficulty:${od}`,
        "ApproachRate:5",
        "SliderMultiplier:1.4",
        "SliderTickRate:1",
        "",
        "[Events]",
        "//Background and Video events",
        ...(meta.background ? [`0,0,"${cleanLine(meta.background)}",0,0`] : []),
        "",
        "[TimingPoints]",
        ...timingLines(chart),
        "",
        "",
        "[HitObjects]",
        ...objects,
        "",
    ].join("\r\n");
}
