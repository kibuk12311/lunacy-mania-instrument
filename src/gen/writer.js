// Rows → .osu (v14, osu!mania 4K): one red line per timing section, green lines that keep the scroll speed even
// across BPM changes, and break periods.
const columnX = (c) => Math.floor(((c + 0.5) * 512) / 4);
const clean = (s) => String(s ?? "").replace(/[\r\n]/g, " ").trim();
const maskToCols = (m) => [0, 1, 2, 3].filter((c) => m & (1 << c));

const MIN_BREAK_MS = 3000;
const BREAK_CLEAR_MS = 200; // a break starts this long after the last note and ends this long before the next

// The editor's beat divisor for the grids a map uses: 1/3 and 1/6 need 12, 1/8 needs 8.
export function beatDivisorFor(divs) {
    const used = new Set(divs);
    if (used.has(3) || used.has(6)) return 12;
    if (used.has(8)) return 8;
    return 4;
}

// The BPM that holds longest between the first and the last note: osu! scales the scroll speed by it
// (the same rule as dominantBeat in src/core/features.js).
function dominantBeatLength(points, rows) {
    const first = rows.length ? rows[0].t : 0;
    const last = rows.length ? rows.at(-1).t : 0;
    const weight = new Map();
    points.forEach((p, i) => {
        const from = Math.max(p.time, first);
        const to = i + 1 < points.length ? Math.min(points[i + 1].time, last) : last;
        const span = Math.max(0, to - from) + (i === 0 ? 1e-6 : 0);
        weight.set(p.beatLength, (weight.get(p.beatLength) ?? 0) + span);
    });
    let best = null;
    for (const [beatLength, w] of weight) if (best === null || w > weight.get(best)) best = beatLength;
    return best;
}

function timingLines(points, rows, normalizeSv) {
    const mainBpm = 60000 / dominantBeatLength(points, rows);
    const lines = [];
    for (const p of points) {
        const time = Math.round(p.time);
        const meter = p.meter ?? 4;
        lines.push(`${time},${p.beatLength},${meter},2,0,60,1,0`);
        const bpm = 60000 / p.beatLength;
        if (normalizeSv && Math.abs(bpm - mainBpm) > 1e-6 * mainBpm) lines.push(`${time},${(-100 * bpm) / mainBpm},${meter},2,0,60,0,0`);
    }
    return lines;
}

// Each wanted break ([start, end] or { startMs, endMs }) becomes the longest stretch of it that is clear of notes,
// kept only when it lasts MIN_BREAK_MS; there are no breaks before the first note or after the last.
function breakLines(breaks, rows) {
    const times = rows.map((r) => r.t);
    const out = [];
    for (const b of breaks) {
        const [from, to] = Array.isArray(b) ? b : [b.startMs, b.endMs];
        let best = null;
        for (let i = 0; i + 1 < times.length; i += 1) {
            const start = Math.max(from, times[i] + BREAK_CLEAR_MS);
            const end = Math.min(to, times[i + 1] - BREAK_CLEAR_MS);
            if (end - start >= MIN_BREAK_MS && (!best || end - start > best[1] - best[0])) best = [start, end];
        }
        if (best) out.push(best.map(Math.round));
    }
    return out.sort((a, b) => a[0] - b[0]).map(([s, e]) => `2,${s},${e}`);
}

export function toOsu({
    rows, timingPoints = null, bpm, offsetMs, normalizeSv = true, breaks = [], beatDivisor = 4,
    title, artist = "Unknown", version, audioFilename, creator = "Lunacy mania", previewMs = -1,
}) {
    const sorted = [...rows].sort((a, b) => a.t - b.t);
    const objects = [];
    for (const row of sorted) {
        for (const c of row.cols ?? maskToCols(row.mask)) objects.push(`${columnX(c)},192,${row.t},1,0,0:0:0:0:`);
    }
    const points = timingPoints?.length ? timingPoints : [{ time: offsetMs, beatLength: 60000 / bpm, meter: 4 }];
    return [
        "osu file format v14",
        "",
        "[General]",
        `AudioFilename: ${clean(audioFilename)}`,
        "AudioLeadIn: 0",
        `PreviewTime: ${Math.round(previewMs)}`,
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
        `BeatDivisor: ${beatDivisor}`,
        "GridSize: 4",
        "",
        "[Metadata]",
        `Title:${clean(title)}`,
        `TitleUnicode:${clean(title)}`,
        `Artist:${clean(artist)}`,
        `ArtistUnicode:${clean(artist)}`,
        `Creator:${clean(creator)}`,
        `Version:${clean(version)}`,
        "Source:",
        "Tags:lunacy-mania generated",
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
        ...breakLines(breaks, sorted),
        "",
        "[TimingPoints]",
        ...timingLines(points, sorted, normalizeSv),
        "",
        "[HitObjects]",
        ...objects,
        "",
    ].join("\r\n");
}
