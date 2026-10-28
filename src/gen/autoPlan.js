// «Автоподбор» (0.9.8): everything the create tab asks for, decided from the loaded song and the player.
// - the dan: the player's dan (the profile in use: mania-tracker, hand-set or local; the tile of the song's main
//   pattern when the profile has it, else the overall dan) in the Analysis tab's "for you" growth band (−0.1 … +0.5,
//   src/analysis/mapFit.js bandFor); without a profile a dan from the song's tempo and how busy it is;
// - per song part, the pattern from the stems (src/audio/stems.js curves) and the loudness: little kick or drums →
//   stream (tech when quiet and melodic), loud drums with a busy kick and more percussive than the rest of the song →
//   chordjack (when the dan is near or over what the stream families reach at the song's tempo, REACH), everything
//   else → jumpstream in turns with stream and handstream (PART_MIX; stream when quieter); the further a part's dan is
//   over that reach, the more of its streamed time goes to chordjack and jack instead (NEED); without stems, by
//   loudness alone; quiet parts (and quiet intros, breaks and outros) get an easier range of their own, at most
//   MAX_OWN_RANGES of them; the chordjack and jack go to whole parts (the song keeps its jumpstream and handstream
//   time); the main pattern (whose tile gives the dan) is the one of the most planned time within the profile tile of
//   the most;
// - the model: the neural L (else M, else S) when the graphics card and the stems are there, else XGBoost v3 with stems, else
//   the classic model; the critic picks from AUTO_CANDIDATES candidates when critic.json is there; repeats with stems;
//   the grids 1/4 and 1/8 (the triplet grids too for a model with a divisor head);
// - LNs: the generator and the dan analyser are rice only, so none; parts with long sustained sound are named in the
//   summary so the player knows why.
// Pure: no DOM; the renderer's «Автоподбор» (app/renderer/autoPick.js) fills the normal controls from it.
import { t } from "../i18n/i18n.js";
import { numericToLabel } from "../core/labels.js";

