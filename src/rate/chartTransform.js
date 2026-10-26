// Chart changes a rate copy can carry before the rate itself: mirrored columns and holds turned into plain notes.
// Only [HitObjects] lines change; every other line and the line endings stay as they were.

const HOLD = 128;
const NOTE = 1;

// Calls fn(parts) for every object line in [HitObjects]; fn returns the new parts or nothing to keep the line.
function mapObjects(text, fn) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    let inObjects = false;
    return text.split(/\r?\n/).map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            inObjects = trimmed === "[HitObjects]";
            return line;
        }
        if (!inObjects || !trimmed || trimmed.startsWith("//")) return line;
        const parts = line.split(",");
        if (parts.length < 5) return line;
        const out = fn(parts);
        return out ? out.join(",") : line;
    }).join(eol);
}

function columnCount(text) {
    const keys = Math.round(Number(/^CircleSize\s*:\s*([\d.]+)/m.exec(text)?.[1]));
    return Number.isFinite(keys) && keys >= 1 ? keys : null;
}

// Columns the other way round: col = floor(x·keys/512), x' = the centre of lane keys-1-col.
export function mirrorOsu(text) {
    const keys = columnCount(text);
    if (!keys) return text;
    return mapObjects(text, (p) => {
        const x = Number(p[0]);
        if (!Number.isFinite(x)) return null;
        const col = Math.min(keys - 1, Math.max(0, Math.floor((x * keys) / 512)));
        p[0] = String(Math.floor(((keys - 1 - col + 0.5) * 512) / keys));
        return p;
    });
}

// Every hold becomes a note at its head: type (t & ~128) | 1, the end time leaves the extras
// ("…,128,0,3600:0:0:0:0:" → "…,1,0,0:0:0:0:").
export function noLnOsu(text) {
    return mapObjects(text, (p) => {
        const type = Number(p[3]);
        if (!(type & HOLD)) return null;
        p[3] = String((type & ~HOLD) | NOTE);
        if (p[5] !== undefined) p[5] = p[5].split(":").slice(1).join(":");
        return p;
    });
}

// No change asked → the very same text, so its analysis shares the cache with the plain map.
export function transformOsu(text, { mirror = false, noLn = false } = {}) {
    let out = text;
    if (noLn) out = noLnOsu(out);
    if (mirror) out = mirrorOsu(out);
    return out;
}

// The difficulty-name tail of a copy: " NC Mirror NoLN" (empty when nothing is on).
export function transformSuffix({ pitch = false, mirror = false, noLn = false } = {}) {
    return [pitch && "NC", mirror && "Mirror", noLn && "NoLN"].filter(Boolean).map((s) => ` ${s}`).join("");
}

// Holds among all hit objects, 0…1.
export function lnShare(text) {
    let all = 0;
    let holds = 0;
    mapObjects(String(text ?? ""), (p) => {
        all += 1;
        if (Number(p[3]) & HOLD) holds += 1;
        return null;
    });
    return all ? holds / all : 0;
}
