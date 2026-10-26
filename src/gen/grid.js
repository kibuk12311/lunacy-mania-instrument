// Note grids. A song's timing is a list of sections (red lines); each beat is cut into 4, 3, 6 or 8 slots.
const EPS = 1e-6;

// 1/4-beat grid of a constant-BPM song.
export function buildSlots({ bpm, offsetMs, startMs = offsetMs, endMs }) {
    const step = 60000 / bpm / 4;
    const first = Math.ceil((startMs - offsetMs) / step - 1e-9);
    const slots = [];
    for (let k = Math.max(0, first); ; k += 1) {
        const t = offsetMs + k * step;
        if (t > endMs + 1e-6) break;
        slots.push({ t: Math.round(t), beat: Math.floor(k / 4), sub: k % 4 });
    }
    return slots;
}

// Uninherited ("red") timing points of an .osu: [{ time, beatLength }] sorted by time.
export function parseRedTimingPoints(osuText) {
    const lines = osuText.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === "[TimingPoints]");
    if (start < 0) return [];
    const points = [];
    for (let i = start + 1; i < lines.length && !lines[i].startsWith("["); i += 1) {
        const p = lines[i].split(",");
        if (p.length < 2) continue;
        const time = Number(p[0]);
        const beatLength = Number(p[1]);
        const uninherited = p[6] === undefined || p[6].trim() === "1";
        if (uninherited && beatLength > 0 && Number.isFinite(time)) points.push({ time, beatLength });
    }
    return points.sort((a, b) => a.time - b.time);
}

// 1/4 grid that restarts at every red timing point; each slot carries the BPM of its section.
export function buildSlotsFromTiming(points, endMs) {
    const slots = [];
    points.forEach((p, idx) => {
        const until = idx + 1 < points.length ? points[idx + 1].time : endMs + 1e-6;
        const step = p.beatLength / 4;
        const bpm = 60000 / p.beatLength;
        for (let k = 0; ; k += 1) {
            const t = p.time + k * step;
            if (t >= until - 1e-6 || t > endMs + 1e-6) break;
            slots.push({ t: Math.round(t), beat: Math.floor(k / 4), sub: k % 4, bpm });
        }
    });
    return slots;
}

// Timing ({ sections } or the old { bpm, offsetMs }) → its sections, sorted, each with a meter.
export function timingSections(timing) {
    const raw = timing?.sections?.length ? timing.sections : [{ timeMs: timing.offsetMs, bpm: timing.bpm }];
    return raw.map((s) => ({ timeMs: s.timeMs, bpm: s.bpm, meter: s.meter ?? 4 })).sort((a, b) => a.timeMs - b.timeMs);
}

// Sections → red points [{ time, beatLength, meter, bpm }]; the beat length keeps full precision.
export function sectionsToPoints(sections) {
    return sections.map((s) => ({ time: s.timeMs, beatLength: 60000 / s.bpm, meter: s.meter ?? 4, bpm: s.bpm }));
}

// Red points of an .osu → Timing (the mirrors are the first section's).
export function timingFromPoints(points) {
    const sections = points.map((p) => ({ timeMs: p.time, bpm: p.bpm ?? 60000 / p.beatLength, meter: p.meter ?? 4 }));
    return { sections, bpm: sections[0]?.bpm, offsetMs: sections[0]?.timeMs };
}

// Every beat from the first red point to endMs: { t, beatMs, bpm, index, meter } plus what slotsForBeats needs
// (`start` and `j`: the red point's time and the beat's number inside it; slots stop before `stopMs` and after `endMs`).
// The bounds are buildSlotsFromTiming's: the next red line is exclusive, so is endMs after the last one.
export function beatsFromTiming(points, endMs) {
    const beats = [];
    points.forEach((p, idx) => {
        const stopMs = (idx + 1 < points.length ? points[idx + 1].time : endMs + EPS) - EPS;
        const bpm = p.bpm ?? 60000 / p.beatLength;
        for (let j = 0; ; j += 1) {
            const t = p.time + j * p.beatLength;
            if (t >= stopMs || t > endMs + EPS) break;
            beats.push({ t, beatMs: p.beatLength, bpm, index: beats.length, meter: p.meter ?? 4, start: p.time, j, stopMs, endMs });
        }
    });
    return beats;
}

// Beats → slots { t, beat, sub, div, pos, bpm, beatMs }. divOf(beatIndex, beat) is the beat's divisor (4, 3, 6 or 8).
// `t` is computed like buildSlotsFromTiming does (red point + k·step), so an all-1/4 grid is the same to the bit;
// `beat` is the global beat index and `sub` the nearest quarter of the beat.
export function slotsForBeats(beats, divOf = () => 4) {
    const slots = [];
    for (const b of beats) {
        const div = divOf(b.index, b) || 4;
        const step = b.beatMs / div;
        for (let pos = 0; pos < div; pos += 1) {
            const t = b.start + (b.j * div + pos) * step;
            if (pos > 0 && (t >= b.stopMs || t > b.endMs + EPS)) break;
            slots.push({ t: Math.round(t), beat: b.index, sub: Math.round((pos * 4) / div) % 4, div, pos, bpm: b.bpm, beatMs: b.beatMs });
        }
    }
    return slots;
}

export function slotsForTiming(timing, endMs, { divOf = () => 4 } = {}) {
    return slotsForBeats(beatsFromTiming(sectionsToPoints(timingSections(timing)), endMs), divOf);
}

// Grid line times (ms, not rounded) in [fromMs, toMs) at 1/div of each section's beat, for hearing the timing.
// Before the first red line the first section's grid runs backwards, as in osu!.
export function clickTimes(points, fromMs, toMs, div = 1) {
    const out = [];
    points.forEach((p, idx) => {
        const until = Math.min(toMs, idx + 1 < points.length ? points[idx + 1].time : Infinity);
        const step = p.beatLength / div;
        const first = Math.ceil((fromMs - p.time) / step - 1e-9);
        for (let k = idx === 0 ? first : Math.max(0, first); ; k += 1) {
            const t = p.time + k * step;
            if (t >= until - EPS) break;
            if (t >= fromMs - EPS) out.push(t);
        }
    });
    return out;
}
