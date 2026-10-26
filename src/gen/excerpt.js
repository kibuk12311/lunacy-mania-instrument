// A part played on its own: its rows repeated until the excerpt lasts 30 s and has 80 notes (at most 120 s),
// as an .osu, so a part's dan can be measured "as if played on its own".
import { toOsu } from "./writer.js";
import { timingSections, sectionsToPoints } from "./grid.js";

const MIN_MS = 30000;
const MIN_NOTES = 80;
const MAX_MS = 120000;

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const maskOf = (row) => row.mask ?? (row.cols ?? []).reduce((m, c) => m | (1 << c), 0);

// How many times the part is played: enough for MIN_MS and MIN_NOTES, never past MAX_MS (at least once).
export function excerptCopies(lengthMs, notes) {
    let copies = 1;
    while ((copies * lengthMs < MIN_MS || copies * notes < MIN_NOTES) && (copies + 1) * lengthMs <= MAX_MS) copies += 1;
    return copies;
}

export function excerptOsu(rows, part, timing, { title = "excerpt", version = "excerpt" } = {}) {
    const inside = rows.filter((r) => r.t >= part.startMs && r.t < part.endMs);
    const length = part.endMs - part.startMs;
    const notes = inside.reduce((s, r) => s + popcount(maskOf(r)), 0);
    const copies = excerptCopies(length, notes);
    // the sections that play during the part, each red line on its first beat inside the part
    const sections = timingSections(timing);
    const active = sections.filter((s, i) => s.timeMs < part.endMs && (sections[i + 1]?.timeMs ?? Infinity) > part.startMs);
    const lines = active.map((s) => {
        const beatMs = 60000 / s.bpm;
        const first = s.timeMs >= part.startMs ? s.timeMs : s.timeMs + Math.ceil((part.startMs - s.timeMs) / beatMs - 1e-9) * beatMs;
        return { ...s, timeMs: first - part.startMs };
    }).filter((s, i, all) => i === 0 || s.timeMs > all[i - 1].timeMs);
    const out = [];
    const points = [];
    for (let k = 0; k < copies; k += 1) {
        const base = k * length;
        for (const r of inside) out.push({ t: Math.round(r.t - part.startMs + base), mask: maskOf(r) });
        for (const s of lines) points.push({ timeMs: Math.max(0, s.timeMs) + base, bpm: s.bpm, meter: s.meter });
    }
    return toOsu({
        rows: out, timingPoints: sectionsToPoints(points), normalizeSv: false,
        title, version, audioFilename: "excerpt.mp3",
    });
}
