// Synthetic mono tracks for the stems and structure tests (22,050 Hz). Every generator returns the mix and the times
// of its events, and the parts separately where a test measures where their energy lands.
export const SR = 22050;

export const NOTE_HZ = { C3: 130.81, E3: 164.81, G3: 196.0, C5: 523.25, E5: 659.26, G5: 783.99 };

function noise(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

const add = (out, part) => {
    for (let i = 0; i < out.length; i += 1) out[i] += part[i];
    return out;
};

// RBJ biquad high-pass, run `stages` times (12 dB/octave each).
function highPass(x, sampleRate, hz, stages = 4) {
    const w0 = (2 * Math.PI * hz) / sampleRate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    const b0 = (1 + cos) / 2 / a0;
    const b1 = -(1 + cos) / a0;
    const b2 = b0;
    const a1 = (-2 * cos) / a0;
    const a2 = (1 - alpha) / a0;
    let y = Float32Array.from(x);
    for (let s = 0; s < stages; s += 1) {
        const out = new Float32Array(y.length);
        let x1 = 0;
        let x2 = 0;
        let y1 = 0;
        let y2 = 0;
        for (let i = 0; i < y.length; i += 1) {
            const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = y[i];
            y2 = y1;
            y1 = v;
            out[i] = v;
        }
        y = out;
    }
    return y;
}

const eventTimes = (seconds, everyMs, firstMs) => {
    const times = [];
    for (let t = firstMs; t < seconds * 1000 - 300; t += everyMs) times.push(t);
    return times;
};

function sine(n, sampleRate, hz, amp) {
    return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sampleRate));
}

// A steady 440 Hz sine plus short broadband clicks: { samples, sine, clicks, clickTimesMs }.
export function sineWithClicks({ seconds = 6, hz = 440, amp = 0.3, everyMs = 500, firstMs = 250, clickAmp = 0.8, sampleRate = SR, seed = 3 } = {}) {
    const n = Math.round(seconds * sampleRate);
    const tone = sine(n, sampleRate, hz, amp);
    const clicks = new Float32Array(n);
    const rand = noise(seed);
    const clickTimesMs = eventTimes(seconds, everyMs, firstMs);
    for (const t of clickTimesMs) {
        const start = Math.round((t / 1000) * sampleRate);
        for (let k = 0; k < 400 && start + k < n; k += 1) clicks[start + k] += clickAmp * rand() * Math.exp(-k / 60);
    }
    return { samples: add(Float32Array.from(tone), clicks), sine: tone, clicks, clickTimesMs, sampleRate };
}

// Decaying low sine bursts (a kick drum without its click).
function kicks(n, sampleRate, times, { hz = 60, amp = 0.9, decayMs = 70 } = {}) {
    const out = new Float32Array(n);
    const decay = (decayMs / 1000) * sampleRate;
    for (const t of times) {
        const start = Math.round((t / 1000) * sampleRate);
        for (let k = 0; k < 6 * decay && start + k < n; k += 1) out[start + k] += amp * Math.sin((2 * Math.PI * hz * k) / sampleRate) * Math.exp(-k / decay);
    }
    return out;
}

// High-passed (above about 6 kHz) noise bursts: a hi-hat.
function hats(n, sampleRate, times, { amp = 0.5, seed = 5 } = {}) {
    const raw = new Float32Array(n);
    const rand = noise(seed);
    for (const t of times) {
        const start = Math.round((t / 1000) * sampleRate);
        for (let k = 0; k < 900 && start + k < n; k += 1) raw[start + k] += amp * rand() * Math.exp(-k / 150);
    }
    return highPass(raw, sampleRate, 6500);
}

// Broadband noise plus a 200 Hz tone, both short: a snare.
function snares(n, sampleRate, times, { amp = 0.5, toneAmp = 0.5, seed = 7 } = {}) {
    const out = new Float32Array(n);
    const rand = noise(seed);
    for (const t of times) {
        const start = Math.round((t / 1000) * sampleRate);
        for (let k = 0; k < 3000 && start + k < n; k += 1) {
            out[start + k] += amp * rand() * Math.exp(-k / 400) + toneAmp * Math.sin((2 * Math.PI * 200 * k) / sampleRate) * Math.exp(-k / 500);
        }
    }
    return out;
}

const floor = (x, seed) => {
    const rand = noise(seed);
    for (let i = 0; i < x.length; i += 1) x[i] += 0.002 * rand();
    return x;
};

export function kickTrack({ seconds = 8, everyMs = 500, firstMs = 250, sampleRate = SR } = {}) {
    const times = eventTimes(seconds, everyMs, firstMs);
    return { samples: floor(kicks(Math.round(seconds * sampleRate), sampleRate, times), 11), times, sampleRate };
}

