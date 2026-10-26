// Synthetic mono audio: short noise clicks on every beat (accented downbeats), for tempo/onset tests.
// Options on top of the beats:
//   div      — quieter clicks between the beats at every 1/div (4 = 1/4 notes);
//   triplets — [{ fromMs, toMs }]: beats starting in these ranges get clicks at 1/3 and 2/3 instead;
//   hats     — [{ fromMs, toMs, div }]: short high ticks at every 1/div (a hi-hat, no low end).
const asList = (x) => (Array.isArray(x) ? x : x ? [x] : []);

function noise(seed) {
    let s = seed;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

function click(out, sampleRate, rand, tMs, amp) {
    const start = Math.round((tMs / 1000) * sampleRate);
    for (let k = 0; k < 400 && start + k < out.length; k += 1) if (start + k >= 0) out[start + k] += amp * rand() * Math.exp(-k / 80);
}

function tick(out, sampleRate, rand, tMs, amp) {
    const start = Math.round((tMs / 1000) * sampleRate);
    for (let k = 0; k < 120 && start + k < out.length; k += 1) {
        const white = rand();
        if (start + k >= 0) out[start + k] += (k % 2 ? white : -white) * amp * Math.exp(-k / 30);
    }
}

function extras(out, sampleRate, rand, beats, { div = 1, triplets = [], hats = [] }) {
    const inside = (ranges, t) => asList(ranges).find((r) => t >= r.fromMs && t < r.toMs);
    for (const { t, beatMs } of beats) {
        const parts = inside(triplets, t) ? 3 : div;
        for (let k = 1; k < parts; k += 1) click(out, sampleRate, rand, t + (k * beatMs) / parts, 0.4);
        const hat = inside(hats, t);
        if (hat) for (let k = 0; k < hat.div; k += 1) tick(out, sampleRate, rand, t + (k * beatMs) / hat.div, 0.5);
    }
}

export function clickTrack({ bpm, offsetMs, seconds, sampleRate = 22050, seed = 1, ...options }) {
    const out = new Float32Array(Math.round(seconds * sampleRate));
    const rand = noise(seed);
    const beat = 60000 / bpm;
    const beats = [];
    for (let i = 0, t = offsetMs; t < seconds * 1000; i += 1, t += beat) {
        const start = Math.round((t / 1000) * sampleRate);
        const amp = i % 4 === 0 ? 1 : 0.6;
        for (let k = 0; k < 400 && start + k < out.length; k += 1) out[start + k] += amp * rand() * Math.exp(-k / 80);
        beats.push({ t, beatMs: beat });
    }
    extras(out, sampleRate, rand, beats, options);
    for (let i = 0; i < out.length; i += 1) out[i] += rand() * 0.01;
    return { samples: out, sampleRate };
}

// Clicks that follow a tempo map: sections [{ timeMs, bpm }], each running until the next one starts.
export function tempoMapTrack(sections, { seconds, sampleRate = 22050, seed = 1, ...options }) {
    const out = new Float32Array(Math.round(seconds * sampleRate));
    const rand = noise(seed);
    const beats = [];
    sections.forEach((s, idx) => {
        const until = Math.min(seconds * 1000, sections[idx + 1]?.timeMs ?? Infinity);
        const beatMs = 60000 / s.bpm;
        for (let i = 0; s.timeMs + i * beatMs < until - 1e-6; i += 1) {
            const t = s.timeMs + i * beatMs;
            click(out, sampleRate, rand, t, i % 4 === 0 ? 1 : 0.6);
            beats.push({ t, beatMs });
        }
    });
    extras(out, sampleRate, rand, beats, options);
    for (let i = 0; i < out.length; i += 1) out[i] += rand() * 0.01;
    return { samples: out, sampleRate };
}
