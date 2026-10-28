// «Автоподбор» (0.9.8, src/gen/autoPlan.js): the dan from the profile or the song, the pattern per part from the stems
// (0.10.4: rules calibrated on human maps, no handstream by default, so trills survive), easier quiet parts, the model
// by what can run, the summary in both languages.
import test from "node:test";
import assert from "node:assert/strict";
import {
    autoPlan, autoSummary, familyForPart, partMix, partFeatures, pickModel, songDan, playerDan, levelStepOf, reachDan, needOf, tempoDan, GROWTH, AUTO_CANDIDATES,
    PART_MIX, NEED, REACH, streamTop,
} from "../../src/gen/autoPlan.js";
import { danRange } from "../../src/gen/search.js";
import { setLang } from "../../src/i18n/i18n.js";

const HOP = 0.01;
const SEC = 100;
const BPM = 160;
const beatMs = 60000 / BPM;
// parts: 0–20 s intro (quiet, melodic, no attacks), 20–50 s drop (loud, a kick every half beat, a snare on every beat),
// 50–75 s verse (fast hats, 1/4, no kick), 75–100 s bridge (melodic, mid loud, a kick and a snare on every beat)
const PARTS = [
    { startMs: 0, endMs: 20000, kind: "intro" },
    { startMs: 20000, endMs: 50000, kind: "drop" },
    { startMs: 50000, endMs: 75000, kind: "part" },
    { startMs: 75000, endMs: 100000, kind: "break" },
];
function makeSong({ stems = true } = {}) {
    const n = SEC / HOP;
    const env = new Float32Array(n);
    const kick = new Float32Array(n);
    const snare = new Float32Array(n);
    const hat = new Float32Array(n);
    const harm = new Float32Array(n);
    const perc = new Float32Array(n);
    const at = (ms) => Math.round(ms / 1000 / HOP);
    for (let f = 0; f < n; f += 1) {
        const ms = f * HOP * 1000;
        if (ms < 20000) { env[f] = 0.08; harm[f] = 0.7; perc[f] = 0.1; }
        else if (ms < 50000) { env[f] = 0.2; perc[f] = 0.8; harm[f] = 0.2; }
        else if (ms < 75000) { env[f] = 0.15; perc[f] = 0.7; harm[f] = 0.2; }
        else { env[f] = 0.13; harm[f] = 0.8; perc[f] = 0.2; }
    }
    for (let t = 20000; t < 50000; t += beatMs / 2) { kick[at(t)] = 1; env[at(t)] = 1; }
    for (let t = 20000; t < 50000; t += beatMs) snare[at(t)] = 1;
    for (let t = 50000; t < 75000; t += beatMs / 4) { hat[at(t)] = 1; env[at(t)] = 0.6; }
    for (let t = 75000; t < 100000; t += beatMs / 2) { harm[at(t)] = 1; env[at(t)] = 0.5; }
    for (let t = 75000; t < 100000; t += beatMs) { kick[at(t)] = 1; snare[at(t)] = 1; }
    const envelope = { values: env, hopSec: HOP, frameTimeSec: (f) => f * HOP };
    return {
        bpm: BPM, durationMs: SEC * 1000, envelope,
        stems: stems ? { v: 1, hopSec: HOP, frameOffsetSec: 0, frames: n, kick, snare, hat, harm, percShare: perc } : null,
    };
}
const ALL = { sizes: { auto: true, xgb3: true, s: true, m: true, l: false }, gpu: true, stems: true, critic: true };

test("structure → patterns: busy percussive drums → chordjack, no kick → stream, quiet melodic → tech, the rest jumpstream", () => {
    const song = makeSong();
    const f = partFeatures({ parts: PARTS, envelope: song.envelope, stems: song.stems, bpm: BPM });
    assert.ok(f[1].loud > 0.9 && f[0].loud < 0.6, "the drop is the loudest, the intro quiet");
    assert.ok(f[2].hatBeat >= 3, `hats per beat ${f[2].hatBeat}`);
    assert.ok(f[1].kickBeat >= 1.9 && f[3].kickBeat >= 0.9 && f[3].kickBeat < 1.5, `kicks per beat ${f[1].kickBeat}, ${f[3].kickBeat}`);
    const families = PARTS.map((p, i) => familyForPart(f[i], p.kind));
    assert.deepEqual(families, ["Tech", "Chordjack", "Stream", "Jumpstream"]);
    // a kick on every beat only: the loud drums are jumpstream; the same drums no more percussive than the song: too
    assert.equal(familyForPart({ ...f[1], kickBeat: 1 }), "Jumpstream");
    assert.equal(familyForPart({ ...f[1], percLift: 0 }), "Jumpstream");
    // no kick: stream, loud or not; melodic and quiet: tech
    assert.equal(familyForPart({ loud: 0.95, drums: 0.1, harm: 0.9, perc: 0.2, percLift: 0, hatBeat: 0, kickBeat: 0, onsets: 0.5 }), "Stream");
    assert.equal(familyForPart({ loud: 0.5, drums: 0.1, harm: 0.9, perc: 0.2, percLift: 0, hatBeat: 0, kickBeat: 0, onsets: 0.5 }), "Tech");
});

// The stem means of real songs' parts (the 179 held-out songs, p10/p50/p90): loud 0.83/0.97/1.00, drums 0.29/0.77/1.00,
// harm 0.28/0.66/1.00, percShare 0.19/0.29/0.36, kicks per beat 0.20/1.46/2.99. Before 0.10.4 a percShare of 0.5 counted
// as percussive, which no real part reaches, so every loud melodic part became handstream (83% of the song time against
// 3% in the human maps) and the single-note and jump trills went with it.
const REAL = { loud: 0.97, onsets: 0.93, drums: 0.77, harm: 0.66, perc: 0.29, percLift: 0, kickBeat: 1.46, hatBeat: 1.32 };

