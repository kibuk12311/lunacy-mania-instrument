// Interlude's replays and mods, re-implemented in our own JS from reading Prelude (github.com/YAVSRG/YAVSRG, prelude/,
// MIT): the Replay column of scores.db (src/Gameplay/Replays/Replay.fs, KeyPressReader.fs), the Mods column
// (src/Mods/ModState.fs, Mods.fs) and how the mods this app follows change a chart's notes (Mirror.fs, NoLN.fs,
// NoSV.fs). A replay is the state of the keys frame by frame, its times ms of the chart at rate 1.0 counted from the
// chart's first note (after mods), so a time of the chart is the first note's time + a frame's. Float32 as in Prelude.
// Pure but for node:zlib.
import { gunzipSync } from "node:zlib";
import { NOTE } from "./chart.js";

const f32 = Math.fround;
export const MAX_REPLAY_BYTES = 64 * 1024 * 1024; // what a replay may unpack to: far over hours of play
const FRAME_BYTES = 6;

// The Replay blob → { times: Float32Array (ms of the chart from its first note), masks: Uint16Array (bit k: column k
// held) }: gzip of an int32 count, then per frame a float32 time and a uint16 mask. Throws on a stream that is not
// one, a length that does not match the count, a time that is not a number or goes back.
export function readIlReplay(blob) {
    let bytes;
    try {
        bytes = gunzipSync(Buffer.from(blob), { maxOutputLength: MAX_REPLAY_BYTES });
    } catch (e) {
        throw new Error(`replay: not a gzip stream (${e.code ?? e.message})`);
    }
    if (bytes.length < 4) throw new Error("replay: ends before its frame count");
    const count = bytes.readInt32LE(0);
    if (count < 0 || bytes.length !== 4 + count * FRAME_BYTES) throw new Error(`replay: ${bytes.length} bytes do not hold ${count} frames`);
    const times = new Float32Array(count);
    const masks = new Uint16Array(count);
    let last = -Infinity;
    for (let i = 0; i < count; i += 1) {
        const at = 4 + i * FRAME_BYTES;
        const time = bytes.readFloatLE(at);
        if (!Number.isFinite(time)) throw new Error(`replay: frame ${i + 1} has no time`);
        if (time < last) throw new Error(`replay: frame ${i + 1} goes back in time`);
        times[i] = time;
        masks[i] = bytes.readUInt16LE(at + 4);
        last = time;
    }
    return { times, masks };
}

// Mods.APPLICATION_PRIORITY_ORDER: the order mods change a chart in, and their names are written in.
export const IL_MOD_ORDER = Object.freeze(["noln", "more_notes", "column_swap", "mirror", "shuffle", "random", "inverse", "nosv"]);
const NOLN_STATES = 4;

// ColumnSwap.unpack + format: the packed columns → "1243", "-" for a column left empty; null when it is not one.
function columnSwapText(state) {
    const length = state % 16;
    if (length < 3 || length > 10) return null;
    let rest = Math.floor(state / 16);
    let out = "";
    for (let i = 0; i < length; i += 1) {
        const c = rest % 16;
        rest = Math.floor(rest / 16);
        out += c === 15 ? "-" : c <= 9 ? "1234567890"[c] : "-";
    }
    return out;
}

// Mod.Shorthand of each mod, as Interlude shows it.
const SHORTHAND = {
    mirror: () => "MR",
    shuffle: () => "SHF",
    random: () => "RD",
    nosv: () => "NSV",
    noln: (s) => ({ 1: "LN-3", 2: "LN-2", 3: "LN-1" })[s] ?? "NLN",
    inverse: (s) => ({ 1: "INV+1", 2: "INV-1" })[s] ?? "INV",
    more_notes: (s) => (s === 1 ? "MNC" : "MNM"),
    column_swap: (s) => {
        const columns = columnSwapText(s);
        return columns === null ? "column_swap" : `[${columns}]`;
    },
};

// What applyIlMods can follow: mirror, noln in its four states, nosv (which leaves the notes as they are).
const supported = (id, state) => id === "mirror" || id === "nosv" || (id === "noln" && state >= 0 && state < NOLN_STATES);

