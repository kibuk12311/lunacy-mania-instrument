// Audio features of each grid slot. Used both to build the training set from real maps and to generate,
// so the learned mapper sees exactly the same numbers in both places. Columns are picked by name, so a model
// trained on the v1 list (all 1/4) and one trained on the v2 list (any grid) both get what they were trained on.
// v3 adds columns from the light stems (src/audio/stems.js) and the song structure (src/gen/structure.js); they are
// computed only when a name asks for them, so v1 and v2 rows stay the same to the bit.
import { strengthsAt, slotStrengths, slotEnergy } from "./intensity.js";
import { STRUCTURE_FEATURES, structureColumns } from "./structure.js";

export const AUDIO_FEATURES = [
    "sub", "is_beat", "is_half",
    "onset", "low", "mid", "high",
    "onset_prev", "onset_next", "low_prev", "low_next",
    "beat_share", "onset_local",
    "energy", "energy_delta",
    "bpm", "slot_ms",
];

// v2 adds the grid: the beat's divisor, the slot's phase in its beat, and which family of grid the beat is on
// (beat_on3 = 1/3 or 1/6).
export const AUDIO_FEATURES_V2 = [...AUDIO_FEATURES, "div", "phase", "is_third", "beat_on3", "beat_on4", "beat_on8"];

// v3 adds the stems (sampled at the slot like onset; *_share = the value over the best slot of its beat, like
// beat_share) and the structure (phrase position, echoes, novelty).
export const STEM_FEATURES = ["kick", "snare", "hat", "harm", "perc_share", "kick_share", "snare_share", "hat_share"];
export const AUDIO_FEATURES_V3 = [...AUDIO_FEATURES_V2, ...STEM_FEATURES, ...STRUCTURE_FEATURES];
const STEM_START = AUDIO_FEATURES_V2.length;
const STRUCTURE_START = STEM_START + STEM_FEATURES.length;

const ENERGY_LOOKBACK_BEATS = 4; // one bar back: entering a drop vs staying in it

// Consecutive slots of one beat form a group (old 1/4 slots have no `pos`: their `sub` is the position).
function beatGroups(slots) {
    const starts = [];
    const of = new Int32Array(slots.length);
    for (let i = 0; i < slots.length; i += 1) {
        const s = slots[i];
        const p = slots[i - 1];
        if (i === 0 || s.beat !== p.beat || (s.pos ?? s.sub) <= (p.pos ?? p.sub)) starts.push(i);
        of[i] = starts.length - 1;
    }
    starts.push(slots.length);
    return { starts, of };
}

// What feature names read beyond the onset envelope: ["stems"] and / or ["structure"] (unknown names read nothing),
// for a model file that does not list its `needs` (app/generatorJobs.js).
export function featureNeeds(names) {
    const cols = (Array.isArray(names) ? names : []).map((name) => AUDIO_FEATURES_V3.indexOf(name)).filter((k) => k >= 0);
    return [
        ...(cols.some((k) => k >= STEM_START && k < STRUCTURE_START) ? ["stems"] : []),
        ...(cols.some((k) => k >= STRUCTURE_START) ? ["structure"] : []),
    ];
}