export const AUTO_CANDIDATES = 4;
export const MAX_OWN_RANGES = 8;
export const AUTO_FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
// the growth band of the "for you" line: the map a little over the player's dan
export const GROWTH = Object.freeze({ lo: -0.1, hi: 0.5 });
const EASY_DROP = 2; // dans off for a quiet part
const QUIET = 0.5; // a part this loud (against the loudest) or quieter is a quiet one
const QUIET_EDGE = 0.65; // an intro, break or outro this quiet is one too
const MIN_DAN = 1;
const MAX_DAN = 20;
// the dan without a profile: from the tempo, ± how busy the song is
const SONG_DAN = Object.freeze({ base: 2, perBpm: 1 / 22, min: 4, max: 12, busy: 2 });
// Pattern rules over a part's stem means (drums, harm: 0..1 against the song's own top part; percLift: the part's
// percussive share over the song's median part; kickBeat: kick peaks per beat). Calibrated in 0.10.4 on the 179
// held-out human maps (each part's family from its rows, src/gen/mapRows.js sectionFamily): the rules before asked for
// handstream on 83% of the song time whatever the map, as a percussive share of 0.5 never comes up in real stems (their
// parts' shares are 0.19–0.36, p10–p90), while human maps hold handstream on 3% of it, and with it went the single-note
// and jump trills. Now a part's main family (the rules' answer, before the map is made) agrees with the human part's
// 40% of the time (from 7%; no rule over these features gets past that in cross-validation, as mappers choose
// differently over the same music). The analyser's reading of the finished map is another matter: its top three
// patterns hold the human map's family on 0.23 of Auto-M's maps (from 0.18; the 171 held-out songs, seeds 1–2) —
// up on stream maps (0.07 → 0.35) and jumpstream maps (0.11 → 0.40), but down on handstream maps (0.61 → 0.06, which
// the handstream-everywhere plan matched by default), jack maps (0.11 → 0.07) and chordjack maps (0.19 → 0.16); on a
// sample rich in handstream and jack maps (14 trill songs, 3 handstream and 4 jack) it falls, 0.27 → 0.16. Where the stems
// cannot tell the families apart (the loud parts with drums, most of a song) a part gets a mix of them (PART_MIX), in
// turns of 2–4 sections (src/gen/assign.js), as human maps change family from phrase to phrase: so every kind of trill
// has room — single-note trills in the streams, jump trills in the jumpstreams, chord trills in the handstream. No stem
// feature tells the jack parts apart; the tempo does (NEED).
const RULES = Object.freeze({
    sparseDrums: 0.5, sparseKick: 0.75, drums: 0.6, percLift: 0.02, kickBusy: 2, harm: 0.45, jumpLoud: 0.6,
    sustainHarm: 0.5, sustainOnsets: 0.35,
});
// The families of a part by its kind, well under what the stream families reach (NEED). The human maps' parts: little
// kick or drums 41% stream, 27% jumpstream; the rest 44% jumpstream, 23% stream, 26% chordjack, 3% handstream. The
// loud mix gives handstream more, as the chord trills live there: our models' handstream sections hold 0.12 of their
// rows in chord trills, their jumpstream 0.005 (the human maps' jumpstream 0.016), so a share of 0.2 left the songs rich
// in chord trills with 0.2–0.7× the human share and 0.3 gives them about the human one; chordjack none here (a
// jumpstream map of the same notes keeps its trills), it comes with the need.
// Measured with neural M on the 171 held-out songs with stems, seeds 1–2, against the plan before (handstream 0.2, no
// need; the need then against the plain stream's dan of the tempo, see REACH for what replaced it), each kind's share
// against the human maps' where they hold it: Trills 0.54× → 0.49×, Minitrills 0.58× →
// 0.51×, Jumptrill 0.85× → 0.53×, SplitTrill 0.94× → 0.62×, ChordTrills 0.75× → 0.95× (runs under half the human
// share 23 → 18 of 58), Rolls 0.32× → 0.30× (the jump and split trills go on the slow, hard songs, where the plan
// before had 2–3× the human maps' trills); floods of jump trills 89 → 27 of 342, of chord trills 39 → 9; the dan hit
// 257 → 287 (in Auto's own range 236 → 276; jack maps 42 → 51 of 60, needs of 4+ 36 → 65 of 74), jacks 0.17 → 0.30
// of the rows (the human maps 0.32), F1 0.579 → 0.589, but more awkward spots (1.77 → 2.65 a map, the chordjack's
// anchors). Neural L, seed 1: hit 127 → 140, jack maps 18 → 25 of 30, jacks 0.15 → 0.28, ChordTrills 0.50× → 0.81×,
// Jumptrill 0.97× → 0.49×, SplitTrill 1.20× → 0.60×, F1 0.611 → 0.598, awkward spots 1.38 → 2.40.
export const PART_MIX = Object.freeze({
    sparse: Object.freeze([{ name: "Stream", share: 1 }]),
    drums: Object.freeze([{ name: "Chordjack", share: 1 }]),
    loud: Object.freeze([{ name: "Jumpstream", share: 0.35 }, { name: "Stream", share: 0.35 }, { name: "Handstream", share: 0.3 }]),
});
// What the stream families reach at a tempo (REACH): the dan from which the human maps at that tempo are more often
// chordjack or jack than stream, jumpstream or handstream — in the 179 held-out maps, a logistic fit of each part's
// family (mapRows.js sectionFamily) over the song's dan and BPM puts that line at −5.86 + 2.51 × BPM/22. It climbs 2.5
// times as fast as the plain stream's dan of the tempo (SONG_DAN: 2 + BPM/22), as jumps and hands make fast streams far
// harder than single notes do: 7.8 at 120 BPM (the plain stream's 7.5), 11.3 at 150, 17.0 at 200. Against the plain
// stream's dan alone (the plan before) a 200 BPM map of dan 17 was 6 dans "over" and planned 73% chordjack, while the
// human maps there are as often streams as jacks; and a slow jack map a little under its tempo's dan got none. Past the
// drums rule (NEED.drums) the dan and the tempo are all the plan can go by: the stems' song means tell the jack maps
// from the stream ones no better than chance (maps above the line: AUC 0.45–0.63 for kicks, hats, drums, percussive
// share, harmony, onsets; leave-one-out over the songs, the stems added to dan and BPM make the fit worse, log loss
// 0.615 → 0.620–0.627), and a part's stems rank its song's jack parts barely over chance (AUC 0.49–0.56).
export const REACH = Object.freeze({ base: -5.86, perBpm: 2.51 / 22 });
export const reachDan = (bpm) => REACH.base + (finite(bpm) ?? 150) * REACH.perBpm;
// How the mixes move with the need (a part's dan − reachDan; a quiet part's from its own easier dan). In the human
// maps the parts' share of chordjack and jack is 0.14–0.24 up to 3 dans under the line and 0.55–0.80 from there on
// (0.45 6+ over, where some of the slowest "jack" songs are half-time streams); every song rich in chord trills sits
// under it. Those songs are either jack maps or stream maps, though, rarely both, and the plan cannot tell which; our
// models hit the dan as well with a third to a half of chordjack as with more (neural M, every Auto run of 0.10.4's
// plans: 3 dans under the line to 1.5 under 88–93% of the runs with 0.3–0.5 chordjack and jack, 1.5 under to 2 over
// 88% against 88–90% with 0.5+, 2–5 over 94% against 86% with 0.7+; with none 73%, 49%, 59%), so that is what it takes
// up to the line: chordjack takes a growing share of every streamed part between NEED.chord's ends, more between
// NEED.deep's, jack from NEED.jack[0]. Handstream (the chord trills) goes by the plain stream's dan of the tempo
// (tempoDan) instead, between NEED.hand's ends over it: of the 30 human maps rich in chord trills (2%+ of the rows) 29
// are under 1 over it, the 72 maps from 1 over hold 0.001–0.008 of chord trills against 0.012–0.020 under, at any
// tempo — a 231 BPM stream map 2.5 over it (5.5 under the line) planned with 0.26 of handstream had 12–16% of its rows
// in chord trills, its human map none.
// NEED.over: whatever the tempo, our models' densest streams top out at dan 16–17 (Auto's handstream plan before 0.10.4
// missed 15 of the 33 runs of 185+ BPM songs of dan 17+, and hit 30 of the 33 under 17; with a half to 0.7 of
// chordjack 49 of 52), so over that chordjack comes in too. NEED.drums: a part the stems call chordjack (PART_MIX.drums)
// is one in the human maps only near and over the line — 0.75–0.84 of its time from 3 dans under it on (22 songs), none
// of it further under (20 songs, mostly fast stream maps of a low dan) — so under NEED.drums[0] it is streamed like any
// loud part, and turns to chordjack by NEED.drums[1].
// Measured with neural M on the 171 held-out songs with stems, seeds 1–2, against the need over the plain stream's dan
// (the plan before): the dan hit 287 → 289 of 342 (in Auto's own range 276 → 278; chordjack maps 63 → 65 of 72, jack
// maps 51 → 51 of 60, stream maps 74 → 70 of 86, dans of 17+ at 185+ BPM 30 → 26 of 30), F1 0.589 → 0.596, jacks 0.297
// → 0.309 of the rows (the human maps 0.318), awkward spots 2.65 → 2.61 a map (the same songs' human maps 14.7 by the
// same count, src/gen/playability.js findIssues); each trill kind against the human share where the human map holds it:
// Trills 0.49× → 0.51×, Minitrills 0.51× → 0.53×, Jumptrill 0.53× → 0.47×, SplitTrill 0.62× → 0.50×, ChordTrills
// 0.95× → 0.92× (runs under half the human share 18 → 16 of 58), Rolls 0.30× → 0.30×; floods of jump trills 27 → 23,
// of chord trills 9 → 11. Neural L, seed 1: hit 140 → 148 of 171 (own range 135 → 141), F1 0.598 → 0.608, jacks 0.275
// → 0.275, awkward spots 2.40 → 2.36, Trills 0.67× → 0.61×, Minitrills 0.61× → 0.65×, Jumptrill 0.49× → 0.46×,
// SplitTrill 0.60× → 0.56×, ChordTrills 0.81× → 0.79×, Rolls 0.30× → 0.32×, jump-trill floods 22 → 13. A slow jack map
// of a low dan (121 BPM, dan 5.5) that the plan before streamed flooded with jump trills (0.25–0.40 of the rows, the
// human map 0.03) and lost the human map's notes (F1 0.28–0.68); now 0.02–0.12, F1 0.95. (Tried: chordjack up to 0.7
// from 4 under the line to 2 over, jack 0.1 from 1 under, handstream giving way with the chordjack rather than by the
// plain stream's dan: neural M hit 290, F1 0.605, awkward spots 2.52, but chord-trill floods 9 → 14, three of the new
// ones on 229–231 BPM songs 1.7–2.5 over the plain stream's dan that kept their handstream, ChordTrills 0.86×,
// SplitTrill 0.47×.)
// NEED.deepBpm: the deep share comes in with the tempo, none up to its first end, all of it from its second. Under 140
// BPM a dan or more over the line the human maps hold 0.26–0.36 of their rows in jacks, at 140–180 BPM 0.83–0.89; our
// slow maps planned 0.65+ chordjack and jack came out with 0.77 of them, and 9 of their 11 misses (neural M and L, the
// 13 such songs) were overshoots.
// NEED.over counts from what our streams reach at the song's tempo (streamTop), not from one dan at any tempo. On the
// held-out songs of dan 16.5+, Auto's stream plans before 0.10.4 topped out at 15.9–17.1 on 5 of the 12 songs of
// 185–256 BPM (their 15 runs all hit with NEED.over's chordjack), while from 260 BPM on 11 of the 12 runs of the 4
// songs (dan 16.9–18.1) hit with streams, and from 300 BPM the plain map, before any boost, reached dan 15–17.2. The
// chordjack had turned those fast songs' jumpstream (and their jump trills) into chordjack and cost their notes: a 260
// BPM jump-trill map of dan 17.2 that the streams hit 3 of 3 went 1 of 3 at F1 0.35–0.54 (0.70 before). So the top is
// NEED.over[0] up to NEED.overBpm and a dan more every 1 / NEED.overPerBpm BPM after it: that map gets no chordjack
// now (hits 3 of 3, F1 0.66–0.70), a 256 BPM one of dan 18.5 keeps all of it.
// NEED.chordTopFast: under the line a fast song's chordjack tops out lower, from NEED.chordBpm[1] on (in between by the
// tempo), and climbs back to NEED.chordTop on the line, so over it nothing changes. Of the 8 songs of 185+ BPM up to 4
// dans under the line, 6 are stream maps (the human maps' jacks 0.19 of the rows, ours 0.29); without any chordjack
// there neural M lost 8 hits (the plain map's dan landed 3–6 under the target and the boosts overshot), with half of
// it none (293 of 342 against 291), and the stream maps kept their notes (a 190 BPM one of dan 14, 1.8 under the line:
// F1 0.25–0.63 → 0.60–0.66).
export const NEED = Object.freeze({
    chord: Object.freeze([-4, -1.5]), chordTop: 0.4, chordTopFast: 0.2, chordBpm: Object.freeze([165, 185]),
    deep: Object.freeze([1, 5]), deepTop: 0.2, deepBpm: Object.freeze([110, 150]),
    jack: Object.freeze([0, 6]), jackTop: 0.1,
    hand: Object.freeze([1, 3]),
    over: Object.freeze([16.5, 17.5]), overTop: 0.6, overBpm: 240, overPerBpm: 1 / 24,
    drums: Object.freeze([-4, -2.5]),
});
// The plain stream's dan of a tempo (SONG_DAN without the busy term), what NEED.hand counts from.
export const tempoDan = (bpm) => SONG_DAN.base + (finite(bpm) ?? 150) * SONG_DAN.perBpm;
// What our models' streams reach at a tempo (NEED.over counts from it): NEED.over[0] up to NEED.overBpm, then a dan
// more every 1 / NEED.overPerBpm BPM.
export const streamTop = (bpm) => NEED.over[0] + Math.max(0, (finite(bpm) ?? 150) - NEED.overBpm) * NEED.overPerBpm;

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, w) => a + (b - a) * w;

