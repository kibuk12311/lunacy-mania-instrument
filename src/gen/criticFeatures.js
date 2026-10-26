// Critic features: one fixed-order vector per map, the input of the critic (src/gen/critic.js), of its training
// (tools/make-critic-negatives.mjs → tools/train_critic.py) and of the personal reranker. The same function reads
// human maps and generated ones, so the critic can only learn what is in the rows, never file artefacts.
//
//   criticFeatures(rows, slots, audio?, stems?, structure?, ctx?) → Float64Array(CRITIC_FEATURES.length)
//
// rows: [{ t, mask | cols, i?, forced? }] on `slots` (any order; i = slot index when known); slots: grid.js slots.
// audio: per-slot onset/energy, as { onset, energy } arrays, the generator's { names, rows } feature columns, or
//   { envelope }. stems: the StemsTransfer curves ({ hopSec, frameOffsetSec, kick, snare, hat }) or per-slot
//   kick/snare/hat columns in `audio`. structure: { echoOf: Int32Array(bars), bars? } from src/gen/structure.js.
// ctx: { dan?: number (the target dan), forced?: number (guard fallbacks; default: rows marked forced) }.
// Anything missing gives NaN in its features (XGBoost "missing"), never a made-up value.
//
// Per 16-beat window (from the first row's beat to the last one's) the WINDOW_FEATURES, summarised over the windows
// as P10, mean and P90 (w_<name>_p10 / _mean / _p90); then the MAP_FEATURES. Pattern families are labelled from the
// rows themselves (sectionFamily per 8 beats), for human and generated maps alike.
import { findIssues } from "./playability.js";
import { sectionFamily } from "./mapRows.js";
import { barsOf } from "./songParts.js";
import { strengthsAt, slotStrengths, slotEnergy } from "./intensity.js";

export const WINDOW_BEATS = 16;
const MIN_WINDOW_ROWS = 8; // fewer rows: only the density features of the window are measured
const MIN_LAST_WINDOW_BEATS = 4; // a shorter tail joins the window before it
const FAMILY_BEATS = 8;
const RUN_CAP = 64;
const GAP_CAP_MS = 1000;
const LOW_ONSET = 0.1;
const STRONG_ONSET_Q = 0.8;
const STEM_PEAK = 0.3;
const PHASES = 24; // positions in a beat for rhythm keys (1/4, 1/3, 1/6, 1/8 all land on it)

export const FAMILY_NAMES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack"];
const STREAMY = new Set(["Stream", "Jumpstream", "Handstream", "Tech"]);

export const WINDOW_FEATURES = [
    "notes_per_beat", "rows_per_beat", "empty_beats", "notes_cv",
    "size1", "size2", "size3", "size4",
    "left_dev", "col0", "col1", "col2", "col3", "col_ratio", "col_entropy",
    "jack_rate", "jack_run", "jack_gap_ms", "jack_rate_streamy", "jack_run_streamy", "jack_gap_ms_streamy",
    "minijack", "longjack", "chordjack",
    "bigram_entropy", "mask_entropy", "loop",
    "trill", "roll", "split_jump", "one_hand_jump", "jumptrill", "anchor", "hand_run", "hand_alt",
    "gap_8", "gap_6", "gap_4", "gap_3", "gap_2", "gap_1", "gap_long", "gap_cv", "rhythm_entropy",
    "offbeat", "half", "odd_quarter",
    "onset_gap", "onset_rows", "size_onset_corr", "onset_low_rows", "onset_recall",
    "kick_rows", "snare_rows", "hat_rows", "echo_sim",
];

export const MAP_FEATURES = [
    "ctx_dan", "ctx_bpm", ...FAMILY_NAMES.map((f) => `ctx_fam_${f}`),
    "map_notes_per_beat", "map_rows_per_beat", "map_size1", "map_size2", "map_size3", "map_size4",
    "map_left_share", "map_col0", "map_col1", "map_col2", "map_col3",
    "map_density_energy_corr", "map_density_onset_corr", "map_density_cv", "map_peak_nps",
    "map_longest_jack", "map_longest_jack_streamy", "map_jack_loop",
    "map_issues_per1000", "map_issue_jack", "map_issue_fastjack", "map_issue_anchor", "map_issue_hand", "map_issue_spike",
    "map_issue_columns", "map_forced_per1000",
    "map_div4", "map_div3", "map_div6", "map_div8",
    "map_bigram_entropy", "map_mask_entropy", "map_beat_repeat", "map_bar_repeat",
    "map_echo_sim", "map_kick_rows", "map_snare_rows", "map_hat_rows",
    // 8-beat sections: the biggest jump in pattern style between neighbours, and the section that fits the music least
    "map_seam_max", "map_seam_mean", "map_seam_ratio", "map_chunk_onset_min", "map_chunk_onset_sd", "map_family_changes",
];

