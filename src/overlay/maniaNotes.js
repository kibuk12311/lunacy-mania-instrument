// The notes of an osu!mania .osu for the key-lines widget: [{ t, col, end }] sorted by time (end = null for a tap).
// Only [HitObjects] and CircleSize are read. Lane from x: floor(x * keys / 512), clamped.

export function parseManiaNotes(osuText) {
    const lines = String(osuText ?? "").split(/\r?\n/);
    let section = "";
    let keys = 4;
    const notes = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("//")) continue;
        const head = /^\[(\w+)\]$/.exec(line);
        if (head) {
            section = head[1];
            continue;
        }
        if (section === "Difficulty") {
            const m = /^CircleSize\s*:\s*([\d.]+)/.exec(line);
            if (m) keys = Math.max(1, Math.min(18, Math.trunc(Number(m[1])) || 4));
        } else if (section === "HitObjects") {
            const parts = line.split(",");
            const x = Number(parts[0]);
            const t = Number(parts[2]);
            const type = Number(parts[3]);
            if (!Number.isFinite(x) || !Number.isFinite(t) || !Number.isFinite(type)) continue;
            const col = Math.max(0, Math.min(keys - 1, Math.floor((x * keys) / 512)));
            // a hold note (type bit 128) keeps its end time before the first ':' of the last field
            const end = type & 128 ? Number(String(parts[5] ?? "").split(":")[0]) : NaN;
            notes.push({ t, col, end: Number.isFinite(end) && end > t ? end : null });
        }
    }
    notes.sort((a, b) => a.t - b.t || a.col - b.col);
    return { keys, notes };
}