// The dan's label scale: a numeric dan → { level, step } (src/core/labels.js steps).
export function levelStepOf(n) {
    const v = clamp(n, MIN_DAN - 0.4, MAX_DAN + 0.4);
    const level = clamp(Math.round(v), MIN_DAN, MAX_DAN);
    const d = Math.round((v - level) * 1e6) / 1e6;
    const step = d <= -0.3 ? "low" : d <= -0.1 ? "low/mid" : d <= 0.1 ? "mid" : d <= 0.3 ? "mid/high" : "high";
    return { level, step };
}

// The tile a pattern family is played on in the profile (src/recommend/catalog.js tiles).
const TILE_OF = { Stream: "speed", Jumpstream: "speed", Handstream: "stamina", Chordjack: "jack", Jack: "jack", Tech: "tech" };

// The player's dan for a family: the profile's tile when it has one, else its overall dan; null without a dan.
export function playerDan(skill, family = null) {
    if (!skill) return null;
    const tile = family ? finite(skill.tiles?.[TILE_OF[family]]) : null;
    return tile ?? finite(skill.overall);
}

// Mean of a frame curve over [startMs, endMs); hopSec / offsetSec: the curve's frame grid.
function meanOver(curve, hopSec, offsetSec, startMs, endMs) {
    if (!curve?.length || !(hopSec > 0)) return null;
    const a = Math.max(0, Math.floor((startMs / 1000 - offsetSec) / hopSec));
    const b = Math.min(curve.length, Math.ceil((endMs / 1000 - offsetSec) / hopSec));
    if (b <= a) return null;
    let s = 0;
    for (let f = a; f < b; f += 1) s += curve[f];
    return s / (b - a);
}