test("parts like real songs' are mostly jumpstream or stream, never mostly handstream", () => {
    assert.equal(familyForPart(REAL), "Jumpstream");
    for (const loud of [0.85, 0.95, 1]) {
        for (const harm of [0.45, 0.7, 1]) {
            for (const perc of [0.19, 0.29, 0.36]) {
                const fam = familyForPart({ ...REAL, loud, harm, perc });
                assert.ok(["Jumpstream", "Stream"].includes(fam), `loud ${loud} harm ${harm} perc ${perc}: ${fam}`);
            }
        }
    }
    // little kick (a quarter of the parts): stream
    assert.equal(familyForPart({ ...REAL, kickBeat: 0.5 }), "Stream");
    assert.equal(familyForPart({ ...REAL, drums: 0.3 }), "Stream");
    // a busy kick in the song's most percussive part: chordjack
    assert.equal(familyForPart({ ...REAL, kickBeat: 2.5, percLift: 0.05 }), "Chordjack");
});

test("percussive is against the song's own parts: the same part is chordjack in a calm song, jumpstream in a percussive one", () => {
    const song = makeSong();
    const f = partFeatures({ parts: PARTS, envelope: song.envelope, stems: song.stems, bpm: BPM });
    // percShare 0.1 / 0.8 / 0.7 / 0.2: the median part's is 0.45
    assert.ok(Math.abs(f[1].percLift - 0.35) < 0.01 && f[0].percLift < 0 && f[3].percLift < 0, f.map((x) => x.percLift).join(", "));
    const flat = { ...song, stems: { ...song.stems, percShare: new Float32Array(song.stems.frames).fill(0.3) } };
    const g = partFeatures({ parts: PARTS, envelope: flat.envelope, stems: flat.stems, bpm: BPM });
    assert.ok(g.every((x) => Math.abs(x.percLift) < 1e-6));
    assert.equal(familyForPart(g[1], "drop"), "Jumpstream");
    assert.equal(partFeatures({ parts: PARTS, envelope: song.envelope, stems: null, bpm: BPM })[1].percLift, null, "no stems: none");
});

// ten parts of 10 s with real songs' stem means: a kick every 0.25 s (2/3 of a beat at 160 BPM), every third part one
// every 0.75 s; no part with drums busy enough for chordjack
const TEN = Array.from({ length: 10 }, (_, k) => ({ startMs: k * 10000, endMs: (k + 1) * 10000, kind: "part" }));
function realSong(bpm = 160) {
    const n = 100 / HOP;
    const curve = (fn) => Float32Array.from({ length: n }, (_, f) => fn(f, Math.floor((f * HOP) / 10)));
    const kickAt = (f, k) => (k % 3 === 2 ? (f % 75 === 0 ? 1 : 0) : f % 25 === 0 ? 1 : 0);
    return {
        bpm, durationMs: 100000,
        envelope: { values: curve((f, k) => 0.3 + (kickAt(f, k) ? 0.7 : 0)), hopSec: HOP, frameTimeSec: (f) => f * HOP },
        stems: {
            v: 1, hopSec: HOP, frameOffsetSec: 0, frames: n,
            kick: curve(kickAt), snare: curve((f) => (f % 37 === 0 ? 1 : 0)), hat: curve((f) => (f % 9 === 0 ? 1 : 0)),
            harm: curve((f) => 0.4 + 0.4 * Math.sin(f / 50) ** 2), percShare: curve((f, k) => 0.24 + 0.01 * k),
        },
    };
}
const profileAt = (dan, tiles = undefined) => ({ state: "ready", skill: { overall: dan - (GROWTH.lo + GROWTH.hi) / 2, ...(tiles ? { tiles } : {}) } });
const jackShare = (mix) => mix.filter((x) => x.name === "Chordjack" || x.name === "Jack").reduce((s, x) => s + x.share, 0);

test("a song whose parts all sound like real ones: its parts are mostly stream or jumpstream, none mostly handstream", () => {
    // well under what the stream families reach: no chordjack at all
    const plan = autoPlan({ song: realSong(), parts: TEN, profile: profileAt(reachDan(160) + NEED.chord[0] - 1), available: ALL });
    const names = plan.parts.map((p) => p.patterns[0].name);
    assert.ok(names.every((x) => x === "Stream" || x === "Jumpstream"), names.join(", "));
    assert.ok(names.includes("Stream") && names.includes("Jumpstream"), names.join(", "));
    // without a profile (the song's own dan, a little under the line): the parts the need gives no chordjack the same
    const own = autoPlan({ song: realSong(), parts: TEN, profile: null, available: ALL });
    for (const p of own.parts) {
        assert.notEqual(p.patterns[0].name, "Handstream");
        if (!jackShare(p.patterns)) assert.ok(["Stream", "Jumpstream"].includes(p.patterns[0].name), JSON.stringify(p.patterns));
    }
});

test("without stems the patterns follow the loudness only", () => {
    const song = makeSong({ stems: false });
    const plan = autoPlan({ song, parts: PARTS, profile: null, available: { ...ALL, stems: false } });
    // the loud drop jumpstream, the quiet intro stream
    assert.equal(plan.parts[1].patterns[0].name, "Jumpstream");
    assert.equal(plan.parts[0].patterns[0].name, "Stream");
    assert.ok(plan.parts.every((p) => ["Stream", "Jumpstream"].includes(p.patterns[0].name)));
    assert.equal(plan.repeats, false);
    // no stems: no neural model, no XGBoost v3 (both read the stems)
    assert.equal(plan.model, "auto");
});