// `stems`: Stems (stemsFromTransfer or computeStems); `structure`: songStructure's output. Each is needed only when
// `names` asks for its columns, and its absence then throws "missing stems" / "missing structure".
export function slotFeatures(envelope, slots, bpm, names = AUDIO_FEATURES, { stems = null, structure = null } = {}) {
    const cols = names.map((name) => {
        const k = AUDIO_FEATURES_V3.indexOf(name);
        if (k < 0) throw new Error(`unknown slot feature: ${name}`);
        return k;
    });
    const needStems = cols.some((k) => k >= STEM_START && k < STRUCTURE_START);
    const needStructure = cols.some((k) => k >= STRUCTURE_START);
    if (needStems && !stems) throw new Error("missing stems");
    if (needStructure && !structure) throw new Error("missing structure");
    const n = slots.length;
    const onset = slotStrengths(envelope, slots);
    const band = (name) => (envelope.bands?.[name] ? strengthsAt(envelope.bands[name], envelope.frameTimeSec, slots) : onset);
    const low = band("low");
    const mid = band("mid");
    const high = band("high");
    const energy = slotEnergy(envelope, slots);

    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + onset[i];
    const localMean = (i) => {
        const a = Math.max(0, i - 8);
        const b = Math.min(n, i + 9);
        return (prefix[b] - prefix[a]) / (b - a);
    };

    const { starts, of } = beatGroups(slots);
    const posOf = (i) => slots[i].pos ?? slots[i].sub;
    const divOf = (i) => slots[i].div ?? 4;
    const beatMax = new Float64Array(starts.length - 1);
    for (let g = 0; g + 1 < starts.length; g += 1) {
        for (let j = starts[g]; j < starts[g + 1]; j += 1) beatMax[g] = Math.max(beatMax[g], onset[j]);
    }
    // The slot at the same phase 4 beats back (i − 16 on a 1/4 grid). A beat on another grid gives its nearest phase;
    // a beat cut short (the start of the slots) without that position gives the slot itself, as before.
    const lookback = (i) => {
        const g = of[i] - ENERGY_LOOKBACK_BEATS;
        if (g < 0) return i;
        const pos = posOf(i);
        const div = divOf(i);
        let best = -1;
        let bestGap = Infinity;
        for (let j = starts[g]; j < starts[g + 1]; j += 1) {
            if (divOf(j) === div) {
                if (posOf(j) === pos) return j;
                continue;
            }
            const gap = Math.abs(posOf(j) / divOf(j) - pos / div);
            if (gap < bestGap) {
                bestGap = gap;
                best = j;
            }
        }
        return best >= 0 ? best : i;
    };

    const stemCols = needStems ? stemColumns(stems, slots, starts) : null;
    const structureByName = needStructure ? structureColumns(structure, slots) : null;
    const structureCols = structureByName ? STRUCTURE_FEATURES.map((name) => structureByName[name]) : null;

    const F = names.length;
    const rows = new Float32Array(n * F);
    const v = new Array(AUDIO_FEATURES_V3.length);
    for (let i = 0; i < n; i += 1) {
        const { sub } = slots[i];
        const pos = posOf(i);
        const div = divOf(i);
        const slotBpm = slots[i].bpm ?? bpm;
        const max = beatMax[of[i]];
        v[0] = sub;
        v[1] = pos === 0 ? 1 : 0;
        v[2] = pos * 2 === div ? 1 : 0;
        v[3] = onset[i];
        v[4] = low[i];
        v[5] = mid[i];
        v[6] = high[i];
        v[7] = i > 0 ? onset[i - 1] : 0;
        v[8] = i + 1 < n ? onset[i + 1] : 0;
        v[9] = i > 0 ? low[i - 1] : 0;
        v[10] = i + 1 < n ? low[i + 1] : 0;
        v[11] = max > 0 ? onset[i] / max : 0;
        v[12] = localMean(i);
        v[13] = energy[i];
        v[14] = energy[i] - energy[lookback(i)];
        v[15] = slotBpm;
        v[16] = 60000 / slotBpm / div;
        v[17] = div;
        v[18] = pos / div;
        v[19] = pos * 3 === div || pos * 3 === 2 * div ? 1 : 0;
        v[20] = div === 3 || div === 6 ? 1 : 0;
        v[21] = div === 4 ? 1 : 0;
        v[22] = div === 8 ? 1 : 0;
        if (stemCols) for (let k = 0; k < stemCols.length; k += 1) v[STEM_START + k] = stemCols[k][i];
        if (structureCols) for (let k = 0; k < structureCols.length; k += 1) v[STRUCTURE_START + k] = structureCols[k][i];
        for (let k = 0; k < F; k += 1) rows[i * F + k] = v[cols[k]];
    }
    return { names, rows };
}

// The stem columns in STEM_FEATURES order, one array per column. `starts` are the beat groups' first slots.
function stemColumns(stems, slots, starts) {
    const frameTimeSec = stems.frameTimeSec ?? ((f) => f * stems.hopSec + stems.frameOffsetSec);
    const at = (curve) => strengthsAt(curve, frameTimeSec, slots);
    const kick = at(stems.kick);
    const snare = at(stems.snare);
    const hat = at(stems.hat);
    const share = (x) => {
        const out = new Float64Array(x.length);
        for (let g = 0; g + 1 < starts.length; g += 1) {
            let max = 0;
            for (let j = starts[g]; j < starts[g + 1]; j += 1) max = Math.max(max, x[j]);
            for (let j = starts[g]; j < starts[g + 1]; j += 1) out[j] = max > 0 ? x[j] / max : 0;
        }
        return out;
    };
    return [kick, snare, hat, at(stems.harm), at(stems.percShare), share(kick), share(snare), share(hat)];
}