// Local peaks of a curve over `floor` in [startMs, endMs), per beat.
function peaksPerBeat(curve, hopSec, offsetSec, startMs, endMs, beatMs, floor = 0.3) {
    if (!curve?.length || !(hopSec > 0) || !(beatMs > 0)) return null;
    const a = Math.max(1, Math.floor((startMs / 1000 - offsetSec) / hopSec));
    const b = Math.min(curve.length - 1, Math.ceil((endMs / 1000 - offsetSec) / hopSec));
    let n = 0;
    for (let f = a; f < b; f += 1) if (curve[f] > floor && curve[f] >= curve[f - 1] && curve[f] > curve[f + 1]) n += 1;
    return n / Math.max(1, (endMs - startMs) / beatMs);
}

const envelopeHop = (env) => (finite(env?.hopSec) ?? (typeof env?.frameTimeSec === "function" ? env.frameTimeSec(1) - env.frameTimeSec(0) : null));
const envelopeOffset = (env) => (typeof env?.frameTimeSec === "function" ? env.frameTimeSec(0) : finite(env?.frameOffsetSec) ?? 0);

// What each part sounds like: { loud (0..1 against the loudest part), onsets (peaks per beat), drums, harm, perc,
// percLift (perc over the median part's), kickBeat, hatBeat } — the stem keys null without stems.
export function partFeatures({ parts, envelope, stems = null, bpm }) {
    const beatMs = 60000 / (finite(bpm) ?? 120);
    const eHop = envelopeHop(envelope);
    const eOff = envelopeOffset(envelope);
    const sHop = finite(stems?.hopSec);
    const sOff = finite(stems?.frameOffsetSec) ?? 0;
    const raw = parts.map((p) => {
        const s = (key) => (stems ? meanOver(stems[key], sHop, sOff, p.startMs, p.endMs) : null);
        const kick = s("kick");
        const snare = s("snare");
        return {
            energy: meanOver(envelope?.values, eHop, eOff, p.startMs, p.endMs) ?? 0,
            onsets: peaksPerBeat(envelope?.values, eHop, eOff, p.startMs, p.endMs, beatMs, 0) ?? 0,
            kick, snare, hat: s("hat"), harm: s("harm"), perc: s("percShare"),
            kickBeat: stems ? peaksPerBeat(stems.kick, sHop, sOff, p.startMs, p.endMs, beatMs) : null,
            hatBeat: stems ? peaksPerBeat(stems.hat, sHop, sOff, p.startMs, p.endMs, beatMs) : null,
        };
    });
    const top = (key) => Math.max(1e-6, ...raw.map((r) => r[key] ?? 0));
    const loudTop = top("energy");
    const drumTop = Math.max(1e-6, ...raw.map((r) => ((r.kick ?? 0) + (r.snare ?? 0)) / 2));
    const harmTop = top("harm");
    const onsetTop = top("onsets");
    const percMid = median(raw.map((r) => r.perc).filter((x) => x !== null));
    return raw.map((r) => ({
        loud: r.energy / loudTop,
        onsets: r.onsets / onsetTop,
        drums: stems ? ((r.kick ?? 0) + (r.snare ?? 0)) / 2 / drumTop : null,
        harm: stems ? (r.harm ?? 0) / harmTop : null,
        perc: r.perc,
        percLift: r.perc !== null && percMid !== null ? r.perc - percMid : null,
        kickBeat: r.kickBeat,
        hatBeat: r.hatBeat,
    }));
}

function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Whole percents that add up to 100 (largest remainders), each at least 1.
function percentShares(list) {
    const total = list.reduce((s, p) => s + p.share, 0) || 1;
    const exact = list.map((p) => Math.max(1, (p.share / total) * 100));
    const out = exact.map(Math.floor);
    const order = exact.map((x, k) => [x - Math.floor(x), k]).sort((a, b) => b[0] - a[0]);
    for (let left = 100 - out.reduce((a, b) => a + b, 0), j = 0; left > 0 && order.length; left -= 1, j += 1) out[order[j % order.length][1]] += 1;
    const top = out.indexOf(Math.max(...out));
    if (top >= 0) out[top] -= Math.max(0, out.reduce((a, b) => a + b, 0) - 100); // the ones lifted to 1 come off the largest
    return list.map((p, k) => ({ name: p.name, share: out[k] }));
}