const STATS = ["p10", "mean", "p90"];
export const CRITIC_FEATURES = [...WINDOW_FEATURES.flatMap((n) => STATS.map((s) => `w_${n}_${s}`)), ...MAP_FEATURES];
// Not a property of the map itself (how the generator got there): kept for the play term and the personal model,
// never an input of a learned head.
export const CRITIC_META = ["map_forced_per1000"];
// Features that stay missing until their input exists (streams S: stems and structure).
export const CRITIC_NEEDS = {
    stems: ["kick_rows", "snare_rows", "hat_rows"].flatMap((n) => [...STATS.map((s) => `w_${n}_${s}`), `map_${n}`]),
    structure: [...STATS.map((s) => `w_echo_sim_${s}`), "map_echo_sim"],
};

const W = Object.fromEntries(WINDOW_FEATURES.map((n, k) => [n, k]));
const NW = WINDOW_FEATURES.length;
const MAP_AT = Object.fromEntries(MAP_FEATURES.map((n, k) => [n, NW * 3 + k]));
const ISSUE_FEATURE = { jack: "map_issue_jack", fastJack: "map_issue_fastjack", anchor: "map_issue_anchor", hand: "map_issue_hand", spike: "map_issue_spike" };
// geometric midpoints between 1/8, 1/6, 1/4, 1/3, 1/2 and 1 beat; over 1.25 beats is "long"
const GAP_EDGES = [Math.sqrt(1 / 48), Math.sqrt(1 / 24), Math.sqrt(1 / 12), Math.sqrt(1 / 6), Math.sqrt(1 / 2), 1.25];