test("with a profile the dan is the player's, in the growth band; the main pattern's tile wins over the overall dan", () => {
    const song = makeSong();
    const profile = { state: "ready", skill: { overall: 12.0, tiles: { jack: 13.0, speed: 11.0 } } };
    const plan = autoPlan({ song, parts: PARTS, profile, available: ALL });
    assert.equal(plan.source, "profile");
    assert.equal(plan.main, "Chordjack");
    assert.equal(plan.playerDan, 13);
    assert.equal(plan.target, Math.round((13 + (GROWTH.lo + GROWTH.hi) / 2) * 10) / 10);
    const range = danRange(plan.from, plan.to);
    assert.ok(range.lo >= 13 + GROWTH.lo - 0.21 && range.lo <= 13, `range ${range.lo}..${range.hi}`);
    assert.ok(range.hi >= 13.3 && range.hi <= 13 + GROWTH.hi + 0.01, `range ${range.lo}..${range.hi}`);
    assert.equal(playerDan({ overall: 9 }, "Chordjack"), 9);
    assert.equal(playerDan(null), null);
});

test("without a profile (none, failed, still loading) the dan comes from the song's tempo", () => {
    const song = makeSong();
    for (const profile of [null, { state: "none" }, { state: "failed", message: "x" }, { state: "loading" }]) {
        const plan = autoPlan({ song, parts: PARTS, profile, available: ALL });
        assert.equal(plan.source, "song");
        assert.equal(plan.target, songDan({ bpm: BPM, features: partFeatures({ parts: PARTS, envelope: song.envelope, stems: song.stems, bpm: BPM }) }));
    }
    assert.ok(songDan({ bpm: 120 }) < songDan({ bpm: 180 }));
    assert.equal(songDan({ bpm: 400 }), 12);
    assert.equal(songDan({ bpm: 30 }), 4);
});

test("quiet parts get an easier range of their own; the loud ones follow the map's range", () => {
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: { state: "ready", skill: { overall: 10 } }, available: ALL });
    assert.ok(plan.parts[0].range, "the quiet intro");
    assert.ok(plan.parts[0].range.hi <= plan.target - 1);
    assert.equal(plan.parts[1].range, undefined, "the drop");
    // one part only: no own range
    const one = autoPlan({ song: makeSong(), parts: [], profile: null, available: ALL });
    assert.equal(one.parts.length, 1);
    assert.equal(one.parts[0].range, undefined);
});

test("the model: neural L with the GPU and stems, M without L, S without M, XGBoost v3 with stems only, else the classic", () => {
    assert.equal(pickModel({ ...ALL, sizes: { ...ALL.sizes, l: true } }).size, "l");
    assert.equal(pickModel({ ...ALL, gpu: false, sizes: { ...ALL.sizes, l: true } }).size, "xgb3");
    assert.equal(pickModel(ALL).size, "m");
    assert.equal(pickModel({ ...ALL, sizes: { ...ALL.sizes, m: false } }).size, "s");
    assert.equal(pickModel({ ...ALL, gpu: false }).size, "xgb3");
    assert.equal(pickModel({ ...ALL, gpu: false, sizes: { auto: true } }).size, "auto");
    assert.equal(pickModel({}).size, "auto");
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: null, available: ALL });
    assert.equal(plan.model, "m");
    assert.equal(plan.candidates, AUTO_CANDIDATES);
    assert.equal(plan.repeats, true);
    assert.deepEqual(plan.snaps, [4, 3, 6, 8]);
    const classic = autoPlan({ song: makeSong(), parts: PARTS, profile: null, available: { sizes: { auto: true }, critic: false } });
    assert.equal(classic.candidates, 1);
    assert.deepEqual(classic.snaps, [4, 8]);
});

// a player well under what the test song's 160 BPM streams reach (reachDan 12.4): the mixes as the stems have them
// for the streamed parts, and the stems' chordjack drop streamed too (NEED.drums)
const UNDER = { state: "ready", skill: { overall: 7 } };
// a player 2.5 dans under it (target 9.9): the drop all chordjack, the streamed parts some
const NEAR = { state: "ready", skill: { overall: reachDan(BPM) - 2.5 - (GROWTH.lo + GROWTH.hi) / 2 } };

test("the whole map's patterns are the parts' mixes by time, in whole percents adding up to 100", () => {
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: NEAR, available: ALL });
    const names = plan.patterns.map((p) => p.name).sort();
    // the melodic, mid-loud bridge (quiet enough for its own easier dan) jumpstream with streams and handstream, the
    // drop chordjack, the verse streams with the rest of the chordjack
    assert.deepEqual(names, ["Chordjack", "Handstream", "Jumpstream", "Stream", "Tech"]);
    assert.deepEqual(plan.parts[1].patterns, PART_MIX.drums);
    assert.deepEqual(plan.parts.map((p) => p.patterns[0].name), ["Tech", "Chordjack", "Stream", "Jumpstream"]);
    assert.equal(plan.patterns.reduce((s, p) => s + p.share, 0), 100);
    assert.ok(plan.patterns.every((p) => Number.isInteger(p.share) && p.share >= 1));
    // by time: each family's percent is its share of every part times the part's time (100 s in all)
    for (const { name, share } of plan.patterns) {
        const byTime = plan.parts.reduce((s, p) => s + ((p.endMs - p.startMs) / 1000) * (p.patterns.find((x) => x.name === name)?.share ?? 0), 0);
        assert.ok(Math.abs(share - byTime) <= 1, `${name} ${share}% against ${byTime.toFixed(1)}`);
    }
    for (const p of plan.parts) assert.ok(Math.abs(p.patterns.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
    // well under the line the drop the stems call chordjack is streamed like the bridge
    const under = autoPlan({ song: makeSong(), parts: PARTS, profile: UNDER, available: ALL });
    assert.deepEqual(under.parts[1].patterns, PART_MIX.loud);
    assert.deepEqual(under.parts[3].patterns, PART_MIX.loud);
    assert.ok(!under.patterns.some((p) => p.name === "Chordjack" || p.name === "Jack"), JSON.stringify(under.patterns));
});