const only = (name) => [{ name, share: 1 }];
const copyMix = (mix) => mix.map((p) => ({ ...p }));

const ramp = (x, [a, b]) => clamp((x - a) / (b - a), 0, 1);

// A part's need at its dan and the song's tempo: how far the dan is over what the stream families reach (REACH).
export const needOf = (dan, bpm) => dan - reachDan(bpm);

// A streamed mix at a part's dan and the song's tempo (at: { dan, bpm }; null: as it is): chordjack and jack take their
// share of it (NEED), handstream gives its own to the streams, the streams keep their proportions in what is left; the
// largest first (ties in the table's order).
function withNeed(mix, at) {
    const dan = finite(at?.dan);
    if (dan === null) return copyMix(mix);
    const n = needOf(dan, at.bpm);
    const bpm = finite(at.bpm) ?? 150;
    const over = ramp(dan - streamTop(bpm) + NEED.over[0], NEED.over);
    const deep = NEED.deepTop * ramp(n, NEED.deep) * ramp(bpm, NEED.deepBpm);
    // under the line a fast song's chordjack tops out at NEED.chordTopFast by NEED.chord[1], NEED.chordTop on the line
    const under = NEED.chordTop * ramp(n, NEED.chord);
    const fastUnder = NEED.chordTopFast * ramp(n, NEED.chord) + (NEED.chordTop - NEED.chordTopFast) * ramp(n, [NEED.chord[1], 0]);
    const chord = Math.max(lerp(under, fastUnder, ramp(bpm, NEED.chordBpm)) + deep, NEED.overTop * over);
    const jack = NEED.jackTop * ramp(n, NEED.jack);
    // chordjack and jack take their share of the whole mix, handstream gives its own to the streams
    const hand = (mix.find((x) => x.name === "Handstream")?.share ?? 0) * (1 - chord - jack) * (1 - Math.max(ramp(dan - tempoDan(at.bpm), NEED.hand), over));
    const streams = mix.filter((x) => x.name !== "Handstream");
    const sum = streams.reduce((s, x) => s + x.share, 0) || 1;
    const rest = 1 - chord - jack - hand;
    const out = [
        ...streams.map((x) => ({ name: x.name, share: (x.share / sum) * rest })),
        { name: "Handstream", share: hand }, { name: "Chordjack", share: chord }, { name: "Jack", share: jack },
    ].filter((x) => x.share > 1e-9);
    return out.map((x, k) => [x, k]).sort((a, b) => b[0].share - a[0].share || a[1] - b[1]).map(([x]) => x);
}

// A part the stems call chordjack, at its dan (NEED.drums): all chordjack near and over the line, streamed like any loud
// part (withNeed) well under it, the two blended in between.
function drumsAt(at) {
    const dan = finite(at?.dan);
    if (dan === null) return copyMix(PART_MIX.drums);
    const s = ramp(needOf(dan, at.bpm), NEED.drums);
    if (s >= 1) return copyMix(PART_MIX.drums);
    const out = withNeed(PART_MIX.loud, at).map((x) => ({ name: x.name, share: x.share * (1 - s) }));
    const cj = out.find((x) => x.name === "Chordjack");
    if (cj) cj.share += s;
    else if (s > 0) out.push({ name: "Chordjack", share: s });
    return out.map((x, k) => [x, k]).sort((a, b) => b[0].share - a[0].share || a[1] - b[1]).map(([x]) => x);
}

// One part's patterns ([{ name, share }], the main family first) from its features (partFeatures), by the rules at the
// top of the file; at: { dan (the part's), bpm (the song's) } moves the mix by the part's need (NEED), null leaves it
// as the stems have it.
export function partMix(f, kind = "part", at = null) {
    if (f.drums === null || f.drums === undefined) {
        // no stems: loud parts jumpstream, the rest stream
        return only(f.loud >= RULES.jumpLoud && kind !== "intro" && kind !== "outro" ? "Jumpstream" : "Stream");
    }
    const loud = f.loud >= RULES.jumpLoud;
    // little kick or drums: a melodic part, streamed (quiet and melodic: tech)
    if (f.drums < RULES.sparseDrums || (f.kickBeat ?? 0) < RULES.sparseKick) return (f.harm ?? 0) >= RULES.harm && !loud ? only("Tech") : withNeed(PART_MIX.sparse, at);
    if (!loud) return withNeed(only("Stream"), at);
    // loud drums with a busy kick, more percussive than the rest of the song: chordjack (near and over the line)
    if (f.drums >= RULES.drums && (f.kickBeat ?? 0) >= RULES.kickBusy && (f.percLift ?? 0) >= RULES.percLift) return drumsAt(at);
    return withNeed(PART_MIX.loud, at);
}

// One part's main pattern family by its stems alone (partMix's first, no need).
export const familyForPart = (f, kind = "part") => partMix(f, kind)[0].name;

const JACK_FAMILY = new Set(["Chordjack", "Jack"]);
const sortMix = (mix) => mix.map((x, k) => [x, k]).sort((a, b) => b[0].share - a[0].share || a[1] - b[1]).map(([x]) => x);