const POP = Uint8Array.from({ length: 16 }, (_, m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const MIRROR = Uint8Array.from({ length: 16 }, (_, m) => ((m & 1) << 3) | ((m & 2) << 1) | ((m & 4) >> 1) | ((m & 8) >> 3));
export const mirrorMask = (m) => MIRROR[m & 15];
const maskOf = (r) => (r.mask ?? (r.cols ?? []).reduce((m, c) => m | (1 << c), 0)) & 15;

function entropy(counts, total) {
    if (total <= 0) return NaN;
    let h = 0;
    for (const c of counts) if (c > 0) h -= (c / total) * Math.log2(c / total);
    return h === 0 ? 0 : h;
}

function corr(xs, ys, n) {
    if (n < 3) return NaN;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i += 1) {
        mx += xs[i];
        my += ys[i];
    }
    mx /= n;
    my /= n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i += 1) {
        const dx = xs[i] - mx;
        const dy = ys[i] - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

function quantile(sorted, q) {
    const n = sorted.length;
    if (!n) return NaN;
    const x = q * (n - 1);
    const lo = Math.floor(x);
    const hi = Math.min(n - 1, lo + 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

// Jaccard of two sorted key lists.
function jaccard(a, b) {
    if (!a.length && !b.length) return 1;
    let i = 0;
    let j = 0;
    let both = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            both += 1;
            i += 1;
            j += 1;
        } else if (a[i] < b[j]) i += 1;
        else j += 1;
    }
    return both / (a.length + b.length - both);
}

// Per-slot onset and energy from whichever audio shape was given (null when there is none).
function slotAudio(audio, slots) {
    if (!audio) return null;
    if (audio.onset) return { onset: audio.onset, energy: audio.energy ?? null };
    if (audio.names && audio.rows) {
        const F = audio.names.length;
        const col = (name) => {
            const k = audio.names.indexOf(name);
            return k < 0 ? null : Float64Array.from({ length: slots.length }, (_, i) => audio.rows[i * F + k]);
        };
        const onset = col("onset");
        if (onset) return { onset, energy: col("energy") };
    }
    if (audio.envelope?.values) return { onset: slotStrengths(audio.envelope, slots), energy: slotEnergy(audio.envelope, slots) };
    return null;
}

// Per slot: 1 when the stem curve peaks there (≥ STEM_PEAK and not below either neighbour slot).
function stemPeaks(stems, audio, slots) {
    const curves = {};
    for (const name of ["kick", "snare", "hat"]) {
        let v = null;
        if (stems?.[name] && Number.isFinite(stems.hopSec)) {
            const off = stems.frameOffsetSec ?? 0;
            v = strengthsAt(stems[name], (f) => off + f * stems.hopSec, slots);
        } else if (stems?.[name] && typeof stems.frameTimeSec === "function") {
            v = strengthsAt(stems[name], stems.frameTimeSec, slots);
        } else if (audio?.names && audio.rows && audio.names.includes(name)) {
            const F = audio.names.length;
            const k = audio.names.indexOf(name);
            v = Float64Array.from({ length: slots.length }, (_, i) => audio.rows[i * F + k]);
        }
        if (!v) return null;
        const peak = new Uint8Array(slots.length);
        for (let i = 0; i < slots.length; i += 1) {
            peak[i] = v[i] >= STEM_PEAK && (i === 0 || v[i] >= v[i - 1]) && (i + 1 === slots.length || v[i] >= v[i + 1]) ? 1 : 0;
        }
        curves[name] = peak;
    }
    return curves;
}

// Rows → sorted, one per slot: { t, m, si, forced } typed arrays.
function placeRows(rowsIn, slots) {
    const list = rowsIn.filter((r) => maskOf(r) && Number.isFinite(r.t)).slice().sort((a, b) => a.t - b.t);
    const R = list.length;
    const si = new Int32Array(R);
    let j = 0;
    for (let k = 0; k < R; k += 1) {
        const r = list[k];
        if (Number.isInteger(r.i) && r.i >= 0 && r.i < slots.length && Math.abs(slots[r.i].t - r.t) <= 2) {
            si[k] = r.i;
            j = r.i;
            continue;
        }
        while (j + 1 < slots.length && Math.abs(slots[j + 1].t - r.t) <= Math.abs(slots[j].t - r.t)) j += 1;
        while (j > 0 && Math.abs(slots[j - 1].t - r.t) < Math.abs(slots[j].t - r.t)) j -= 1;
        si[k] = j;
    }
    // rows on one slot merge
    const m = new Uint8Array(R);
    const keep = new Int32Array(R);
    const forced = new Uint8Array(R);
    let n = 0;
    for (let k = 0; k < R; k += 1) {
        if (n && keep[n - 1] === si[k]) {
            m[n - 1] |= maskOf(list[k]);
            forced[n - 1] |= list[k].forced ? 1 : 0;
            continue;
        }
        keep[n] = si[k];
        m[n] = maskOf(list[k]);
        forced[n] = list[k].forced ? 1 : 0;
        n += 1;
    }
    return { n, si: keep.subarray(0, n), m: m.subarray(0, n), forced: forced.subarray(0, n) };
}

export function criticFeatures(rowsIn, slots, audio = null, stems = null, structure = null, ctx = {}) {
    const out = new Float64Array(CRITIC_FEATURES.length).fill(NaN);
    if (!slots?.length) return out;
    const S = slots.length;
    const { n: R, si, m, forced } = placeRows(rowsIn ?? [], slots);
    out[MAP_AT.ctx_dan] = Number.isFinite(ctx?.dan) ? ctx.dan : NaN;
    if (!R) return out;

    // ---- beats (consecutive slots of one beat; works for per-section and global beat numbers) ----
    const groupOf = new Int32Array(S);
    const groupStart = [];
    for (let i = 0; i < S; i += 1) {
        const s = slots[i];
        const p = slots[i - 1];
        if (i === 0 || s.beat !== p.beat || (s.pos ?? s.sub) <= (p.pos ?? p.sub)) groupStart.push(i);
        groupOf[i] = groupStart.length - 1;
    }
    groupStart.push(S);
    const t = new Float64Array(R);
    const g = new Int32Array(R);
    const bm = new Float64Array(R);
    const phase = new Float64Array(R);
    const sz = new Uint8Array(R);
    for (let k = 0; k < R; k += 1) {
        const s = slots[si[k]];
        t[k] = s.t;
        g[k] = groupOf[si[k]];
        bm[k] = s.beatMs ?? 60000 / s.bpm;
        phase[k] = (s.pos ?? s.sub) / (s.div ?? 4);
        sz[k] = POP[m[k]];
    }
    const gFirst = g[0];
    const gLast = g[R - 1];
    const nBeats = gLast - gFirst + 1;
    let nWin = Math.ceil(nBeats / WINDOW_BEATS);
    if (nWin > 1 && nBeats - (nWin - 1) * WINDOW_BEATS < MIN_LAST_WINDOW_BEATS) nWin -= 1;

    // ---- pattern families from the rows, per 8 beats ----
    const fam = new Array(R);
    const chunks = []; // { chunk, a, b, family } for every 8-beat section that holds rows
    for (let a = 0; a < R;) {
        const chunk = Math.floor((g[a] - gFirst) / FAMILY_BEATS);
        let b = a;
        while (b < R && Math.floor((g[b] - gFirst) / FAMILY_BEATS) === chunk) b += 1;
        const f = sectionFamily(Array.from({ length: b - a }, (_, k) => ({ mask: m[a + k] })), 0);
        for (let k = a; k < b; k += 1) fam[k] = f;
        chunks.push({ chunk, a, b, family: f });
        a = b;
    }
    const streamy = Uint8Array.from(fam, (f) => (STREAMY.has(f) ? 1 : 0));

    // ---- row flags ----
    const cont = new Uint8Array(R);
    const jackPrev = new Uint8Array(R);
    const run = new Uint8Array(R);
    const colGap = new Float64Array(R).fill(Infinity);
    const trill = new Uint8Array(R);
    const roll = new Uint8Array(R);
    const loop = new Uint8Array(R);
    const chordjack = new Uint8Array(R);
    const jumptrill = new Uint8Array(R);
    const handRun = new Uint8Array(R);
    const handAlt = new Int8Array(R).fill(-1);
    const gapB = new Float64Array(R).fill(NaN);
    const runC = [0, 0, 0, 0];
    const lastT = [-Infinity, -Infinity, -Infinity, -Infinity];
    const hand = (mm) => ((mm & 12) === 0 ? 1 : (mm & 3) === 0 ? 2 : 0); // 1 left only, 2 right only, 0 both
    const single = (mm) => POP[mm] === 1;
    const colOf = (mm) => 31 - Math.clz32(mm);
    let dirRun = 0; // roll: steps of +1 (or −1) mod 4 in a row over single-note rows
    let dir = 0;
    for (let k = 0; k < R; k += 1) {
        const mk = m[k];
        const c = k > 0 && t[k] - t[k - 1] <= bm[k] / 2;
        cont[k] = c ? 1 : 0;
        if (k > 0) gapB[k] = (t[k] - t[k - 1]) / bm[k];
        let longest = 0;
        for (let col = 0; col < 4; col += 1) {
            if (mk & (1 << col)) {
                runC[col] = c && m[k - 1] & (1 << col) ? runC[col] + 1 : 1;
                if (runC[col] > longest) longest = runC[col];
                const gap = t[k] - lastT[col];
                if (gap < colGap[k]) colGap[k] = gap;
                lastT[col] = t[k];
            } else runC[col] = 0;
        }
        run[k] = Math.min(RUN_CAP, longest);
        if (c && mk & m[k - 1]) jackPrev[k] = 1;
        if (k >= 2 && cont[k - 1] && c && mk === m[k - 2] && mk !== m[k - 1] && (mk & m[k - 1]) === 0) trill[k] = 1;
        if (k >= 2 && mk === m[k - 1] && mk === m[k - 2]) loop[k] = 1;
        if (c && sz[k] >= 2 && sz[k - 1] >= 2) {
            if (mk & m[k - 1]) chordjack[k] = 1;
            else jumptrill[k] = 1;
        }
        const h = hand(mk);
        handRun[k] = h && c && hand(m[k - 1]) === h ? Math.min(RUN_CAP, handRun[k - 1] + 1) : h ? 1 : 0;
        if (c && h && hand(m[k - 1])) handAlt[k] = hand(m[k - 1]) !== h ? 1 : 0;
        // roll runs
        const step = c && single(mk) && single(m[k - 1]) ? (colOf(mk) - colOf(m[k - 1]) + 4) % 4 : 0;
        const d = step === 1 || step === 3 ? step : 0;
        if (d && d === dir) dirRun += 1;
        else if (d) {
            dir = d;
            dirRun = 1;
        } else {
            dir = 0;
            dirRun = 0;
        }
        if (dirRun === 3) for (let j = k - 3; j <= k; j += 1) roll[j] = 1;
        else if (dirRun > 3) roll[k] = 1;
    }

    // ---- per slot ----
    const maskAt = new Uint8Array(S);
    for (let k = 0; k < R; k += 1) maskAt[si[k]] = m[k];
    const sa = slotAudio(audio, slots);
    const peaks = stemPeaks(stems, audio, slots);
    const notesInGroup = new Int32Array(groupStart.length);
    const rowsInGroup = new Int32Array(groupStart.length);
    for (let k = 0; k < R; k += 1) {
        notesInGroup[g[k]] += sz[k];
        rowsInGroup[g[k]] += 1;
    }

    // ---- structure: echo similarity per bar ----
    let barEcho = null;
    let barStart = [];
    if (structure?.echoOf) {
        const bars = structure.bars ?? barsOf(slots);
        barStart = bars.map((b) => b.i0);
        const keysOf = (b) => {
            const out = [];
            const g0 = groupOf[b.i0];
            for (let i = b.i0; i < Math.min(S, b.i1); i += 1) {
                const mm = maskAt[i];
                if (!mm) continue;
                const s = slots[i];
                const key = (groupOf[i] - g0) * PHASES + Math.round(((s.pos ?? s.sub) / (s.div ?? 4)) * PHASES);
                for (let col = 0; col < 4; col += 1) if (mm & (1 << col)) out.push(key * 4 + col);
            }
            return out.sort((x, y) => x - y);
        };
        barEcho = new Float64Array(bars.length).fill(NaN);
        bars.forEach((b, k) => {
            const e = structure.echoOf[k];
            if (e >= 0 && e < k && bars[e]) barEcho[k] = jaccard(keysOf(b), keysOf(bars[e]));
        });
    }

    // ---- windows ----
    const winVals = Array.from({ length: NW }, () => new Float64Array(nWin).fill(NaN));
    const wDensity = new Float64Array(nWin);
    const wEnergy = new Float64Array(nWin);
    const wOnset = new Float64Array(nWin);
    const bigram = new Uint16Array(256);
    const unigram = new Uint16Array(16);
    const gapBins = new Float64Array(7);
    let r0 = 0;
    for (let w = 0; w < nWin; w += 1) {
        const ga = gFirst + w * WINDOW_BEATS;
        const gb = w === nWin - 1 ? gLast + 1 : ga + WINDOW_BEATS;
        const s0 = groupStart[ga];
        const s1 = groupStart[gb];
        const beats = gb - ga;
        let r1 = r0;
        while (r1 < R && g[r1] < gb) r1 += 1;
        const rows = r1 - r0;
        const set = (name, v) => { winVals[W[name]][w] = v; };
        let notes = 0;
        for (let k = r0; k < r1; k += 1) notes += sz[k];
        wDensity[w] = notes / beats;
        set("notes_per_beat", notes / beats);
        set("rows_per_beat", rows / beats);
        let empty = 0;
        let gs = 0;
        let gss = 0;
        for (let gg = ga; gg < gb; gg += 1) {
            if (!rowsInGroup[gg]) empty += 1;
            gs += notesInGroup[gg];
            gss += notesInGroup[gg] * notesInGroup[gg];
        }
        set("empty_beats", empty / beats);
        const gMean = gs / beats;
        set("notes_cv", gMean > 0 ? Math.sqrt(Math.max(0, gss / beats - gMean * gMean)) / gMean : NaN);
        if (sa) {
            let e = 0;
            let o = 0;
            for (let i = s0; i < s1; i += 1) {
                e += sa.energy ? sa.energy[i] : 0;
                o += sa.onset[i];
            }
            wEnergy[w] = sa.energy ? e / Math.max(1, s1 - s0) : NaN;
            wOnset[w] = o / Math.max(1, s1 - s0);
        } else {
            wEnergy[w] = NaN;
            wOnset[w] = NaN;
        }
        if (barEcho) {
            // the bars that start in this window
            let sum = 0;
            let cnt = 0;
            for (let b = 0; b < barStart.length; b += 1) {
                if (barStart[b] < s0 || barStart[b] >= s1 || Number.isNaN(barEcho[b])) continue;
                sum += barEcho[b];
                cnt += 1;
            }
            set("echo_sim", cnt ? sum / cnt : -1);
        }
        if (rows >= MIN_WINDOW_ROWS) {
            const sizes = [0, 0, 0, 0];
            const cols = [0, 0, 0, 0];
            const colRows = [0, 0, 0, 0];
            let left = 0;
            let jacks = 0;
            let maxRun = 0;
            let minGap = GAP_CAP_MS;
            let sRows = 0;
            let sJacks = 0;
            let sRun = 0;
            let sGap = GAP_CAP_MS;
            let mini = 0;
            let longj = 0;
            let cj = 0;
            let lp = 0;
            let tr = 0;
            let rl = 0;
            let split = 0;
            let oneHand = 0;
            let jt = 0;
            let maxHand = 0;
            let alt = 0;
            let altPairs = 0;
            let offbeat = 0;
            let half = 0;
            let oddQ = 0;
            bigram.fill(0);
            unigram.fill(0);
            gapBins.fill(0);
            let gapN = 0;
            let gapSum = 0;
            let gapSq = 0;
            for (let k = r0; k < r1; k += 1) {
                const mk = m[k];
                sizes[sz[k] - 1] += 1;
                for (let col = 0; col < 4; col += 1) {
                    if (mk & (1 << col)) {
                        cols[col] += 1;
                        colRows[col] += 1;
                    }
                }
                left += POP[mk & 3];
                jacks += jackPrev[k];
                if (run[k] > maxRun) maxRun = run[k];
                if (colGap[k] < minGap) minGap = colGap[k];
                if (streamy[k]) {
                    sRows += 1;
                    sJacks += jackPrev[k];
                    if (run[k] > sRun) sRun = run[k];
                    if (colGap[k] < sGap) sGap = colGap[k];
                }
                if (run[k] === 2) mini += 1;
                else if (run[k] >= 3) longj += 1;
                cj += chordjack[k];
                lp += loop[k];
                tr += trill[k];
                rl += roll[k];
                if (sz[k] === 2) {
                    if (mk === 3 || mk === 12) oneHand += 1;
                    else split += 1;
                }
                jt += jumptrill[k];
                if (handRun[k] > maxHand) maxHand = handRun[k];
                if (handAlt[k] >= 0) {
                    altPairs += 1;
                    alt += handAlt[k];
                }
                unigram[mk] += 1;
                if (k > r0) {
                    bigram[(m[k - 1] << 4) | mk] += 1;
                    const gb2 = gapB[k];
                    let bin = 0;
                    while (bin < GAP_EDGES.length && gb2 > GAP_EDGES[bin]) bin += 1;
                    gapBins[bin] += 1;
                    const gms = t[k] - t[k - 1];
                    gapN += 1;
                    gapSum += gms;
                    gapSq += gms * gms;
                }
                const ph = phase[k];
                if (ph !== 0) offbeat += 1;
                if (Math.abs(ph - 0.5) < 1e-9) half += 1;
                if (Math.abs(ph - 0.25) < 1e-9 || Math.abs(ph - 0.75) < 1e-9) oddQ += 1;
            }
            for (let s = 0; s < 4; s += 1) set(`size${s + 1}`, sizes[s] / rows);
            set("left_dev", Math.abs(left / notes - 0.5));
            for (let col = 0; col < 4; col += 1) set(`col${col}`, cols[col] / notes);
            set("col_ratio", (Math.max(...cols) + 1) / (Math.min(...cols) + 1));
            set("col_entropy", entropy(cols, notes));
            set("jack_rate", jacks / rows);
            set("jack_run", maxRun);
            set("jack_gap_ms", Math.min(GAP_CAP_MS, minGap));
            if (sRows >= MIN_WINDOW_ROWS) {
                set("jack_rate_streamy", sJacks / sRows);
                set("jack_run_streamy", sRun);
                set("jack_gap_ms_streamy", Math.min(GAP_CAP_MS, sGap));
            }
            set("minijack", mini / rows);
            set("longjack", longj / rows);
            set("chordjack", cj / rows);
            set("bigram_entropy", entropy(bigram, rows - 1));
            set("mask_entropy", entropy(unigram, rows));
            set("loop", lp / rows);
            set("trill", tr / rows);
            set("roll", rl / rows);
            set("split_jump", split / rows);
            set("one_hand_jump", oneHand / rows);
            set("jumptrill", jt / rows);
            set("anchor", Math.max(...colRows) / rows);
            set("hand_run", maxHand);
            set("hand_alt", altPairs ? alt / altPairs : NaN);
            const gapNames = ["gap_8", "gap_6", "gap_4", "gap_3", "gap_2", "gap_1", "gap_long"];
            for (let b = 0; b < 7; b += 1) set(gapNames[b], gapN ? gapBins[b] / gapN : NaN);
            const gMs = gapN ? gapSum / gapN : 0;
            set("gap_cv", gMs > 0 ? Math.sqrt(Math.max(0, gapSq / gapN - gMs * gMs)) / gMs : NaN);
            // rhythm entropy: which positions of each beat hold rows, over the beats that hold any
            const keyCounts = new Map();
            let keyed = 0;
            for (let k = r0; k < r1;) {
                let key = 0;
                const gg = g[k];
                while (k < r1 && g[k] === gg) {
                    key |= 1 << Math.min(PHASES - 1, Math.round(phase[k] * PHASES));
                    k += 1;
                }
                keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
                keyed += 1;
            }
            set("rhythm_entropy", entropy(keyCounts.values(), keyed));
            set("offbeat", offbeat / rows);
            set("half", half / rows);
            set("odd_quarter", oddQ / rows);
            if (sa) {
                const on = sa.onset;
                let rowSum = 0;
                let emptySum = 0;
                let emptyN = 0;
                let low = 0;
                const xs = new Float64Array(s1 - s0);
                const ys = new Float64Array(s1 - s0);
                for (let i = s0; i < s1; i += 1) {
                    xs[i - s0] = POP[maskAt[i]];
                    ys[i - s0] = on[i];
                    if (maskAt[i]) {
                        rowSum += on[i];
                        if (on[i] < LOW_ONSET) low += 1;
                    } else {
                        emptySum += on[i];
                        emptyN += 1;
                    }
                }
                set("onset_rows", rowSum / rows);
                set("onset_gap", emptyN ? rowSum / rows - emptySum / emptyN : NaN);
                set("size_onset_corr", corr(xs, ys, s1 - s0));
                set("onset_low_rows", low / rows);
                const sorted = Float64Array.from(ys).sort();
                const thr = Math.max(quantile(sorted, STRONG_ONSET_Q), LOW_ONSET);
                let strong = 0;
                let hit = 0;
                for (let i = s0; i < s1; i += 1) {
                    if (on[i] >= thr) {
                        strong += 1;
                        if (maskAt[i]) hit += 1;
                    }
                }
                set("onset_recall", strong ? hit / strong : NaN);
            }
            if (peaks) {
                for (const name of ["kick", "snare", "hat"]) {
                    let on = 0;
                    for (let k = r0; k < r1; k += 1) on += peaks[name][si[k]];
                    set(`${name}_rows`, on / rows);
                }
            }
        }
        r0 = r1;
    }
    for (let f = 0; f < NW; f += 1) {
        const vals = Array.from(winVals[f]).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
        if (!vals.length) continue;
        out[f * 3] = quantile(vals, 0.1);
        out[f * 3 + 1] = vals.reduce((a, b) => a + b, 0) / vals.length;
        out[f * 3 + 2] = quantile(vals, 0.9);
    }

    // ---- the whole map ----
    const put = (name, v) => { out[MAP_AT[name]] = v; };
    let notes = 0;
    const sizes = [0, 0, 0, 0];
    const cols = [0, 0, 0, 0];
    const famCount = new Map();
    const divRows = { 4: 0, 3: 0, 6: 0, 8: 0 };
    let maxRun = 0;
    let sRun = 0;
    let lp = 0;
    let forcedRows = 0;
    bigram.fill(0);
    unigram.fill(0);
    for (let k = 0; k < R; k += 1) {
        notes += sz[k];
        sizes[sz[k] - 1] += 1;
        for (let col = 0; col < 4; col += 1) if (m[k] & (1 << col)) cols[col] += 1;
        famCount.set(fam[k], (famCount.get(fam[k]) ?? 0) + 1);
        const div = slots[si[k]].div ?? 4;
        if (div in divRows) divRows[div] += 1;
        if (run[k] > maxRun) maxRun = run[k];
        if (streamy[k] && run[k] > sRun) sRun = run[k];
        lp += loop[k];
        forcedRows += forced[k];
        unigram[m[k]] += 1;
        if (k > 0) bigram[(m[k - 1] << 4) | m[k]] += 1;
    }
    const bpmCount = new Map();
    for (let i = groupStart[gFirst]; i < groupStart[gLast + 1]; i += 1) {
        const b = Math.round((slots[i].bpm ?? 60000 / slots[i].beatMs) * 1000) / 1000;
        bpmCount.set(b, (bpmCount.get(b) ?? 0) + 1);
    }
    let bpm = NaN;
    let most = -1;
    for (const [b, c] of bpmCount) if (c > most) [bpm, most] = [b, c];
    put("ctx_bpm", bpm);
    for (const f of FAMILY_NAMES) put(`ctx_fam_${f}`, (famCount.get(f) ?? 0) / R);
    put("map_notes_per_beat", notes / nBeats);
    put("map_rows_per_beat", R / nBeats);
    for (let s = 0; s < 4; s += 1) put(`map_size${s + 1}`, sizes[s] / R);
    put("map_left_share", (cols[0] + cols[1]) / notes);
    for (let col = 0; col < 4; col += 1) put(`map_col${col}`, cols[col] / notes);
    put("map_density_energy_corr", corr(wDensity, wEnergy, nWin));
    put("map_density_onset_corr", corr(wDensity, wOnset, nWin));
    let dm = 0;
    for (const d of wDensity) dm += d;
    dm /= nWin;
    let dv = 0;
    for (const d of wDensity) dv += (d - dm) ** 2;
    put("map_density_cv", nWin >= 2 && dm > 0 ? Math.sqrt(dv / nWin) / dm : NaN);
    let peak = 0;
    let inWin = 0;
    for (let k = 0, lo = 0; k < R; k += 1) {
        inWin += sz[k];
        while (t[k] - t[lo] >= 1000) inWin -= sz[lo++];
        if (inWin > peak) peak = inWin;
    }
    put("map_peak_nps", peak);
    put("map_longest_jack", maxRun);
    put("map_longest_jack_streamy", sRun);
    put("map_jack_loop", lp / R);
    const issueRows = new Array(R);
    for (let k = 0; k < R; k += 1) issueRows[k] = { t: t[k], mask: m[k], family: fam[k] ?? undefined };
    const issues = findIssues(issueRows, slots);
    const per = Object.fromEntries(Object.keys(ISSUE_FEATURE).map((k) => [k, 0]));
    let columns = 0;
    let total = 0;
    for (const x of issues) {
        if (x.kind === "columns") columns = 1;
        else {
            total += 1;
            if (x.kind in per) per[x.kind] += 1;
        }
    }
    put("map_issues_per1000", (total * 1000) / notes);
    for (const [kind, name] of Object.entries(ISSUE_FEATURE)) put(name, (per[kind] * 1000) / notes);
    put("map_issue_columns", columns);
    const forcedCount = Number.isFinite(ctx?.forced) ? ctx.forced : forcedRows;
    put("map_forced_per1000", (forcedCount * 1000) / notes);
    for (const d of [4, 3, 6, 8]) put(`map_div${d}`, divRows[d] / R);
    put("map_bigram_entropy", entropy(bigram, R - 1));
    put("map_mask_entropy", entropy(unigram, R));
    // beat-to-beat and bar-to-bar pattern repeats (positions and columns), over beats that both hold rows
    const keyStart = new Int32Array(groupStart.length + 1);
    const keys = new Int32Array(notes);
    {
        let q = 0;
        let k = 0;
        for (let gg = 0; gg < groupStart.length; gg += 1) {
            keyStart[gg] = q;
            while (k < R && g[k] === gg) {
                const base = Math.min(PHASES - 1, Math.round(phase[k] * PHASES)) * 4;
                for (let col = 0; col < 4; col += 1) if (m[k] & (1 << col)) keys[q++] = base + col;
                k += 1;
            }
        }
        keyStart[groupStart.length] = q;
    }
    const keysOfGroup = (gg) => keys.subarray(keyStart[gg], keyStart[gg + 1]);
    const repeat = (lag) => {
        let sum = 0;
        let cnt = 0;
        for (let gg = gFirst + lag; gg <= gLast; gg += 1) {
            if (!rowsInGroup[gg] || !rowsInGroup[gg - lag]) continue;
            sum += jaccard(keysOfGroup(gg), keysOfGroup(gg - lag));
            cnt += 1;
        }
        return cnt ? sum / cnt : NaN;
    };
    put("map_beat_repeat", repeat(1));
    put("map_bar_repeat", repeat(4));
    // ---- 8-beat sections: seams in pattern style and the worst fit to the onsets ----
    {
        const mapDensity = notes / nBeats;
        const desc = (a, b) => {
            const n = b - a;
            const d = new Float64Array(9);
            let nn = 0;
            for (let k = a; k < b; k += 1) {
                d[sz[k] - 1] += 1 / n;
                d[4] += jackPrev[k] / n;
                d[5] += trill[k] / n;
                d[6] += roll[k] / n;
                d[7] += (phase[k] !== 0 ? 1 : 0) / n;
                nn += sz[k];
            }
            d[8] = mapDensity > 0 ? nn / FAMILY_BEATS / mapDensity / 2 : 0;
            return d;
        };
        let prev = null;
        let jumpMax = 0;
        let jumpSum = 0;
        let jumps = 0;
        let famChanges = 0;
        let famPairs = 0;
        const gaps = [];
        for (const c of chunks) {
            const full = c.b - c.a >= MIN_WINDOW_ROWS;
            const d = full ? desc(c.a, c.b) : null;
            if (d && prev && prev.chunk === c.chunk - 1) {
                let j = 0;
                for (let q = 0; q < d.length; q += 1) j += Math.abs(d[q] - prev.d[q]);
                jumpMax = Math.max(jumpMax, j);
                jumpSum += j;
                jumps += 1;
                famPairs += 1;
                if (c.family !== prev.family) famChanges += 1;
            }
            prev = d ? { chunk: c.chunk, d, family: c.family } : null;
            if (full && sa) {
                const ga = gFirst + c.chunk * FAMILY_BEATS;
                const s0 = groupStart[ga];
                const s1 = groupStart[Math.min(gLast + 1, ga + FAMILY_BEATS)];
                let rowSum = 0;
                let rowN = 0;
                let emptySum = 0;
                let emptyN = 0;
                for (let i = s0; i < s1; i += 1) {
                    if (maskAt[i]) {
                        rowSum += sa.onset[i];
                        rowN += 1;
                    } else {
                        emptySum += sa.onset[i];
                        emptyN += 1;
                    }
                }
                if (rowN && emptyN) gaps.push(rowSum / rowN - emptySum / emptyN);
            }
        }
        put("map_seam_max", jumps ? jumpMax : NaN);
        put("map_seam_mean", jumps ? jumpSum / jumps : NaN);
        put("map_seam_ratio", jumps && jumpSum > 0 ? jumpMax / (jumpSum / jumps) : NaN);
        put("map_family_changes", famPairs ? famChanges / famPairs : NaN);
        if (gaps.length) {
            let gm = 0;
            for (const v of gaps) gm += v;
            gm /= gaps.length;
            let gv = 0;
            for (const v of gaps) gv += (v - gm) ** 2;
            put("map_chunk_onset_min", Math.min(...gaps));
            put("map_chunk_onset_sd", Math.sqrt(gv / gaps.length));
        }
    }
    if (barEcho) {
        // the bars that start between the first and the last row's beat
        const from = groupStart[gFirst];
        const to = groupStart[gLast + 1];
        let sum = 0;
        let cnt = 0;
        barEcho.forEach((v, b) => {
            if (Number.isNaN(v) || barStart[b] < from || barStart[b] >= to) return;
            sum += v;
            cnt += 1;
        });
        put("map_echo_sim", cnt ? sum / cnt : -1);
    }
    if (peaks) {
        for (const name of ["kick", "snare", "hat"]) {
            let on = 0;
            for (let k = 0; k < R; k += 1) on += peaks[name][si[k]];
            put(`map_${name}_rows`, on / R);
        }
    }
    return out;
}