test("chordjack and jack go to whole parts: the parts at a dan pool the need's share, the rest are streamed", () => {
    // ten loud parts at one dan, 2 under the line: the need gives each streamed part 0.32 chordjack (partMix)
    const song = realSong();
    const dan = reachDan(160) - 2;
    const plan = autoPlan({ song, parts: TEN, profile: profileAt(dan), available: ALL });
    assert.equal(plan.target, Math.round(dan * 10) / 10);
    const f = partFeatures({ parts: TEN, envelope: song.envelope, stems: song.stems, bpm: 160 });
    const own = TEN.map((p, i) => partMix(f[i], p.kind, { dan: plan.target, bpm: 160 }));
    assert.ok(own.every((m) => Math.abs(jackShare(m) - jackShare(own[0])) < 1e-9 && jackShare(m) > 0.25), "every part the same share");
    assert.ok(plan.parts.every((p) => !p.range), "one dan");
    const js = plan.parts.map((p) => jackShare(p.patterns));
    // the same chordjack time over the map …
    assert.ok(Math.abs(js.reduce((a, b) => a + b, 0) - own.reduce((a, m) => a + jackShare(m), 0)) < 1e-9);
    // … in whole parts: three all chordjack, one part with the rest of it, six streamed
    assert.equal(js.filter((x) => x > 1 - 1e-9).length, 3, js.join(", "));
    assert.equal(js.filter((x) => x > 1e-9 && x < 1 - 1e-9).length, 1, js.join(", "));
    assert.equal(js.filter((x) => x < 1e-9).length, 6, js.join(", "));
    plan.parts.forEach((p, i) => {
        if (js[i] > 1 - 1e-9) assert.deepEqual(p.patterns, [{ name: "Chordjack", share: 1 }]);
        assert.ok(p.patterns.every((x, k) => k === 0 || x.share <= p.patterns[k - 1].share), "the largest first");
    });
    // the song keeps the jumpstream and handstream time (its jump and chord trills) of the need's plan: what the
    // chordjack parts had of it goes to the streamed parts in place of their plain stream, so the parts with little
    // kick (every third, all stream on their own) take jumpstream and handstream too
    const time = (mixes, name) => mixes.reduce((s, m, i) => s + (TEN[i].endMs - TEN[i].startMs) * (m.find((x) => x.name === name)?.share ?? 0), 0);
    for (const name of ["Stream", "Jumpstream", "Handstream"]) {
        assert.ok(time(own, name) > 0, name);
        assert.ok(Math.abs(time(plan.parts.map((p) => p.patterns), name) - time(own, name)) < 1e-6, `${name}: ${time(plan.parts.map((p) => p.patterns), name)} against ${time(own, name)}`);
    }
    plan.parts.forEach((p, i) => {
        if (i % 3 === 2 && js[i] < 1e-9) assert.deepEqual(p.patterns.map((x) => x.name).sort(), ["Handstream", "Jumpstream", "Stream"], `part ${i}`);
    });
    // the loudest parts get it first (the quieter every third part, with fewer kicks, is streamed)
    const full = js.map((x, i) => [x, i]).filter(([x]) => x > 1e-9).map(([, i]) => i);
    assert.ok(full.every((i) => i % 3 !== 2), full.join(", "));
    // the stems' chordjack part first of all: the test song's drop, then the rest
    const near = autoPlan({ song: makeSong(), parts: PARTS, profile: NEAR, available: ALL });
    assert.deepEqual(near.parts[1].patterns, PART_MIX.drums);
    // a quiet part's own easier dan pools with its own kind only: the loud parts' chordjack never goes to it
    const g = partFeatures({ parts: PARTS, envelope: makeSong().envelope, stems: makeSong().stems, bpm: BPM });
    near.parts.forEach((p, i) => {
        if (p.range) assert.deepEqual(p.patterns, partMix(g[i], PARTS[i].kind, { dan: near.target - 2, bpm: BPM }), `part ${i}`);
    });
    // one part at a dan: as the need has it
    const one = autoPlan({ song: realSong(), parts: [], profile: profileAt(dan), available: ALL });
    const fo = partFeatures({ parts: [{ startMs: 0, endMs: 100000, kind: "part" }], envelope: song.envelope, stems: song.stems, bpm: 160 });
    assert.deepEqual(one.parts[0].patterns, partMix(fo[0], "part", { dan: one.target, bpm: 160 }));
});

