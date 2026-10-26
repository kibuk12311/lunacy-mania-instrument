// How busy the music is at each grid slot, shaped by the "Выносливость" (stamina) and "Всплески" (burst) sliders.

const BREAK_LEVEL = 0.05;
const BREAK_WINDOW = 8; // slots = 2 beats

// Raw onset strength at each slot: the strongest envelope frame within ±12 ms of the slot time.
export function slotStrengths(envelope, slots) {
    return strengthsAt(envelope.values, envelope.frameTimeSec, slots);
}

// Same, for any per-frame curve (e.g. one frequency band).
export function strengthsAt(values, frameTimeSec, slots) {
    const frameDur = frameTimeSec(1) - frameTimeSec(0);
    const t0 = frameTimeSec(0);
    return Float64Array.from(slots, ({ t }) => {
        const center = (t / 1000 - t0) / frameDur;
        let best = 0;
        for (let f = Math.floor(center - 0.012 / frameDur); f <= Math.ceil(center + 0.012 / frameDur); f += 1) {
            if (f >= 0 && f < values.length && values[f] > best) best = values[f];
        }
        return best;
    });
}

function percentile(values, q) {
    const sorted = Array.from(values).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

export function slotIntensity(raw, { stamina = 0.5, burst = 0.5 } = {}) {
    const n = raw.length;
    const top = percentile(raw, 0.95) || 1;
    const v = Float64Array.from(raw, (x) => Math.min(1, x / top));
    const sharp = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j += 1) {
            sum += v[j];
            count += 1;
        }
        sharp[i] = (0.5 * v[i] + 0.5 * (sum / count)) ** (1 + 2 * burst);
    }
    // Re-stretch after sharpening so peaks stay at full strength and only the quieter parts sink.
    const peak = percentile(sharp, 0.95) || 1;
    const floor = 0.7 * stamina;
    const out = Float64Array.from(sharp, (x) => floor + (1 - floor) * Math.min(1, x / peak));
    if (stamina < 0.9) {
        for (let i = 0; i < n; i += 1) {
            let sum = 0;
            let count = 0;
            for (let j = Math.max(0, i - BREAK_WINDOW / 2); j < Math.min(n, i + BREAK_WINDOW / 2); j += 1) {
                sum += v[j];
                count += 1;
            }
            if (sum / count < BREAK_LEVEL) out[i] = 0;
        }
    }
    return out;
}

const ENERGY_HALF_WINDOW_SEC = 1.3; // ≈ ±2 beats: long enough to tell a drop from a light part, short enough to follow it

// Loudness of the song part around each slot, 0 (quietest parts) … 1 (the drops), on a dB scale.
// Without `envelope.energy` (old callers) every slot counts as a drop.
export function slotEnergy(envelope, slots) {
    const { energy, frameTimeSec } = envelope;
    if (!energy?.length) return new Float64Array(slots.length).fill(1);
    const frameDur = frameTimeSec(1) - frameTimeSec(0);
    const t0 = frameTimeSec(0);
    const half = Math.max(1, Math.round(ENERGY_HALF_WINDOW_SEC / frameDur));
    // prefix sums of power for O(1) window means
    const prefix = new Float64Array(energy.length + 1);
    for (let i = 0; i < energy.length; i += 1) prefix[i + 1] = prefix[i] + energy[i] * energy[i];
    const db = Float64Array.from(slots, ({ t }) => {
        const c = Math.round((t / 1000 - t0) / frameDur);
        const a = Math.max(0, Math.min(energy.length, c - half));
        const b = Math.max(a + 1, Math.min(energy.length, c + half));
        const meanPower = (prefix[b] - prefix[a]) / (b - a);
        return 10 * Math.log10(meanPower + 1e-10);
    });
    const lo = percentile(db, 0.1);
    const hi = percentile(db, 0.9);
    const span = hi - lo;
    // A song at one constant level has no light parts.
    if (span < 1.5) return new Float64Array(slots.length).fill(1);
    return Float64Array.from(db, (x) => Math.min(1, Math.max(0, (x - lo) / span)));
}

// "Выносливость" lifts the light parts towards the drops: at full stamina there is no contrast left to rest in.
export function shapeEnergy(energy, { stamina = 0.5 } = {}) {
    const floor = 0.25 + 0.75 * stamina ** 2;
    return Float64Array.from(energy, (e) => floor + (1 - floor) * e);
}