// The Mods column (JSON of mod id → state) → { mods: { id: state }, unsupported: [id], labels: [name] }: unsupported
// the mods applyIlMods cannot follow (shuffle, random, inverse, column_swap, an id this app does not know), labels the
// names Interlude shows, in its order. Throws on text that is not such a map.
export function parseIlMods(text) {
    let raw = {};
    if (text !== null && text !== undefined && String(text).trim() !== "") {
        try {
            raw = JSON.parse(String(text));
        } catch {
            throw new Error("mods: not JSON");
        }
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("mods: not a map of mods");
    const mods = {};
    for (const [id, state] of Object.entries(raw)) {
        if (!Number.isInteger(state)) throw new Error(`mods: ${id} has no state`);
        mods[id] = state;
    }
    const ids = [...IL_MOD_ORDER.filter((id) => id in mods), ...Object.keys(mods).filter((id) => !IL_MOD_ORDER.includes(id)).sort()];
    return {
        mods,
        unsupported: ids.filter((id) => !supported(id, mods[id])),
        labels: ids.map((id) => (SHORTHAND[id] ? SHORTHAND[id](mods[id]) : id)),
    };
}

// NoteRow.is_empty: nothing but hold bodies.
const isEmpty = (data) => data.every((n) => n === NOTE.NOTHING || n === NOTE.HOLDBODY);
const copyRows = (notes) => notes.map(({ time, data }) => ({ time, data: [...data] }));

// NoLN.apply: every hold a plain note → [notes, whether there was a hold].
function noLn(notes) {
    let found = false;
    const out = copyRows(notes);
    for (const { data } of out) {
        for (let k = 0; k < data.length; k += 1) {
            if (data[k] === NOTE.HOLDHEAD) {
                found = true;
                data[k] = NOTE.NORMAL;
            } else if (data[k] === NOTE.HOLDBODY || data[k] === NOTE.HOLDTAIL) {
                data[k] = NOTE.NOTHING;
            }
        }
    }
    return [out.filter((row) => !isEmpty(row.data)), found];
}

// NoLN.apply_shorter_than: the holds shorter than `beats` (less 3 ms) plain notes, as Prelude does it: a hold whose
// next row in its column is its tail goes too, however long. → [notes, whether one was found].
function noShortLn(notes, bpm, beats) {
    const out = copyRows(notes);
    let threshold = 0;
    let bpmIndex = -1;
    let found = false;
    const updateLength = (now) => {
        while (bpmIndex < 0 || (bpmIndex + 1 < bpm.length && bpm[bpmIndex + 1].time < now)) {
            threshold = f32(f32(bpm[bpmIndex + 1].data.msPerBeat * beats) - 3);
            bpmIndex += 1;
        }
    };
    const removeShortHold = (k, start) => {
        let i = start + 1;
        const startTime = out[start].time;
        while (out[i].data[k] !== NOTE.HOLDTAIL && f32(out[i].time - startTime) < threshold) i += 1;
        if (out[i].data[k] !== NOTE.HOLDTAIL) return;
        found = true;
        for (let j = i; j > start; j -= 1) out[j].data[k] = NOTE.NOTHING;
        out[start].data[k] = NOTE.NORMAL;
    };
    for (let i = 0; i < out.length; i += 1) {
        updateLength(out[i].time);
        out[i].data.forEach((type, k) => {
            if (type === NOTE.HOLDHEAD) removeShortHold(k, i);
        });
    }
    return [out.filter((row) => !isEmpty(row.data)), found];
}

const NOLN_BEATS = { 1: 1.0, 2: 0.5, 3: 0.25 };

// ModState.apply for the mods this app follows: chart ({ keys, notes, bpm, sv }, decodeChart's) and mods (parseIlMods')
// → the chart as it was played. A mod that changes nothing leaves the chart as it is, as in Prelude. Throws on a mod it
// cannot follow (parseIlMods' unsupported).
export function applyIlMods(chart, mods) {
    for (const [id, state] of Object.entries(mods)) if (!supported(id, state)) throw new Error(`mods: ${id} is not followed here`);
    let out = chart;
    for (const id of IL_MOD_ORDER) {
        if (!(id in mods)) continue;
        if (id === "noln") {
            const state = mods.noln;
            const [notes, applied] = state === 0 ? noLn(out.notes) : noShortLn(out.notes, out.bpm, NOLN_BEATS[state]);
            if (applied) out = { ...out, notes };
        } else if (id === "mirror") {
            out = { ...out, notes: out.notes.map(({ time, data }) => ({ time, data: [...data].reverse() })) };
        } else if (id === "nosv") {
            if (out.sv.some(({ data }) => Math.round(data * 100) / 100 !== 1)) out = { ...out, sv: [] };
        }
    }
    return out;
}

// The rows of a chart → its notes, each with the rows it is on: [{ t, col, end, row, tailRow }], t / end ms of the
// chart, end and tailRow null for a tap; in the order of the rows, columns left to right.
export function ilNoteRows(chart) {
    const out = [];
    const open = new Array(chart.keys).fill(null);
    chart.notes.forEach(({ time, data }, row) => {
        for (let k = 0; k < chart.keys; k += 1) {
            if (data[k] === NOTE.NORMAL) {
                out.push({ t: time, col: k, end: null, row, tailRow: null });
            } else if (data[k] === NOTE.HOLDHEAD) {
                open[k] = { t: time, col: k, end: null, row, tailRow: null };
                out.push(open[k]);
            } else if (data[k] === NOTE.HOLDTAIL && open[k]) {
                open[k].end = time;
                open[k].tailRow = row;
                open[k] = null;
            }
        }
    });
    return out;
}

// The chart's notes as the app knows them: [{ t, col, end }], ms of the chart, end null for a tap.
export const ilNotes = (chart) => ilNoteRows(chart).map(({ t, col, end }) => ({ t, col, end }));

// The frames → the key presses of each column, as KeyPressReader sees them: [[{ t, up }], …], ms of the chart (the
// first note's + the frame's, float32 as the judging adds them), up null when the key is still down at the end. Bits
// past the chart's columns are not read.
export function ilPresses({ times, masks }, keys, firstNoteMs) {
    const columns = Array.from({ length: keys }, () => []);
    const open = new Array(keys).fill(null);
    let last = 0;
    for (let i = 0; i < masks.length; i += 1) {
        const changed = masks[i] ^ last;
        if (changed) {
            const t = f32(firstNoteMs + times[i]);
            for (let c = 0; c < keys; c += 1) {
                if (!(changed & (1 << c))) continue;
                if (masks[i] & (1 << c)) {
                    open[c] = { t, up: null };
                    columns[c].push(open[c]);
                } else if (open[c]) {
                    open[c].up = t;
                    open[c] = null;
                }
            }
        }
        last = masks[i];
    }
    return columns;
}