test("the mixes: where the stems cannot tell families apart a part gets several, the main one first", () => {
    for (const mix of Object.values(PART_MIX)) {
        assert.ok(Math.abs(mix.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
        assert.ok(mix.every((x, k) => k === 0 || x.share <= mix[0].share), "the main family first");
        assert.ok(Object.isFrozen(mix));
    }
    // loud parts with drums: mostly jumpstream, with streams (single-note trills) and a little handstream (chord trills)
    assert.deepEqual(partMix(REAL).map((x) => x.name), ["Jumpstream", "Stream", "Handstream"]);
    // busy loud drums more percussive than the rest of the song: chordjack; no more percussive: the loud mix
    const busy = { ...REAL, kickBeat: 2.5 };
    assert.deepEqual(partMix(busy, "drop"), PART_MIX.loud);
    assert.deepEqual(partMix({ ...busy, percLift: 0.05 }, "drop"), [{ name: "Chordjack", share: 1 }]);
    // little kick: streams only; quiet parts: one family
    assert.deepEqual(partMix({ ...REAL, kickBeat: 0.5 }), [{ name: "Stream", share: 1 }]);
    assert.deepEqual(partMix({ ...REAL, loud: 0.5 }), [{ name: "Stream", share: 1 }]);
    assert.deepEqual(partMix({ ...REAL, loud: 0.5, drums: 0.1 }), [{ name: "Tech", share: 1 }]);
    // without stems as before: one family by loudness
    assert.deepEqual(partMix({ loud: 0.9, drums: null }), [{ name: "Jumpstream", share: 1 }]);
    assert.deepEqual(partMix({ loud: 0.9, drums: null }, "intro"), [{ name: "Stream", share: 1 }]);
    // a mix is a copy: changing it changes no table
    partMix(REAL)[0].share = 0;
    assert.equal(PART_MIX.loud[0].share > 0, true);
});

test("the need: far over what its tempo's streams reach a streamed part turns to chordjack and jack, handstream gives way", () => {
    const share = (mix, name) => mix.find((x) => x.name === name)?.share ?? 0;
    const BPM_AT = 150;
    const at = (need, f = REAL, kind = "part") => partMix(f, kind, { dan: reachDan(BPM_AT) + need, bpm: BPM_AT });
    assert.ok(Math.abs(needOf(reachDan(BPM_AT) + 2.5, BPM_AT) - 2.5) < 1e-9);
    const plainNeed = (need) => reachDan(BPM_AT) + need - tempoDan(BPM_AT);
    // up to where chordjack starts (NEED.chord[0]; the handstream's turn, NEED.hand, counts from the plain stream's dan
    // and starts later at this tempo): the mixes as they are
    assert.ok(NEED.chord[0] <= NEED.jack[0] && plainNeed(NEED.chord[0]) <= NEED.hand[0]);
    for (const need of [-9, NEED.chord[0]]) {
        assert.deepEqual(at(need), PART_MIX.loud, `need ${need}`);
        assert.deepEqual(at(need, { ...REAL, kickBeat: 0.5 }), PART_MIX.sparse, `need ${need}`);
    }
    // no dan: the stems' mix
    assert.deepEqual(partMix(REAL, "part", null), PART_MIX.loud);
    assert.deepEqual(partMix(REAL), PART_MIX.loud);
    // chordjack grows with the need (NEED.chord, then NEED.deep), jack comes in from NEED.jack[0], handstream (the chord
    // trills) is gone by NEED.hand[1] over the plain stream's dan
    assert.ok(NEED.chord[1] < NEED.deep[0]);
    let last = 0;
    for (const need of [NEED.chord[0] + 0.5, (NEED.chord[0] + NEED.chord[1]) / 2, NEED.chord[1], NEED.deep[0] + 0.5, NEED.deep[1]]) {
        const mix = at(need);
        assert.ok(Math.abs(mix.reduce((s, x) => s + x.share, 0) - 1) < 1e-9, `need ${need}`);
        assert.ok(mix.every((x, k) => k === 0 || x.share <= mix[k - 1].share), `need ${need}: the largest first`);
        assert.ok(share(mix, "Chordjack") > last, `need ${need}`);
        last = share(mix, "Chordjack");
        if (need <= NEED.jack[0]) assert.equal(share(mix, "Jack"), 0);
        if (plainNeed(need) >= NEED.hand[1]) assert.equal(share(mix, "Handstream"), 0);
        // chordjack and jack take their share of handstream too, which keeps the rest of its own till NEED.hand[0]
        if (plainNeed(need) <= NEED.hand[0]) assert.ok(Math.abs(share(mix, "Handstream") - share(PART_MIX.loud, "Handstream") * (1 - share(mix, "Chordjack") - share(mix, "Jack"))) < 1e-9);
        // the streams keep their proportions in what is left
        assert.ok(Math.abs(share(mix, "Jumpstream") / share(mix, "Stream") - share(PART_MIX.loud, "Jumpstream") / share(PART_MIX.loud, "Stream")) < 1e-9);
    }
    const mid = (NEED.hand[0] + NEED.hand[1]) / 2 - plainNeed(0);
    assert.ok(share(at(mid), "Handstream") > 0 && share(at(mid), "Handstream") < share(PART_MIX.loud, "Handstream"));
    // a fast song: far under the reach no chordjack, but the handstream gives way all the same (the human maps hold no
    // chord trills that far over the plain stream's dan, at any tempo)
    const fast = (p) => partMix(REAL, "part", { dan: tempoDan(230) + p, bpm: 230 });
    assert.deepEqual(fast(NEED.hand[0]), PART_MIX.loud);
    assert.equal(share(fast(NEED.hand[1]), "Handstream"), 0);
    assert.equal(share(fast(NEED.hand[1]), "Chordjack"), 0);
    assert.ok(Math.abs(fast(NEED.hand[1]).reduce((q, x) => q + x.share, 0) - 1) < 1e-9);
    assert.deepEqual(at(9).map((x) => x.name), ["Chordjack", "Jumpstream", "Stream", "Jack"]);
    assert.ok(Math.abs(share(at(9), "Chordjack") - NEED.chordTop - NEED.deepTop) < 1e-9 && Math.abs(share(at(9), "Jack") - NEED.jackTop) < 1e-9);
    // between the two ramps it holds
    assert.ok(Math.abs(share(at(NEED.chord[1]), "Chordjack") - share(at(NEED.deep[0]), "Chordjack")) < 1e-9);
    // little kick, or not loud: streams, and over the reach chordjack and jack the same way
    assert.deepEqual(at(9, { ...REAL, kickBeat: 0.5 }, "intro").map((x) => x.name), ["Chordjack", "Stream", "Jack"]);
    assert.deepEqual(at(9, { ...REAL, loud: 0.5 }).map((x) => x.name), ["Chordjack", "Stream", "Jack"]);
    // quiet melodic (tech), the busy drums (chordjack) and no stems: as they are
    assert.deepEqual(at(9, { ...REAL, loud: 0.5, drums: 0.1 }), [{ name: "Tech", share: 1 }]);
    assert.deepEqual(at(9, { ...REAL, kickBeat: 2.5, percLift: 0.05 }), PART_MIX.drums);
    assert.deepEqual(at(9, { loud: 0.9, drums: null }), [{ name: "Jumpstream", share: 1 }]);
    // the stems' chordjack: all chordjack from NEED.drums[1] on, streamed like a loud part under NEED.drums[0], between
    // the two blended (the chordjack's share growing)
    const drums = { ...REAL, kickBeat: 2.5, percLift: 0.05 };
    assert.deepEqual(at(NEED.drums[1], drums), PART_MIX.drums);
    assert.deepEqual(at(NEED.drums[0], drums), at(NEED.drums[0]));
    assert.deepEqual(at(-9, drums), PART_MIX.loud);
    const half = at((NEED.drums[0] + NEED.drums[1]) / 2, drums);
    assert.ok(Math.abs(half.reduce((q, x) => q + x.share, 0) - 1) < 1e-9);
    assert.equal(half[0].name, "Chordjack");
    assert.ok(share(half, "Chordjack") > 0.5 && share(half, "Chordjack") < 1 && share(half, "Jumpstream") > 0, JSON.stringify(half));
    assert.equal(familyForPart(drums), "Chordjack");
    // familyForPart: the stems alone
    assert.equal(familyForPart({ ...REAL, kickBeat: 0.5 }), "Stream");
});

test("the reach of the stream families climbs faster with the tempo than the plain stream's dan", () => {
    // the human maps' line between the stream and the jack families: about the plain stream's dan (2 + BPM/22) at
    // 120 BPM, six dans over it at 200
    assert.ok(Math.abs(reachDan(120) - (2 + 120 / 22)) < 0.5, `${reachDan(120)}`);
    assert.ok(reachDan(200) - (2 + 200 / 22) > 5, `${reachDan(200)}`);
    assert.ok(REACH.perBpm > 2 / 22);
    const jackish = (dan, bpm) => partMix(REAL, "part", { dan, bpm }).filter((x) => x.name === "Chordjack" || x.name === "Jack").reduce((s, x) => s + x.share, 0);
    // the review's #45 (a stream map of dan 17 at 200 BPM, 5.9 over the plain stream's dan, planned 73% chordjack): its
    // streamed parts stay mostly streams; as far over the plain stream's dan at 120 BPM (dan 13.35), mostly chordjack
    const over = (bpm) => 2 + bpm / 22 + 5.9;
    assert.ok(jackish(over(200), 200) < 0.5, `${jackish(over(200), 200)}`);
    assert.ok(jackish(over(120), 120) > 0.5, `${jackish(over(120), 120)}`);
    // the deep share comes with the tempo (NEED.deepBpm): as far over the line, a slow song gets the first 0.4 and the
    // jack, a song from NEED.deepBpm[1] on the deep share too (the review's #107, 120 BPM, 7.8 over the line: 70% → 55%)
    for (const need of [3, 5, 8]) {
        const at = (bpm) => jackish(reachDan(bpm) + need, bpm);
        assert.ok(Math.abs(at(NEED.deepBpm[1]) - at(NEED.deepBpm[0]) - NEED.deepTop * Math.min(1, (need - NEED.deep[0]) / (NEED.deep[1] - NEED.deep[0]))) < 1e-9, `need ${need}`);
        assert.ok(Math.abs(at(NEED.deepBpm[1]) - at(175)) < 1e-9, `need ${need}`);
        assert.ok(at(100) === at(NEED.deepBpm[0]) && at(120) < at(140), `need ${need}`);
    }
    assert.ok(Math.abs(jackish(reachDan(120) + 7.8, 120) - 0.55) < 0.01, `${jackish(reachDan(120) + 7.8, 120)}`);
    // the review's #64 and #129 (jack maps a little under their slow tempo's dan, planned all streams): some chordjack;
    // as far under a fast tempo's dan: none
    assert.ok(jackish(5.5, 121) > 0.1, `${jackish(5.5, 121)}`);
    assert.equal(jackish(9.1, 200), 0);
    // over what the densest streams reach at any tempo (NEED.over): chordjack even where the tempo's streams reach far
    assert.ok(reachDan(256) > 20);
    assert.ok(jackish(18.5, 256) >= NEED.overTop - 1e-9, `${jackish(18.5, 256)}`);
    assert.equal(jackish(15.2, 235), 0);
});

test("over what our streams reach (streamTop) chordjack comes in by the tempo: fast songs our streams reach stay streams", () => {
    const jackish = (dan, bpm) => jackShare(partMix(REAL, "part", { dan, bpm }));
    // the review's #61 (260 BPM, dan 17.2, a jump-trill map that HEAD's streams hit) and #14 (377 BPM, 17.2) get none,
    // #15 (273 BPM, 18.1) a little: our streams reach more the faster the song
    assert.equal(jackish(17.2, 260), 0);
    assert.equal(jackish(17.2, 377), 0);
    assert.ok(jackish(18.1, 273) > 0 && jackish(18.1, 273) < 0.25, `${jackish(18.1, 273)}`);
    assert.ok(streamTop(260) > 17.2 && streamTop(300) > streamTop(260), `${streamTop(260)}`);
    // up to NEED.overBpm they top out at NEED.over[0]: the review's #74 (209 BPM, dan 17.8) and #110 (256 BPM, 18.5),
    // which streams missed, get the whole NEED.overTop
    assert.equal(streamTop(150), NEED.over[0]);
    assert.equal(streamTop(NEED.overBpm), NEED.over[0]);
    assert.ok(jackish(17.8, 209) >= NEED.overTop - 1e-9, `${jackish(17.8, 209)}`);
    assert.ok(jackish(18.5, 256) >= NEED.overTop - 1e-9, `${jackish(18.5, 256)}`);
    // and keep their jumpstream: #61's loud parts as the stems have them, but for the handstream far over the plain stream's dan
    assert.deepEqual(partMix(REAL, "part", { dan: 17.2, bpm: 260 }).map((x) => x.name), ["Jumpstream", "Stream"]);
});

test("on fast songs under the line chordjack tops out lower (NEED.chordTopFast from NEED.chordBpm[1]), on the line as before", () => {
    const jackish = (dan, bpm) => jackShare(partMix(REAL, "part", { dan, bpm }));
    // the review's #11: a 190 BPM stream map of dan 14, 1.8 under the line, planned 35% chordjack: about half of that
    const n = needOf(14, 190);
    assert.ok(Math.abs(n + 1.8) < 0.05);
    const ramp = (x, [a, b]) => Math.min(1, Math.max(0, (x - a) / (b - a)));
    assert.ok(NEED.chordTopFast < NEED.chordTop);
    assert.ok(Math.abs(jackish(14, 190) - NEED.chordTopFast * ramp(n, NEED.chord)) < 1e-9, `${jackish(14, 190)}`);
    assert.ok(jackish(14, 190) < 0.2, `${jackish(14, 190)}`);
    // as far under the line at a slower tempo: NEED.chord's share as before; in between, in between
    assert.ok(Math.abs(jackish(reachDan(150) + n, 150) - NEED.chordTop * ramp(n, NEED.chord)) < 1e-9);
    assert.ok(jackish(reachDan(175) + n, 175) < jackish(reachDan(150) + n, 150) && jackish(reachDan(175) + n, 175) > jackish(14, 190));
    // well under the line none, as before; from NEED.chord[1] it climbs back to NEED.chordTop on the line, and over it
    // the fast song's chordjack is the slow one's
    assert.equal(jackish(reachDan(200) + NEED.chord[0], 200), 0);
    assert.ok(Math.abs(jackish(reachDan(200) + NEED.chord[1], 200) - NEED.chordTopFast) < 1e-9);
    assert.ok(jackish(reachDan(200) - 0.6, 200) > NEED.chordTopFast && jackish(reachDan(200) - 0.6, 200) < NEED.chordTop);
    assert.ok(Math.abs(jackish(reachDan(200), 200) - NEED.chordTop) < 1e-9);
    assert.ok(Math.abs(jackish(reachDan(185) + 1, 185) - jackish(reachDan(150) + 1, 150)) < 1e-9 && reachDan(185) + 1 < NEED.over[0]);
});

test("a slow song a player wants far over its tempo's reach gets chordjack and jack; under it, the streamed mixes", () => {
    // the review's case: a 113 BPM chordjack map of dan 14.8 that Auto planned as all-stream, and missed by 5 dans
    const song = { ...makeSong(), bpm: 113 };
    const f = partFeatures({ parts: PARTS, envelope: song.envelope, stems: song.stems, bpm: song.bpm });
    const planAt = (dan) => autoPlan({ song, parts: PARTS, profile: { state: "ready", skill: { overall: dan - (GROWTH.lo + GROWTH.hi) / 2 } }, available: ALL });
    const low = planAt(reachDan(113) + NEED.chord[0]);
    // under the line: the streamed parts as the stems have them, the drop the stems call chordjack streamed too
    assert.deepEqual(low.parts.map((p) => p.patterns), PARTS.map((p, i) => (i === 1 ? PART_MIX.loud : partMix(f[i], p.kind))));
    assert.equal(familyForPart(f[1], "drop"), "Chordjack");
    assert.ok(!low.patterns.some((p) => p.name === "Jack"));
    const high = planAt(14.8);
    assert.equal(high.target, 14.8);
    // the verse (no kick) and the bridge (melodic) are streamed at the song's dan: now half chordjack and jack or more
    for (const k of [2, 3]) assert.ok(jackShare(high.parts[k].patterns) >= 0.5, `part ${k}: ${JSON.stringify(high.parts[k].patterns)}`);
    assert.ok(high.patterns.find((p) => p.name === "Jack")?.share >= 1, JSON.stringify(high.patterns));
    assert.ok(high.patterns.find((p) => p.name === "Chordjack").share >= 50, JSON.stringify(high.patterns));
    // the quiet intro keeps its own easier range and stays tech
    assert.ok(high.parts[0].range);
    assert.deepEqual(high.parts[0].patterns, [{ name: "Tech", share: 1 }]);
    // the main family is the plan's: chordjack
    assert.equal(high.main, "Chordjack");
    assert.equal(high.patterns.reduce((s, p) => s + p.share, 0), 100);
});

test("the main family is the plan's, counted by the profile's tiles, and its tile gives the dan", () => {
    const TILE = { Stream: "speed", Jumpstream: "speed", Handstream: "stamina", Chordjack: "jack", Jack: "jack", Tech: "tech" };
    // loud time by family and by tile, over the loud parts (f: the parts' features)
    const loudTime = (p, f, name) => p.parts.reduce((s, x, i) => s + (f[i].loud > 0.5 ? (x.endMs - x.startMs) * (x.patterns.find((y) => y.name === name)?.share ?? 0) : 0), 0);
    const FAMS = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
    const tileTime = (p, f, tile) => FAMS.filter((n) => TILE[n] === tile).reduce((s, n) => s + loudTime(p, f, n), 0);
    const consistent = (p, f) => {
        const tiles = [...new Set(Object.values(TILE))];
        const top = tiles.sort((a, b) => tileTime(p, f, b) - tileTime(p, f, a))[0];
        assert.equal(TILE[p.main], top, `${p.main}: ${tiles.map((t) => t + " " + tileTime(p, f, t)).join(", ")}`);
        for (const n of FAMS.filter((x) => TILE[x] === top)) assert.ok(loudTime(p, f, p.main) >= loudTime(p, f, n), n);
    };
    // the review's case: a loud part 2 dans under the line at 120 BPM is 32% chordjack, 24% jumpstream, 24% stream and
    // 20% handstream. Chordjack is its largest family, but stream and jumpstream are both played on the speed tile and
    // hold 48%: a speed plan, and the speed tile gives the dan, not the jack tile
    const song = realSong(120);
    const whole = [{ startMs: 0, endMs: 100000, kind: "part" }];
    const fw = partFeatures({ parts: whole, envelope: song.envelope, stems: song.stems, bpm: 120 });
    const speed = Math.round((reachDan(120) - 2) * 10) / 10;
    const plan = autoPlan({ song, parts: [], profile: profileAt(speed, { speed: speed - (GROWTH.lo + GROWTH.hi) / 2, jack: speed + 2 }), available: ALL });
    assert.equal(plan.target, speed);
    assert.equal(plan.parts[0].patterns[0].name, "Chordjack", JSON.stringify(plan.parts[0].patterns));
    assert.ok(jackShare(plan.parts[0].patterns) < 0.4);
    assert.equal(plan.main, "Jumpstream");
    assert.equal(plan.playerDan, speed - (GROWTH.lo + GROWTH.hi) / 2);
    consistent(plan, fw);
    // the summary says so too: the part's family by its tile, not its mix's first entry
    assert.deepEqual(plan.groups, [{ kind: "part", family: "Jumpstream" }]);
    // a player far over the line: the jack tile holds most of the time, its dan is the jack tile's
    const high = autoPlan({ song, parts: [], profile: profileAt(14, { speed: 13, jack: 14 - (GROWTH.lo + GROWTH.hi) / 2 }), available: ALL });
    assert.equal(high.main, "Chordjack");
    assert.equal(high.target, 14);
    consistent(high, fw);
    // without tiles: the overall dan, and still the plan's own main family
    const overall = autoPlan({ song, parts: [], profile: profileAt(14), available: ALL });
    assert.equal(overall.main, "Chordjack");
    assert.equal(overall.target, 14);
    // under the reach the plan streams, and its main family says so
    const streamed = autoPlan({ song, parts: [], profile: { state: "ready", skill: { overall: 3, tiles: { speed: 3, jack: 14 } } }, available: ALL });
    assert.ok(["Jumpstream", "Stream"].includes(streamed.main), streamed.main);
    assert.equal(streamed.playerDan, 3);
    // tiles that send the plan back and forth (speed 14 → chordjack → jack 3 → streams → speed 14 …): the overall dan
    const torn = autoPlan({ song, parts: [], profile: { state: "ready", skill: { overall: 9, tiles: { speed: 14, jack: 3 } } }, available: ALL });
    assert.equal(torn.playerDan, 9);
    // the test song's parts, at the speed tile a slow song's plan of mostly chordjack: the jack tile
    const base = makeSong();
    const slow = { ...base, bpm: 113, stems: { ...base.stems, percShare: new Float32Array(SEC / HOP).fill(0.3) } };
    const fs = partFeatures({ parts: PARTS, envelope: slow.envelope, stems: slow.stems, bpm: slow.bpm });
    assert.ok(PARTS.every((p, i) => familyForPart(fs[i], p.kind) !== "Chordjack"), "the stems alone: no chordjack");
    const jacky = autoPlan({ song: slow, parts: PARTS, profile: { state: "ready", skill: { overall: 13, tiles: { speed: 13, jack: 15 } } }, available: ALL });
    assert.equal(jacky.main, "Chordjack");
    assert.equal(jacky.playerDan, 15);
    for (const p of [streamed, torn]) consistent(p, fw);
    consistent(jacky, fs);
});

test("levelStepOf follows the label scale", () => {
    assert.deepEqual(levelStepOf(13), { level: 13, step: "mid" });
    assert.deepEqual(levelStepOf(12.6), { level: 13, step: "low" });
    assert.deepEqual(levelStepOf(13.2), { level: 13, step: "mid/high" });
    assert.deepEqual(levelStepOf(25), { level: 20, step: "high" });
    assert.deepEqual(levelStepOf(0), { level: 1, step: "low" });
});

test("the summary names the dan, each kind's pattern and the model, in Russian and in English", () => {
    // Alpha at 160 BPM, a dan and a half under what its streams reach: the verse and the bridge take some chordjack but
    // stay mostly streamed
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: { state: "ready", skill: { overall: 10.8 } }, available: ALL });
    const names = { intro: "вступление", drop: "дроп", part: "куплет", break: "бридж" };
    try {
        setLang("ru");
        const ru = autoSummary(plan, { kindName: (k) => names[k], modelName: () => "нейросеть M" });
        assert.match(ru[0], /^Автоподбор: Alpha/);
        assert.match(ru[0], /дроп — чордджек/);
        assert.match(ru[0], /куплет — стрим/);
        assert.match(ru[0], /вступление — тех/);
        assert.match(ru[0], /модель: нейросеть M$/);
        assert.match(ru[1], /из твоего профиля/);
        setLang("en");
        const en = autoSummary(plan, { kindName: (k) => k, modelName: () => "neural M" });
        assert.match(en[0], /^Auto: Alpha/);
        assert.match(en[0], /drop — chordjack/);
        assert.match(en[0], /model: neural M$/);
        assert.match(en[1], /your profile/);
    } finally {
        setLang("ru");
    }
});

test("long sustained sound is named: the generator makes no LNs", () => {
    const plan = autoPlan({ song: makeSong(), parts: PARTS, profile: null, available: ALL });
    assert.ok(plan.sustained.includes(0), "the intro holds long melodic sound with few attacks");
    try {
        setLang("en");
        const lines = autoSummary(plan);
        assert.ok(lines.some((l) => /no LNs/.test(l)));
    } finally {
        setLang("ru");
    }
});