export function hatTrack({ seconds = 8, everyMs = 250, firstMs = 250, sampleRate = SR } = {}) {
    const times = eventTimes(seconds, everyMs, firstMs);
    return { samples: floor(hats(Math.round(seconds * sampleRate), sampleRate, times), 12), times, sampleRate };
}

export function snareTrack({ seconds = 8, everyMs = 500, firstMs = 250, sampleRate = SR } = {}) {
    const times = eventTimes(seconds, everyMs, firstMs);
    return { samples: floor(snares(Math.round(seconds * sampleRate), sampleRate, times), 13), times, sampleRate };
}

// A rock beat at `bpm`: kicks on beats 1 and 3, snares on 2 and 4, hats on the off-beat eighths.
export function drumLoop({ seconds = 12, bpm = 120, firstMs = 250, sampleRate = SR } = {}) {
    const n = Math.round(seconds * sampleRate);
    const beat = 60000 / bpm;
    const all = eventTimes(seconds, beat, firstMs);
    const kickTimes = all.filter((_, i) => i % 2 === 0);
    const snareTimes = all.filter((_, i) => i % 2 === 1);
    const hatTimes = all.map((t) => t + beat / 2).filter((t) => t < seconds * 1000 - 300);
    const out = kicks(n, sampleRate, kickTimes);
    add(out, snares(n, sampleRate, snareTimes, { amp: 0.4, toneAmp: 0.4 }));
    add(out, hats(n, sampleRate, hatTimes, { amp: 0.4 }));
    return { samples: floor(out, 14), kicks: kickTimes, snares: snareTimes, hats: hatTimes, sampleRate };
}

// Steady sines (a held chord).
export function chordTrack(freqs, { seconds = 4, amp = 0.2, sampleRate = SR } = {}) {
    const n = Math.round(seconds * sampleRate);
    const out = new Float32Array(n);
    for (const hz of freqs) add(out, sine(n, sampleRate, hz, amp));
    return { samples: floor(out, 15), sampleRate };
}

// A song made of sections of `barsPerSection` 4/4 bars at `bpm` starting at 0 ms. Each section letter has its own
// chord (three sines, changing every 2 bars inside the section) over the same drum loop; a primed letter (B′) is
// its letter with the last bar's chord replaced. Returns { samples, bpm, barMs, sections: [{ letter, bar }] }.
const SECTION_CHORDS = {
    A: [[261.63, 329.63, 392.0], [220.0, 261.63, 329.63]],
    B: [[349.23, 440.0, 523.25], [293.66, 369.99, 440.0]],
    C: [[311.13, 392.0, 466.16], [233.08, 293.66, 349.23]],
};
const VARIANT_CHORD = [246.94, 311.13, 369.99];

export function sectionSong(letters = ["A", "B", "A", "B'"], { bpm = 120, barsPerSection = 8, drums = true, sampleRate = SR } = {}) {
    const barMs = (4 * 60000) / bpm;
    const seconds = (letters.length * barsPerSection * barMs) / 1000 + 0.5;
    const n = Math.round(seconds * sampleRate);
    const out = new Float32Array(n);
    const sections = [];
    letters.forEach((letter, s) => {
        const base = SECTION_CHORDS[letter[0]];
        for (let b = 0; b < barsPerSection; b += 1) {
            const bar = s * barsPerSection + b;
            const variant = letter.endsWith("'") && b === barsPerSection - 1;
            const chord = variant ? VARIANT_CHORD : base[Math.floor(b / 2) % base.length];
            const i0 = Math.round(((bar * barMs) / 1000) * sampleRate);
            const i1 = Math.min(n, Math.round((((bar + 1) * barMs) / 1000) * sampleRate));
            for (let i = i0; i < i1; i += 1) {
                let v = 0;
                for (const hz of chord) v += Math.sin((2 * Math.PI * hz * i) / sampleRate);
                out[i] += 0.08 * v;
            }
        }
        sections.push({ letter, bar: s * barsPerSection });
    });
    if (drums) {
        const loop = drumLoop({ seconds, bpm, firstMs: 0, sampleRate });
        add(out, Float32Array.from(loop.samples, (x) => 0.6 * x));
    }
    return { samples: floor(out, 16), bpm, barMs, sections, sampleRate };
}

// The same 1-bar beat for the whole song, nothing else.
export function flatClickSong({ bars = 32, bpm = 120, sampleRate = SR } = {}) {
    const seconds = (bars * 4 * 60) / bpm + 0.5;
    const n = Math.round(seconds * sampleRate);
    const rand = noise(21);
    const out = new Float32Array(n);
    for (let t = 0; t < seconds * 1000 - 200; t += 60000 / bpm) {
        const start = Math.round((t / 1000) * sampleRate);
        for (let k = 0; k < 400 && start + k < n; k += 1) out[start + k] += 0.7 * rand() * Math.exp(-k / 80);
    }
    return { samples: floor(out, 22), bpm, sampleRate };
}
