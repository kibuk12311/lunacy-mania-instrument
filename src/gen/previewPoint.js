// Where osu!'s song select starts playing the song (PreviewTime), picked when a song loads (mapgen v3, stream C):
// the start of the loudest drop part, else the start of the loudest 15 s, snapped back to a bar line.
// Never in the first 10% nor in the last 15 s; songs under 30 s take 40% like the generator always did.

const SHORT_SONG_MS = 30000;
const TAIL_MS = 15000;
const HEAD_SHARE = 0.1;
const SCAN_STEP_MS = 250;
const NEAR_BEST = 0.9; // windows this close to the loudest count as just as loud …
const RISE_MS = 2500; // … and of those the one that starts where the music gets louder wins

// mean power over [fromMs, toMs) in O(1): RMS loudness when the envelope has it, else the onset strength
function loudness(envelope) {
    const level = envelope?.energy?.length ? envelope.energy : (envelope?.values ?? []);
    const hop = envelope?.hopSec > 0 ? envelope.hopSec : 0.01;
    const t0 = typeof envelope?.frameTimeSec === "function" ? envelope.frameTimeSec(0) : 0;
    const prefix = new Float64Array(level.length + 1);
    for (let i = 0; i < level.length; i += 1) prefix[i + 1] = prefix[i] + level[i] * level[i];
    const frame = (ms) => Math.max(0, Math.min(level.length, Math.round((ms / 1000 - t0) / hop)));
    return (fromMs, toMs) => {
        const a = frame(fromMs);
        const b = Math.max(a + 1, frame(toMs));
        return b > level.length ? 0 : (prefix[b] - prefix[a]) / (b - a);
    };
}

// Timing or the old {bpm, offsetMs} → the bar line at or before `ms` on the section that holds it.
function barAtOrBefore(ms, timing) {
    const sections = timing?.sections ?? (Number(timing?.bpm) > 0 ? [{ timeMs: Number(timing.offsetMs) || 0, bpm: timing.bpm, meter: 4 }] : []);
    if (!sections.length) return ms;
    let s = sections[0];
    for (const next of sections) if (next.timeMs <= ms) s = next;
    const bar = (60000 / s.bpm) * (s.meter ?? 4);
    const at = s.timeMs + Math.floor((ms - s.timeMs) / bar + 1e-9) * bar;
    return Math.max(0, at);
}

export function pickPreviewMs(envelope, { timing = null, durationMs, parts = [], windowSec = 15 } = {}) {
    const total = Number(durationMs);
    if (!Number.isFinite(total) || total <= 0) return 0;
    if (total < SHORT_SONG_MS) return Math.round(total * 0.4);
    const mean = loudness(envelope);
    const lastStart = total - TAIL_MS;

    const drops = (parts ?? []).filter((p) => p?.kind === "drop" && p.startMs >= 0 && p.startMs <= lastStart);
    if (drops.length) {
        const loudest = drops.reduce((best, p) => (mean(p.startMs, p.endMs) > mean(best.startMs, best.endMs) ? p : best));
        return Math.round(loudest.startMs);
    }

    const windowMs = windowSec * 1000;
    const minStart = total * HEAD_SHARE;
    let maxStart = lastStart - windowMs;
    if (maxStart < minStart) maxStart = Math.max(minStart, lastStart);
    const starts = [];
    for (let s = minStart; s <= maxStart + 1e-6; s += SCAN_STEP_MS) starts.push(s);
    const means = starts.map((s) => mean(s, s + windowMs));
    const top = Math.max(...means);
    let pick = starts[0];
    let bestRise = -Infinity;
    starts.forEach((s, i) => {
        if (means[i] < top * NEAR_BEST) return;
        const rise = mean(s, s + RISE_MS) - mean(s - RISE_MS, s);
        if (rise > bestRise + 1e-12) {
            bestRise = rise;
            pick = s;
        }
    });
    return Math.round(barAtOrBefore(pick, timing));
}
