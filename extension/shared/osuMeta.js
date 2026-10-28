// What the panel and the player need to know about a difficulty, read from its .osu text (no analysis):
// { mode, keys, od, hp, previewTime, audioFilename, audioLeadIn, title, artist, creator, version, beatmapId,
//   beatmapSetId, noteCount, lnCount, firstNoteMs, lastNoteMs }. Numbers or null; keys = round(CircleSize) for
// osu!mania (mode 3) only; previewTime is -1 when the map has none; noteCount counts every object (LNs too);
// lastNoteMs is the latest head or LN tail.
const HEADER = /^\s*\[([^\]]+)\]\s*$/;

const num = (value) => {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};
const str = (value) => (value === undefined || value === "" ? null : value);

export function readOsuMeta(text) {
    const fields = { General: new Map(), Metadata: new Map(), Difficulty: new Map() };
    let section = null;
    let noteCount = 0;
    let lnCount = 0;
    let firstNoteMs = null;
    let lastNoteMs = null;
    for (const raw of String(text ?? "").split(/\r?\n/)) {
        const line = raw.replace(/^﻿/, "");
        const header = HEADER.exec(line);
        if (header) {
            section = header[1].trim();
            continue;
        }
        if (!line.trim() || line.startsWith("//")) continue;
        if (section === "HitObjects") {
            const parts = line.split(",");
            const time = num(parts[2]);
            if (time === null) continue;
            noteCount += 1;
            let end = time;
            if ((Number(parts[3]) & 128) !== 0) {
                lnCount += 1;
                const tail = num(String(parts[5] ?? "").split(":")[0]);
                if (tail !== null && tail > end) end = tail;
            }
            if (firstNoteMs === null || time < firstNoteMs) firstNoteMs = time;
            if (lastNoteMs === null || end > lastNoteMs) lastNoteMs = end;
            continue;
        }
        const map = fields[section];
        if (!map) continue;
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        if (!map.has(key)) map.set(key, line.slice(colon + 1).trim());
    }
    const g = (k) => fields.General.get(k);
    const m = (k) => fields.Metadata.get(k);
    const d = (k) => fields.Difficulty.get(k);
    const mode = num(g("Mode")) ?? 0; // osu! reads a missing Mode as osu!standard
    const cs = num(d("CircleSize"));
    const preview = num(g("PreviewTime"));
    return {
        mode,
        keys: mode === 3 && cs !== null ? Math.round(cs) : null,
        od: num(d("OverallDifficulty")),
        hp: num(d("HPDrainRate")),
        previewTime: preview === null || preview < 0 ? -1 : preview,
        audioFilename: str(g("AudioFilename")),
        audioLeadIn: num(g("AudioLeadIn")),
        title: str(m("Title")),
        artist: str(m("Artist")),
        creator: str(m("Creator")),
        version: str(m("Version")),
        beatmapId: num(m("BeatmapID")),
        beatmapSetId: num(m("BeatmapSetID")),
        noteCount,
        lnCount,
        firstNoteMs,
        lastNoteMs,
    };
}