// A part's mix with s of it in chordjack and jack (jack: their share that is jack), the rest in its stream families in
// their proportions (streams: the families a part without any takes, as a loud part at its dan).
function withJackShare(mix, s, jack, streams) {
    const own = mix.filter((x) => !JACK_FAMILY.has(x.name));
    const rest = own.length ? own : streams.filter((x) => !JACK_FAMILY.has(x.name));
    const sum = rest.reduce((q, x) => q + x.share, 0) || 1;
    return sortMix([
        ...rest.map((x) => ({ name: x.name, share: (x.share / sum) * (1 - s) })),
        { name: "Chordjack", share: s * (1 - jack) }, { name: "Jack", share: s * jack },
    ].filter((x) => x.share > 1e-9));
}

// Chordjack and jack in whole parts. The need gives every part at a dan its share (withNeed, drumsAt); spread over
// the parts, assign.js deals each of them out in turns of 2–4 sections among the streams, and every turn from a
// chordjack into a stream left the stream's first 16 rows holding the chords' columns: an "anchor" (src/gen/playability.js
// findIssues; 9–10 of the 9–13 awkward spots a map on a 220 BPM chordjack map whose human map has none), a density spike
// where the chords meet sparse rows, and streams cut into pieces too short for their trills. So the parts at the same
// dan (the map's own and the quiet ones' easier one) pool their chordjack and jack time, and it goes to whole parts
// again: the stems' chordjack parts first, then the parts of the most of it, then the loudest; the part where it runs
// out keeps the rest as a mix, the parts after it are streamed. Over the map the chordjack, jack and stream time stay
// what the need gave, and so does each stream family's (keepStreams): the parts turned to chordjack are the loud
// ones, which carry the jumpstream and handstream (the jump and chord trills), so a song whose other parts were plain
// streams lost all its jumpstream to the chordjack; now that time goes to the streamed parts in place of their plain
// stream. With it a slow chordjack song whose drops went whole chordjack (123 BPM, dan 8.8; its plain maps came out at
// 5.4–7.5, the boosted ones at 12.2–12.5) has its breaks and intro in jumpstream and handstream too, and its plain
// maps land on the dan (8.6–9.0, 3 hits of 3 against 1). Tried and dropped: no concentrating under 130 BPM (neural M
// 293 of 342, L 144 of 171, F1 L 0.640 → 0.622), at most 0.75 of a part in chordjack (M 296, L 142, awkward spots M
// 1.84 → 2.29 a map).
// Measured with this, NEED.deepBpm, the tile-counted main family and TRILL_SHARE (generateLearned.js) together, on the
// 171 held-out songs with stems against the spread plan: neural M (seeds 1–2) hit 289 → 290 of 342, F1 0.596 → 0.612,
// awkward spots 2.61 → 1.94 a map (HEAD 1.48; on the human chordjack maps 3.44 → 2.53, theirs 1.39 by the song's
// family, 5.36 by each part's own rows), jacks 0.309 → 0.307 of the rows (the human maps 0.318); neural L (seed 1) hit
// 148 → 142 of 171 (7 gained, 13 lost, a sign test p 0.26; 8 of the losses overshoot), F1 0.608 → 0.638, awkward
// spots 2.36 → 1.93, jacks 0.275 → 0.280. Density spikes on 15 of them: 0.87 → 0.37 (L), 1.00 → 0.20 (M) a map, the
// human maps 0.73. With keepStreams, NEED.over by streamTop and NEED.chordTopFast together, against that: neural M hit
// 290 → 293, F1 0.612 → 0.619, awkward spots 1.94 → 1.83, jacks 0.307 → 0.293; neural L hit 142 → 145, F1 0.638 →
// 0.642, awkward spots 1.93 → 1.98; jump-trill floods 22 → 26 (M), 9 → 10 (L).
function concentrate(list, features, mixes, easy, streamsOf) {
    const out = mixes.map(copyMix);
    const jf = (i) => mixes[i].filter((x) => JACK_FAMILY.has(x.name)).reduce((q, x) => q + x.share, 0);
    const len = (i) => list[i].endMs - list[i].startMs;
    for (const own of [false, true]) {
        const idx = list.map((_, i) => i).filter((i) => easy.has(i) === own && jf(i) > 1e-9 && len(i) > 0);
        if (idx.length < 2) continue;
        let left = idx.reduce((q, i) => q + len(i) * jf(i), 0);
        const jack = idx.reduce((q, i) => q + len(i) * (mixes[i].find((x) => x.name === "Jack")?.share ?? 0), 0) / left;
        const drums = (i) => (familyForPart(features[i], list[i].kind) === "Chordjack" ? 1 : 0);
        idx.sort((a, b) => drums(b) - drums(a) || jf(b) - jf(a) || features[b].loud - features[a].loud || a - b);
        for (const i of idx) {
            const s = clamp(left / len(i), 0, 1);
            left = Math.max(0, left - s * len(i));
            out[i] = withJackShare(mixes[i], s, jack, streamsOf(i));
        }
        keepStreams(idx, mixes, out, len);
    }
    return out;
}

