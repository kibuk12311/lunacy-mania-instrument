// How busy the music is at each grid slot, shaped by the "Выносливость" (stamina) and "Всплески" (burst) sliders.
import { hasOwnCharacter, characterOf } from "./request.js";

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

// A song part's own «Характер» (request.js: a part's stamina / burst): `values`, shaped by the whole map's sliders over
// the whole song, take shape(that part's character) — over the whole song too, so its scale stays the song's — at that
// part's slots only (partOf: the part of each slot); the other parts keep the whole map's. No part with a character of
// its own: `values` as they are, the same array.
export function withPartCharacter(values, { parts, partOf, request, shape }) {
    const shaped = new Map(); // one shape per distinct character
    parts.forEach((part, k) => {
        if (!hasOwnCharacter(part)) return;
        const character = characterOf(part, request);
        const key = `${character.stamina}/${character.burst}`;
        if (!shaped.has(key)) shaped.set(key, shape({ ...request, ...character }));
        const own = shaped.get(key);
        for (let i = 0; i < values.length; i += 1) if (partOf[i] === k) values[i] = own[i];
    });
    return values;
}

const ACTIVITY_BEATS = 2; // ±2 beats: a quiet bar or a rush in the music, not the single hits
const ACTIVITY_LOW = 0.1;
const ACTIVITY_HIGH = 0.9;

// How busy each slot is against the rest of its own part: the onset strength over ±2 beats of that part, 0 at the part's
// calmest tenth … 1 at its busiest. A part's own «Характер» on the learned generator works on this scale: slotEnergy is
// the song's, and a drop sits at ≈ 1 from end to end (real songs: p10–p90 of 0.68–1.0 and 0.91–1.0), so on it the sliders
// had nothing to tell apart. A part with no such difference: 0.5 all over.
export function partActivity(strengths, slots, partOf) {
    const n = slots.length;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + strengths[i];
    const busy = new Float64Array(n);
    let a = 0;
    let b = 0;
    for (let i = 0; i < n; i += 1) {
        const reach = ACTIVITY_BEATS * slots[i].beatMs;
        while (a < i && (slots[i].t - slots[a].t > reach || partOf[a] !== partOf[i])) a += 1;
        b = Math.max(b, i + 1);
        while (b < n && slots[b].t - slots[i].t <= reach && partOf[b] === partOf[i]) b += 1;
        while (b > i + 1 && (slots[b - 1].t - slots[i].t > reach || partOf[b - 1] !== partOf[i])) b -= 1;
        busy[i] = (prefix[b] - prefix[a]) / (b - a);
    }
    const out = new Float64Array(n).fill(0.5);
    for (let i0 = 0; i0 < n;) {
        let i1 = i0 + 1;
        while (i1 < n && partOf[i1] === partOf[i0]) i1 += 1;
        const own = busy.slice(i0, i1);
        const low = percentile(own, ACTIVITY_LOW);
        const span = percentile(own, ACTIVITY_HIGH) - low;
        if (span > 0) for (let i = i0; i < i1; i += 1) out[i] = Math.min(1, Math.max(0, (busy[i] - low) / span));
        i0 = i1;
    }
    return out;
}

// The mean of `values` over each of `count` parts (partOf: the part of each slot); a part with no slots: 0.5.
export function partMeans(values, partOf, count) {
    const sum = new Float64Array(count);
    const n = new Int32Array(count);
    for (let i = 0; i < values.length; i += 1) {
        sum[partOf[i]] += values[i];
        n[partOf[i]] += 1;
    }
    return Float64Array.from(sum, (v, k) => (n[k] ? v / n[k] : 0.5));
}
