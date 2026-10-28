// .osu text → a playable osu!mania chart for the demo player (extension/DESIGN.md §5.6).
// Pure: no DOM, no network. Times are chart milliseconds (= the song's own ms at 1.0×).

const SECTION = /^\[(\w+)\]\s*$/;
const LN_FLAG = 128;

function num(value, fallback = null) {
    const text = String(value ?? "").trim();
    if (!text) return fallback;
    const n = Number(text);
    return Number.isFinite(n) ? n : fallback;
}

// Column of a mania note from its x (osu!stable: floor(x · keys / 512), clamped into the playfield).
export function columnOf(x, keys) {
    const k = Math.max(1, Math.round(keys) || 1);
    const col = Math.floor((Number(x) * k) / 512);
    if (!Number.isFinite(col)) return 0;
    return Math.min(k - 1, Math.max(0, col));
}

// Reads the sections the player needs. Unknown sections and lines are skipped; never throws on odd text.
export function parseChart(text) {
    const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
    const general = {};
    const metadata = {};
    const difficulty = {};
    const rawObjects = [];
    const timingPoints = [];
    let section = "";
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("//")) continue;
        const head = SECTION.exec(line);
        if (head) {
            section = head[1];
            continue;
        }
        if (section === "General" || section === "Metadata" || section === "Difficulty") {
            const at = line.indexOf(":");
            if (at < 0) continue;
            const key = line.slice(0, at).trim();
            const value = line.slice(at + 1).trim();
            (section === "General" ? general : section === "Metadata" ? metadata : difficulty)[key] = value;
        } else if (section === "HitObjects") {
            rawObjects.push(line);
        } else if (section === "TimingPoints") {
            const parts = line.split(",");
            const t = num(parts[0]);
            const beatLength = num(parts[1]);
            if (t === null || beatLength === null) continue;
            const uninherited = parts.length > 6 ? num(parts[6], 1) === 1 : true;
            timingPoints.push({ t, beatLength, meter: num(parts[2], 4) || 4, uninherited, kiai: ((num(parts[7], 0) || 0) & 1) === 1 });
        }
    }

    const mode = num(general.Mode, 0);
    const circleSize = num(difficulty.CircleSize, 0);
    const keys = mode === 3 ? Math.round(circleSize) : null;
    const columns = Math.max(1, keys ?? 4);

    const seen = new Set();
    const notes = [];
    for (const line of rawObjects) {
        const parts = line.split(",");
        if (parts.length < 4) continue;
        const x = num(parts[0]);
        const t = num(parts[2]);
        const type = num(parts[3], 0);
        if (x === null || t === null) continue;
        const col = columnOf(x, columns);
        let end = null;
        if (type & LN_FLAG) {
            const first = num(String(parts[5] ?? "").split(":")[0]);
            if (first !== null && first > t) end = first;
        }
        const id = `${col}|${t}`;
        if (seen.has(id)) continue; // a stacked duplicate cannot be played twice
        seen.add(id);
        notes.push({ col, t, end });
    }
    notes.sort((a, b) => a.t - b.t || a.col - b.col);
    timingPoints.sort((a, b) => a.t - b.t);

    return {
        mode,
        keys,
        od: num(difficulty.OverallDifficulty, 5),
        hp: num(difficulty.HPDrainRate, 5),
        previewTime: num(general.PreviewTime, -1),
        audioFilename: general.AudioFilename ?? "",
        audioLeadIn: num(general.AudioLeadIn, 0),
        title: metadata.TitleUnicode || metadata.Title || "",
        artist: metadata.ArtistUnicode || metadata.Artist || "",
        creator: metadata.Creator || "",
        version: metadata.Version || "",
        beatmapId: num(metadata.BeatmapID),
        beatmapSetId: num(metadata.BeatmapSetID),
        notes,
        timingPoints,
    };
}

// Why a chart cannot be played here, or null: "mode" (not osu!mania), "keys" (not 4K), "empty" (no notes).
export function unplayableReason(chart) {
    if (!chart || chart.mode !== 3) return "mode";
    if (chart.keys !== 4) return "keys";
    if (!chart.notes.length) return "empty";
    return null;
}

// First head and last end of a note list (chart ms), or nulls for an empty list.
export function noteSpan(notes) {
    if (!notes?.length) return { first: null, last: null };
    let last = -Infinity;
    for (const n of notes) last = Math.max(last, n.end ?? n.t);
    return { first: notes[0].t, last };
}