// The pool's jumpstream and handstream time (jump and chord trills) as the need gave it: what the parts turned to
// chordjack had of it goes to the streamed parts in place of their plain stream, as far as they have that (from
// KEEP_MIN of the pool's time: less is not worth a change).
const KEEP_MIN = 0.02;
function keepStreams(idx, mixes, out, len) {
    const time = (ms, name) => idx.reduce((q, i) => q + len(i) * (ms[i].find((x) => x.name === name)?.share ?? 0), 0);
    const want = {};
    for (const name of ["Jumpstream", "Handstream"]) want[name] = Math.max(0, time(mixes, name) - time(out, name));
    const need = want.Jumpstream + want.Handstream;
    const avail = time(out, "Stream");
    if (need < KEEP_MIN * idx.reduce((q, i) => q + len(i), 0) || avail <= 1e-9) return;
    const take = Math.min(1, need / avail);
    for (const i of idx) {
        const st = out[i].find((x) => x.name === "Stream")?.share ?? 0;
        if (st <= 1e-9) continue;
        const moved = st * take;
        const mix = out[i].map((x) => ({ ...x }));
        mix.find((x) => x.name === "Stream").share -= moved;
        for (const name of ["Jumpstream", "Handstream"]) {
            const add = (moved * want[name]) / need;
            if (add <= 1e-12) continue;
            const x = mix.find((y) => y.name === name);
            if (x) x.share += add;
            else mix.push({ name, share: add });
        }
        out[i] = sortMix(mix.filter((x) => x.share > 1e-9));
    }
}

// The family of most time (time: { family: ms }, rank: { family: its best place in a mix }) within the profile tile of
// most time (TILE_OF: stream and jumpstream are both played on the speed tile, so a plan of 30% chordjack, 25% stream
// and 25% jumpstream is a speed plan); ties go to the one ranked higher.
function topByTile(time, rank) {
    const names = Object.keys(time);
    if (!names.length) return null;
    const tileTime = {};
    const tileRank = {};
    for (const n of names) {
        tileTime[TILE_OF[n]] = (tileTime[TILE_OF[n]] ?? 0) + time[n];
        tileRank[TILE_OF[n]] = Math.min(tileRank[TILE_OF[n]] ?? Infinity, rank[n] ?? Infinity);
    }
    const tile = Object.keys(tileTime).sort((a, b) => tileTime[b] - tileTime[a] || tileRank[a] - tileRank[b])[0];
    return names.filter((n) => TILE_OF[n] === tile).sort((a, b) => time[b] - time[a] || (rank[a] ?? Infinity) - (rank[b] ?? Infinity))[0];
}

// Planned time by family over the parts `which` picks: { time, rank } for topByTile.
function timeOf(list, mixes, which) {
    const time = {};
    const rank = {};
    list.forEach((p, i) => {
        if (!which(i)) return;
        mixes[i].forEach((x, k) => {
            time[x.name] = (time[x.name] ?? 0) + (p.endMs - p.startMs) * x.share;
            rank[x.name] = Math.min(rank[x.name] ?? Infinity, k);
        });
    });
    return { time, rank };
}

// The main family of a set of part mixes: among the loud parts (all parts when none is loud), the family of the most
// planned time within the tile of the most (topByTile).
function mainFamily(list, features, mixes) {
    const loud = list.some((p, i) => features[i].loud > QUIET);
    const { time, rank } = timeOf(list, mixes, (i) => !loud || features[i].loud > QUIET);
    return topByTile(time, rank) ?? mixes[0][0].name;
}

// Long sustained sound with few attacks: melodic and quiet in onsets (where a mapper would put long notes).
const sustained = (f) => f.harm !== null && f.harm >= RULES.sustainHarm && f.onsets <= RULES.sustainOnsets;

// The dan without a profile: the tempo's dan, ± how busy the song is (its mean onsets against its busiest part).
export function songDan({ bpm, features = [] }) {
    const b = finite(bpm) ?? 150;
    const busy = features.length ? features.reduce((s, f) => s + f.onsets * f.loud, 0) / features.length : 0.5;
    return round1(clamp(SONG_DAN.base + b * SONG_DAN.perBpm + SONG_DAN.busy * (busy - 0.5), SONG_DAN.min, SONG_DAN.max));
}

// The model: { size, why } — the neural L (M, S) with the GPU and stems, else XGBoost v3 with stems, else the classic.
// L since 0.10.4: on the held-out songs with Auto's own settings it hit the dan exactly as often as M (250/342 each)
// with notes closer to the human maps (F1 0.607 vs 0.579), about 5 s slower a map on the GPU.
export function pickModel(available = {}) {
    const sizes = available.sizes ?? {};
    if (available.gpu && available.stems && sizes.l) return { size: "l", why: "gpu" };
    if (available.gpu && available.stems && sizes.m) return { size: "m", why: "gpu" };
    if (available.gpu && available.stems && sizes.s) return { size: "s", why: "gpu" };
    if (available.stems && sizes.xgb3) return { size: "xgb3", why: "stems" };
    return { size: "auto", why: "classic" };
}

// The whole plan. song: { bpm, durationMs, envelope, stems? }; parts: the timeline's [{ startMs, endMs, kind }] (none:
// the song as one part); profile: getProfile() (renderer/profile.js) or null; available: genOptions.available().
// → { target, from, to (the dan picker's two ends), wholeSong (no parts were given), source: "profile" | "song", playerDan, parts (with their
// patterns and own ranges), patterns (the whole map's shares), model, candidates, repeats, snaps, stamina, burst,
// sustained (part indexes), groups: [{ kind, family }] for the summary }.
export function autoPlan({ song, parts = [], profile = null, available = {} }) {
    const list = parts.length ? parts : [{ startMs: 0, endMs: song.durationMs, kind: "part" }];
    const features = partFeatures({ parts: list, envelope: song.envelope, stems: song.stems ?? null, bpm: song.bpm });
    const skill = profile?.state === "ready" ? profile.skill : null;

    // quiet parts (the quietest first) get an easier range of their own
    const quiet = list.map((p, i) => i).filter((i) => features[i].loud <= QUIET || (["intro", "break", "outro"].includes(list[i].kind) && features[i].loud <= QUIET_EDGE));
    quiet.sort((a, b) => features[a].loud - features[b].loud);
    const easy = new Set(quiet.slice(0, MAX_OWN_RANGES).filter(() => list.length > 1));
    // the plan at a player's dan (null: the song's own): the target, each part's mix at its dan, the main family
    const planAt = (pDan) => {
        const target = round1(clamp(pDan !== null ? pDan + (GROWTH.lo + GROWTH.hi) / 2 : songDan({ bpm: song.bpm, features }), MIN_DAN, MAX_DAN));
        const easyDan = Math.max(MIN_DAN, target - EASY_DROP);
        const at = (i) => ({ dan: easy.has(i) ? easyDan : target, bpm: song.bpm });
        const mixes = concentrate(list, features, list.map((p, i) => partMix(features[i], p.kind, at(i))), easy, (i) => withNeed(PART_MIX.loud, at(i)));
        return { pDan, target, easyDan, mixes, main: mainFamily(list, features, mixes) };
    };
    // The main family is the plan's own (mainFamily: by its tiles), and its profile tile gives the dan the mixes are made at
    // (a slow song planned mostly chordjack takes the jack tile, not the speed tile of the jumpstream its stems suggest):
    // from the stems' main family on, until the plan's main family is the one whose tile it was made at. A profile whose
    // tiles send the plan back and forth (a high speed tile makes the slow song chordjack, its low jack tile streams
    // again) uses its overall dan.
    let plan = planAt(playerDan(skill, mainFamily(list, features, list.map((p, i) => partMix(features[i], p.kind)))));
    for (const tried = new Set(); playerDan(skill, plan.main) !== plan.pDan;) {
        tried.add(plan.pDan);
        const next = playerDan(skill, plan.main);
        plan = planAt(tried.has(next) ? playerDan(skill, null) : next);
        if (tried.has(next)) break;
    }
    const { pDan, target, easyDan, mixes, main } = plan;
    const source = pDan !== null ? "profile" : "song";
    const from = levelStepOf(pDan !== null ? pDan + GROWTH.lo + 0.1 : target - 0.2);
    const to = levelStepOf(pDan !== null ? pDan + GROWTH.hi - 0.1 : target + 0.2);
    const planned = list.map((p, i) => ({
        startMs: p.startMs, endMs: p.endMs, kind: p.kind,
        patterns: mixes[i],
        ...(easy.has(i) ? { range: { lo: round1(easyDan - 0.5), hi: round1(easyDan + 0.5) } } : {}),
    }));
    const shares = {};
    list.forEach((p, i) => { for (const x of mixes[i]) shares[x.name] = (shares[x.name] ?? 0) + (p.endMs - p.startMs) * x.share; });
    const patterns = percentShares(AUTO_FAMILIES.filter((f) => shares[f]).map((name) => ({ name, share: shares[name] })));

    const model = pickModel(available);
    const stems = Boolean(song.stems);
    const dynamic = quiet.length / list.length;
    // the summary's groups: per kind (in song order) the family of most of its planned time within the tile of most
    // (topByTile, as the main family), from the whole mixes, not each part's first family
    const groups = [];
    for (const kind of [...new Set(list.map((p) => p.kind))]) {
        const { time, rank } = timeOf(list, mixes, (i) => list[i].kind === kind);
        groups.push({ kind, family: topByTile(time, rank) });
    }
    return {
        target, from, to, source, playerDan: pDan, wholeSong: !parts.length,
        parts: planned, patterns, main, groups,
        model: model.size, modelWhy: model.why,
        candidates: available.critic ? AUTO_CANDIDATES : 1,
        repeats: stems,
        snaps: model.size === "auto" ? [4, 8] : [4, 3, 6, 8],
        stamina: dynamic > 0.4 ? 0.4 : 0.55,
        burst: 0.3,
        sustained: list.map((_, i) => i).filter((i) => sustained(features[i])),
    };
}

// «Автоподбор: Gamma mid · дроп — джампстрим, куплет — стрим; модель: нейросеть M». kindName(kind) and modelName(size)
// come from the renderer (the timeline's part names, the model picker's).
const FAMILY_KEYS = {
    Stream: "create.auto.family.Stream", Jumpstream: "create.auto.family.Jumpstream", Handstream: "create.auto.family.Handstream",
    Chordjack: "create.auto.family.Chordjack", Jack: "create.auto.family.Jack", Tech: "create.auto.family.Tech",
};
export function autoSummary(plan, { kindName = (k) => k, modelName = (s) => s } = {}) {
    const dan = numericToLabel(plan.target, { number: false }).text;
    const fam = (f) => t(FAMILY_KEYS[f] ?? FAMILY_KEYS.Jumpstream);
    const groups = plan.groups.map((g) => (plan.groups.length > 1 ? `${kindName(g.kind)} — ${fam(g.family)}` : fam(g.family))).join(", ");
    const lines = [t("create.auto.summary", { dan, groups, model: modelName(plan.model) })];
    lines.push(t(plan.source === "profile" ? "create.auto.fromProfile" : "create.auto.fromSong", { dan: Number.isFinite(plan.playerDan) ? numericToLabel(plan.playerDan, { number: false }).text : "" }));
    if (plan.sustained.length) lines.push(t("create.auto.noLn"));
    return lines;
}
