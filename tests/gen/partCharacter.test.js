// A song part's own «Характер» (0.10.6): stamina and burst (0..1) on a part — checked (gen.parts.bad), kept through
// normalizeParts (a merged part keeps its neighbour's), and applied by every generator inside that part only. Both draw
// such a part last, over the finished map: the search, the critic and the weak-block retries know nothing of it, so
// every row outside it is the row of the map without it, whatever the analyser reads and with repeats on. Without a part
// character (or with one equal to the whole map's) every map is the one it was before, bit for bit.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeParts, normalizeRequest, hasOwnCharacter, characterOf, ownCharacterParts } from "../../src/gen/request.js";
import { slotIntensity, shapeEnergy, withPartCharacter, partActivity, partMeans } from "../../src/gen/intensity.js";
import { generateMap } from "../../src/gen/generate.js";
import { generateLearnedMap } from "../../src/gen/generateLearned.js";
import { generateToTarget } from "../../src/gen/targeting.js";
import { backInRange } from "../../src/gen/searchSteps.js";
import { autoPlan } from "../../src/gen/autoPlan.js";
import { AUDIO_FEATURES } from "../../src/gen/slotFeatures.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { onsetEnvelope } from "../../src/audio/onset.js";
import { computeStemsSync, stemsFromTransfer, stemsToTransfer } from "../../src/audio/stems.js";
import { setLang } from "../../src/i18n/i18n.js";
import { goldenModel } from "../fixtures/familyGolden.js";
import { sectionSong } from "../fixtures/stemTracks.js";

// ---- the request ----

const part = (over = {}) => ({ startMs: 0, endMs: 30000, kind: "drop", ...over });
const errorOf = (fn) => {
    try {
        fn();
    } catch (e) {
        return e.message;
    }
    return null;
};

test("a part's stamina and burst: numbers 0..1, either one alone; anything else names the field", () => {
    setLang("en");
    try {
        const ok = normalizeParts([part({ stamina: 1, burst: 0 }), part({ startMs: 30000, endMs: 60000, burst: 0.75 }), part({ startMs: 60000, endMs: 90000, stamina: null, burst: undefined })], 90000);
        assert.deepEqual(ok.map((p) => [p.stamina, p.burst]), [[1, 0], [undefined, 0.75], [undefined, undefined]]);
        assert.ok(!("stamina" in ok[2]) && !("burst" in ok[2]), "null / absent: no key at all");
        for (const [bad, field] of [[{ stamina: 1.01 }, "stamina"], [{ stamina: -0.01 }, "stamina"], [{ burst: "0.5" }, "burst"], [{ burst: Number.NaN }, "burst"], [{ stamina: true }, "stamina"], [{ burst: Infinity }, "burst"]]) {
            const message = errorOf(() => normalizeParts([part(), part({ startMs: 30000, endMs: 60000, ...bad })], 90000));
            assert.equal(message, `The song parts are invalid: parts[1].${field}`, JSON.stringify(bad));
        }
    } finally {
        setLang("ru");
    }
});

test("a merged part keeps its neighbour's character, as it keeps its other settings", () => {
    // 0–1 s is under a bar: it goes into the part after it, whose character stays; a short part's own one goes with it
    const parts = normalizeParts([
        part({ endMs: 1000, stamina: 0.1, burst: 0.9 }),
        part({ startMs: 1000, endMs: 30000, stamina: 0.8 }),
        part({ startMs: 30000, endMs: 30500, stamina: 0.2 }),
        part({ startMs: 30500, endMs: 90000 }),
    ], 90000);
    assert.deepEqual(parts.map((p) => [p.startMs, p.endMs, p.stamina, p.burst]), [[0, 30500, 0.8, undefined], [30500, 90000, undefined, undefined]]);
});

test("characterOf: a part's own values, the whole map's for the rest; hasOwnCharacter", () => {
    const whole = { stamina: 0.5, burst: 0.3 };
    assert.deepEqual(characterOf({}, whole), whole);
    assert.deepEqual(characterOf({ stamina: 1 }, whole), { stamina: 1, burst: 0.3 });
    assert.deepEqual(characterOf({ stamina: 0, burst: 0 }, whole), { stamina: 0, burst: 0 });
    assert.equal(hasOwnCharacter({}), false);
    assert.equal(hasOwnCharacter({ stamina: undefined, burst: null }), false);
    assert.equal(hasOwnCharacter({ burst: 0 }), true);
    assert.equal(hasOwnCharacter(null), false);
});

test("ownCharacterParts: only the parts that differ from the whole map; never an empty one", () => {
    const whole = { stamina: 0.5, burst: 0.3 };
    assert.deepEqual(ownCharacterParts([{}, { stamina: 0.5 }, { stamina: 0.5, burst: 0.3 }, { burst: 0.9 }, { stamina: 1, empty: true }, { stamina: 0 }], whole), [3, 5]);
});

test("partActivity: 0 at a part's calmest tenth, 1 at its busiest, on its own scale; a flat part 0.5; no window over a part's edge", () => {
    const slots = Array.from({ length: 300 }, (_, i) => ({ t: i * 100, beatMs: 400 }));
    const partOf = Int16Array.from(slots, (_, i) => (i < 100 ? 0 : i < 200 ? 1 : 2));
    // part 0: a calm and a busy half far apart in level from part 1's, which is 100 times louder; part 2 is flat
    const strengths = Float64Array.from(slots, (_, i) => (i < 50 ? 0.01 : i < 100 ? 0.02 : i < 150 ? 1 : i < 200 ? 2 : 0.5));
    const a = partActivity(strengths, slots, partOf);
    assert.ok(a[10] === 0 && a[90] === 1, `part 0: ${a[10]}, ${a[90]}`);
    assert.ok(a[110] === 0 && a[190] === 1, `part 1 on its own scale: ${a[110]}, ${a[190]}`);
    assert.ok(a.slice(200).every((v) => v === 0.5), "a flat part");
    assert.ok(a.every((v) => v >= 0 && v <= 1));
    assert.equal(a[100], a[110], "part 1's first slot does not read part 0");
});

test("partMeans: each part's own mean; a part with no slots 0.5", () => {
    const means = partMeans(Float64Array.of(0, 1, 0.2, 0.4, 0.6), Int16Array.of(0, 0, 2, 2, 2), 3);
    assert.deepEqual([...means].map((v) => Math.round(v * 100) / 100), [0.5, 0.5, 0.4]);
});

test("backInRange: the first step that comes back; the closest try when none does", async () => {
    // dan = 5 + knob, the range [5.5, 6.5), from knob 3 (8.0): steps of 0.5 down
    const tries = [];
    const draw = async (knob) => { tries.push(knob); return { knob, numeric: 5 + knob }; };
    const back = await backInRange({ draw, start: { knob: 3, numeric: 8 }, range: { lo: 5.5, hi: 6.5 }, span: 2 });
    assert.deepEqual(tries, [2.5, 2, 1.5, 1], "and stops there");
    assert.equal(back.numeric, 6);
    const up = await backInRange({ draw, start: { knob: -2, numeric: 3 }, range: { lo: 5.5, hi: 6.5 }, span: 4 });
    assert.equal(up.numeric, 6, "too easy: upwards");
    // the span ends short of the range: the closest try
    const short = await backInRange({ draw, start: { knob: 3, numeric: 8 }, range: { lo: 5.5, hi: 6.5 }, span: 1 });
    assert.equal(short.numeric, 7);
    // a reading that jumps past the range is not taken over a step that lands in it
    const bumpy = await backInRange({ draw: async (knob) => ({ knob, numeric: knob === 2.5 ? 6.2 : 2 }), start: { knob: 3, numeric: 8 }, range: { lo: 5.5, hi: 6.5 }, span: 2 });
    assert.equal(bumpy.knob, 2.5);
    const none = await backInRange({ draw: async (knob) => ({ knob, numeric: -Infinity }), start: { knob: 0, numeric: 2 }, range: { lo: 5.5, hi: 6.5 }, span: 2 });
    assert.equal(none.knob, 0, "a failed analysis is no better than the start");
});

test("backInRange: two steps running that come no closer end it, each being a whole draw of the song", async () => {
    const tries = [];
    const stuck = await backInRange({ draw: async (knob) => { tries.push(knob); return { knob, numeric: 7 }; }, start: { knob: 3, numeric: 7 }, range: { lo: 5.5, hi: 6.5 }, span: 2 });
    assert.deepEqual(tries, [2.5, 2]);
    assert.equal(stuck.knob, 3, "the start stays");
    // one step that does come closer starts the count again
    const readings = [7.5, 7.5, 7.2, 7.4, 7.4];
    const steps = [];
    const slow = await backInRange({ draw: async (knob) => { steps.push(knob); return { knob, numeric: readings[steps.length - 1] }; }, start: { knob: 3, numeric: 8 }, range: { lo: 5.5, hi: 6.5 }, span: 5, steps: 5 });
    assert.equal(steps.length, 5);
    assert.equal(slow.numeric, 7.2);
});

test("withPartCharacter: no own character → the same array untouched; else the part's slots only take their shape", () => {
    const raw = Float64Array.from({ length: 64 }, (_, i) => (i % 8 === 0 ? 1 : i % 2 === 0 ? 0.4 : 0.1));
    const partOf = Int32Array.from({ length: 64 }, (_, i) => (i < 32 ? 0 : 1));
    const request = normalizeRequest({ target: 5, patterns: [{ name: "Stream", share: 1 }], seed: 1 });
    const shape = (c) => slotIntensity(raw, c);
    const base = slotIntensity(raw, request);
    const copy = Float64Array.from(base);
    const same = withPartCharacter(base, { parts: [{}, { stamina: null }], partOf, request, shape });
    assert.equal(same, base);
    assert.deepEqual(same, copy);
    const own = withPartCharacter(Float64Array.from(base), { parts: [{}, { stamina: 1, burst: 1 }], partOf, request, shape });
    const full = slotIntensity(raw, { stamina: 1, burst: 1 });
    for (let i = 0; i < 64; i += 1) assert.equal(own[i], i < 32 ? base[i] : full[i], `slot ${i}`);
    const energy = withPartCharacter(shapeEnergy(raw, request), { parts: [{ stamina: 1 }, {}], partOf, request, shape: (c) => shapeEnergy(raw, c) });
    assert.ok(energy.slice(0, 32).every((e) => e === 1), "full stamina: no light part left to rest in");
});

test("Auto leaves the parts without a character of their own", () => {
    const envelope = onsetEnvelope(characterSong(), 22050);
    const plan = autoPlan({
        song: { bpm: 180, durationMs: 90000, envelope },
        parts: [part({ stamina: 1, burst: 1 }), part({ startMs: 30000, endMs: 90000, kind: "break", burst: 0 })],
    });
    assert.ok(plan.parts.every((p) => !hasOwnCharacter(p)), JSON.stringify(plan.parts));
});

// ---- the generators ----

// 180 BPM 1/4 clicks from 300 ms for 90 s, in 4 s phrases that are loud (1) and soft (0.3) by turns; two stretches of
// silence: 40–46 s (in the middle part) and 70–76 s (in the last one).
const SILENT = [[40000, 46000], [70000, 76000]];
function characterSong({ seconds = 90, sampleRate = 22050 } = {}) {
    const out = new Float32Array(seconds * sampleRate);
    let s = 11;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const step = 60000 / 180 / 4;
    for (let t = 300; t < seconds * 1000; t += step) {
        if (SILENT.some(([a, b]) => t >= a && t < b)) continue;
        const gain = loudAt(t) ? 1 : 0.3;
        const start = Math.round((t / 1000) * sampleRate);
        for (let k = 0; k < 500 && start + k < out.length; k += 1) {
            const decay = Math.exp(-k / 90);
            out[start + k] += gain * (rand() * 0.7 + 0.6 * Math.sin((2 * Math.PI * 60 * k) / sampleRate)) * decay;
        }
    }
    return out;
}
const loudAt = (t) => Math.floor(t / 4000) % 2 === 0;
let envelope = null;
const song = () => (envelope ??= onsetEnvelope(characterSong(), 22050));
const PARTS = [
    { startMs: 0, endMs: 30000, kind: "drop" },
    { startMs: 30000, endMs: 60000, kind: "break" },
    { startMs: 60000, endMs: 90000, kind: "drop" },
];
const withPart = (over) => PARTS.map((p, i) => (i === 1 ? { ...p, ...over } : p));
const input = (request) => ({
    timing: { sections: [{ timeMs: 300, bpm: 180, meter: 4 }], bpm: 180, offsetMs: 300 },
    envelope: song(), durationMs: 90000,
    request: { target: 5, patterns: [{ name: "Stream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 7, ...request },
    meta: { title: "t", audioFilename: "a.mp3" },
});
// every map reads the same, so the density search takes the same steps whatever the notes: what changes is only
// what the part's character changes
const flat = async () => ({ kind: "ok", numeric: 5, top3: [{ name: "Rolls", share: 1 }] });
const passAll = () => [{ name: "Rolls", share: 1 }];

const FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"];
const singles = [1, 2, 4, 8];
const rolling = {};
for (const a of [0, ...singles]) for (const b of [0, ...singles]) rolling[`${a},${b},1`] = Object.fromEntries(singles.filter((m) => !(m & a) && !(m & b)).map((m) => [m, 10]));
const model = {
    features: AUDIO_FEATURES, families: FAMILIES,
    note: { baseline: [0.5], classes: [0, 1], iterations: [] },
    size: { baseline: [2, 0, -3, -5], classes: [1, 2, 3, 4], iterations: [] },
    pattern: { Stream: rolling },
};

const ENGINES = {
    classic: (request, analyze = flat) => generateMap(input(request), analyze),
    learned: (request, analyze = flat) => generateLearnedMap(input(request), analyze, model, { patternsOf: passAll }),
};
// reads the notes, as the real analyser does: a denser part moves the search
const byDensity = async (osuText) => ({ kind: "ok", numeric: parseRows(osuText).length / 60, top3: [{ name: "Rolls", share: 1 }] });
const rowsOf = (r) => parseRows(r.osuText);
const inside = (rows, a, b) => rows.filter((x) => x.t >= a && x.t < b);
const outside = (rows) => rows.filter((x) => x.t < 30000 || x.t >= 60000);
const timesOf = (rows) => rows.map((x) => x.t);
const BEAT = 60000 / 180;
// the longest stretch of [a, b) with no row, in beats of the 180 BPM song
function longestRest(rows, a, b, beat = BEAT) {
    const times = [a, ...timesOf(inside(rows, a, b)), b];
    return Math.max(...times.slice(1).map((t, k) => (t - times[k]) / beat));
}
const masksOf = (rows) => rows.map((x) => [x.t, x.mask]);
// the smallest share of `plain`'s rows that `rows` has over any 8 beats of [a, b)
function thinnest(rows, plain, a, b) {
    let worst = Infinity;
    for (let t = a; t + 8 * BEAT <= b; t += BEAT) {
        const had = inside(plain, t, t + 8 * BEAT).length;
        if (had) worst = Math.min(worst, inside(rows, t, t + 8 * BEAT).length / had);
    }
    return worst;
}
// the rows on the loud and on the soft phrases of a span (the phrase edges, ±250 ms, left out)
function phraseRows(rows, a, b) {
    const out = { loud: [], soft: [] };
    for (const r of inside(rows, a, b)) {
        const into = r.t % 4000;
        if (into < 250 || into > 3750 || SILENT.some(([x, y]) => r.t >= x - 250 && r.t < y + 250)) continue;
        out[loudAt(r.t) ? "loud" : "soft"].push(r);
    }
    return out;
}
function phraseNotes(rows, a, b) {
    const { loud, soft } = phraseRows(rows, a, b);
    return { loud: loud.length, soft: soft.length };
}

for (const [engine, run] of Object.entries(ENGINES)) {
    test(`${engine}: without a part character the map is the same bit for bit (absent, null, or the whole map's own values)`, async () => {
        const plain = await run({ parts: PARTS });
        assert.equal((await run({ parts: withPart({ stamina: null, burst: undefined }) })).osuText, plain.osuText);
        assert.equal((await run({ parts: withPart({ stamina: 0.5, burst: 0.3 }) })).osuText, plain.osuText, "the same values as the whole map's");
        const other = await run({ parts: PARTS, stamina: 0.9, burst: 0.8 });
        assert.equal((await run({ parts: PARTS.map((p) => ({ ...p, stamina: 0.9, burst: 0.8 })), stamina: 0.9, burst: 0.8 })).osuText, other.osuText);
    });

    test(`${engine}: a part with stamina 1 is denser (and has no rest) there only; the rest of the map keeps its notes`, async () => {
        const plain = rowsOf(await run({ parts: PARTS }));
        const own = rowsOf(await run({ parts: withPart({ stamina: 1 }) }));
        const before = inside(plain, 30000, 60000).length;
        const after = inside(own, 30000, 60000).length;
        assert.ok(after > before * 1.15, `${engine}: the part ${before} → ${after} notes`);
        assert.deepEqual(masksOf(outside(own)), masksOf(outside(plain)), "every row outside the part is the row it was");
        // the silence in the part gets notes; the one in the last part is under the whole map's stamina
        if (engine === "classic") assert.equal(inside(plain, ...SILENT[0]).length, 0, "the whole map's stamina: a rest in the silence");
        assert.ok(inside(own, ...SILENT[0]).length >= 8, `no rest in the part: ${inside(own, ...SILENT[0]).length} notes in its silence`);
    });

    test(`${engine}: an analyser that reads the notes: the search moves nothing outside the part`, async () => {
        // the part gets denser or sparser, the map's dan with it, and the density found stays the map's without them
        const plain = await run({ parts: PARTS }, byDensity);
        for (const over of [{ stamina: 1 }, { stamina: 0 }, { burst: 1 }, { stamina: 1, burst: 0 }]) {
            const own = await run({ parts: withPart(over) }, byDensity);
            assert.deepEqual(masksOf(outside(rowsOf(own))), masksOf(outside(rowsOf(plain))), JSON.stringify(over));
            assert.equal(own.knob, plain.knob, "the knob found is the one without them");
        }
    });

    test(`${engine}: a map its parts' character takes out of its range comes back where their density can do it, by those parts alone`, async () => {
        // the middle of the knob, where a part's density can move: at its top a part of stamina 1 is a full grid whatever
        // the knob does nearby (the test after this one)
        const middle = { target: 9 };
        const plain = await run({ parts: PARTS, ...middle }, byDensity);
        const dan = plain.result.numeric;
        const range = { lo: dan - 0.5, hi: dan + 0.5 };
        const asked = await run({ parts: PARTS, range }, byDensity);
        const wild = await run({ parts: withPart({ stamina: 1 }), ...middle }, byDensity);
        assert.ok(wild.result.numeric >= range.hi, `stamina 1 alone goes over: ${wild.result.numeric} ≥ ${range.hi}`);
        const own = await run({ parts: withPart({ stamina: 1 }), range }, byDensity);
        assert.equal(asked.reachable, true);
        assert.equal(own.reachable, true, `back in range: ${own.result.numeric}`);
        assert.ok(own.result.numeric >= range.lo && own.result.numeric < range.hi);
        assert.deepEqual(masksOf(outside(rowsOf(own))), masksOf(outside(rowsOf(asked))), "the rows outside the part stay");
        const before = inside(rowsOf(asked), 30000, 60000).length;
        const after = inside(rowsOf(own), 30000, 60000).length;
        assert.ok(after > before, `what the range allows of the edit stays: ${before} → ${after}`);
        assert.ok(after < inside(rowsOf(wild), 30000, 60000).length);
    });

    test(`${engine}: a part with bursts 1 puts its notes on the loud phrases, there only`, async () => {
        const plain = rowsOf(await run({ parts: PARTS, burst: 0 }));
        const own = rowsOf(await run({ parts: withPart({ burst: 1 }), burst: 0 }));
        const a = phraseNotes(plain, 30000, 60000);
        const b = phraseNotes(own, 30000, 60000);
        const ratio = (c) => c.loud / Math.max(1, c.soft);
        assert.ok(ratio(b) > ratio(a) * 1.15, `${engine}: loud / soft in the part ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
        assert.deepEqual(masksOf(outside(own)), masksOf(outside(plain)));
    });

    test(`${engine}: a range too narrow to come back to: the map stays out of it and says so, the part is not cut down to fit`, async () => {
        const plain = await run({ parts: PARTS, range: { lo: 0, hi: 1000 } }, byDensity);
        const dan = plain.result.numeric;
        const range = { lo: dan - 0.01, hi: dan + 0.01 };
        const own = await run({ parts: withPart({ stamina: 1 }), range }, byDensity);
        const before = inside(rowsOf(await run({ parts: PARTS, range }, byDensity)), 30000, 60000).length;
        const after = inside(rowsOf(own), 30000, 60000).length;
        assert.ok(after > before * 0.8, `the part keeps its notes: ${before} → ${after}`);
        assert.equal(own.reachable, false, `and the answer says it is out of range: ${own.result.numeric}`);
    });

    test(`${engine}: two parts, each with its own: each only in itself`, async () => {
        const plain = rowsOf(await run({ parts: PARTS }));
        const own = rowsOf(await run({ parts: [{ ...PARTS[0], stamina: 1 }, PARTS[1], { ...PARTS[2], burst: 1 }] }));
        assert.deepEqual(masksOf(inside(own, 30000, 60000)), masksOf(inside(plain, 30000, 60000)), "the part between them");
        assert.notDeepEqual(masksOf(inside(own, 0, 30000)), masksOf(inside(plain, 0, 30000)));
        assert.notDeepEqual(masksOf(inside(own, 60000, 90000)), masksOf(inside(plain, 60000, 90000)));
    });
}

test("a weak-block redo that takes a redrawn map further from its range is undone, in range or not", async () => {
    // every block is weak and the denser the better, so a redo always makes a block denser, and the map harder
    const denser = (text) => [{ name: "Rolls", share: Math.min(0.5, parseRows(text).length / 500) }, { name: "Jacks", share: 0.5 }];
    const run = (request, patternsOf) => generateLearnedMap(input(request), byDensity, model, { patternsOf });
    const plain = await run({ parts: PARTS, target: 9 }, passAll);
    const dan = plain.result.numeric;
    const range = { lo: dan - 0.02, hi: dan + 0.02 };
    const own = await run({ parts: withPart({ stamina: 1 }), range }, denser);
    assert.ok(own.result.numeric >= range.hi, `out of range, above: ${own.result.numeric}`);
    assert.equal(own.retries.blocks, 0, "no redo stays");
});

test("a model that leaves rests of its own: stamina 1 ends them in the part, whatever the map's stamina; there only", async () => {
    const sparse = { ...model, note: { baseline: [-3], classes: [0, 1], iterations: [] } };
    const run = (request) => generateLearnedMap(input(request), flat, sparse, { patternsOf: passAll });
    for (const stamina of [0.5, 0.9]) {
        const plain = rowsOf(await run({ parts: PARTS, stamina }));
        const own = rowsOf(await run({ parts: withPart({ stamina: 1 }), stamina }));
        const rests = [plain, own].map((rows) => longestRest(rows, 30000, 60000));
        assert.ok(rests[0] > 4, `the model's own rests: ${rests[0]} beats`);
        assert.ok(rests[1] <= 2.5, `map at ${stamina}: the longest rest left is ${rests[1]} beats`);
        assert.deepEqual(masksOf(outside(own)), masksOf(outside(plain)));
    }
});

// a net whose rows feed its next ones: once it has gone sparse it stays so, however the push on it eases
const feedback = {
    kind: "feedback",
    caps: {},
    prepare() {
        let heat = 1;
        let last = Infinity;
        return {
            step(i, offset, ctx, rngs) {
                if (i <= last) heat = 1; // a new build
                last = i;
                const u = rngs.fill();
                rngs.size();
                const row = u < 1 / (1 + Math.exp(4 - offset - 8 * heat));
                heat += 0.1 * ((row ? 1 : 0) - heat);
                return row ? singles[i % 4] : 0;
            },
        };
    },
};

test("less stamina or more bursts than the map's: a part stays near its share of the rows, on a net that would go on to nothing", async () => {
    const run = (parts) => generateLearnedMap(input({ parts, stamina: 1, burst: 0.3, target: 15 }), byDensity, model, { patternsOf: passAll, source: feedback });
    const plain = rowsOf(await run(PARTS));
    const before = inside(plain, 30000, 60000).length;
    assert.ok(before > 300, `the part as it is: ${before} rows`);
    for (const [over, share] of [[{ stamina: 0 }, 0.4], [{ stamina: 0.5 }, 0.7], [{ burst: 1 }, 0.7], [{ stamina: 0, burst: 1 }, 0.4]]) {
        const own = rowsOf(await run(withPart(over)));
        const after = inside(own, 30000, 60000).length;
        assert.ok(after >= before * (share - 0.03), `${JSON.stringify(over)}: ${before} → ${after} rows, at least ${share} of them`);
        assert.ok(after < before * (share + 0.25), `and it is still a calmer part: ${before} → ${after}`);
        assert.deepEqual(masksOf(outside(own)), masksOf(outside(plain)));
    }
});

// the rows are spread out, so a calm stretch has none left over from the busy one before it; the shares count from the
// part's start, and a hole there is what the count alone would let through
test("less stamina or more bursts than the map's: the part's calm phrases keep rows, it leaves no hole of its own", async () => {
    const run = (parts) => generateLearnedMap(input({ parts, stamina: 1, burst: 0.3, target: 15 }), byDensity, model, { patternsOf: passAll, source: feedback });
    const plain = rowsOf(await run(PARTS));
    assert.ok(longestRest(plain, 30000, 60000) < 2, `the part as it is: rests of ${longestRest(plain, 30000, 60000)} beats`);
    // (both at once push hardest, from a map at stamina 1: the rests stay short, with few rows between them)
    for (const [over, kept] of [[{ stamina: 0 }, 0.1], [{ burst: 1 }, 0.1], [{ stamina: 0, burst: 1 }, 0.02]]) {
        const own = rowsOf(await run(withPart(over)));
        const rest = longestRest(own, 30000, 60000);
        assert.ok(rest <= 8, `${JSON.stringify(over)}: a rest of ${rest} beats`);
        const worst = thinnest(own, plain, 30000, 60000);
        assert.ok(worst >= kept, `${JSON.stringify(over)}: every 8 beats keep rows: at worst ${worst} of the map's`);
        assert.deepEqual(masksOf(outside(own)), masksOf(outside(plain)));
    }
});

test("fewer bursts than the map's: the part leaves no hole of its own, and its loud phrases still lose rows to its soft ones", async () => {
    // a draw where the push down on the loud phrases sends the net to nothing (47 rows of 343 and a rest of 45 beats, with
    // nothing to bring it back)
    const run = (parts) => generateLearnedMap(input({ parts, stamina: 1, burst: 0.6, target: 15, seed: 9 }), byDensity, model, { patternsOf: passAll, source: feedback });
    const plain = rowsOf(await run(PARTS));
    const own = rowsOf(await run(withPart({ burst: 0 })));
    assert.ok(longestRest(plain, 30000, 60000) < 2, `the part as it is: rests of ${longestRest(plain, 30000, 60000)} beats`);
    const rest = longestRest(own, 30000, 60000);
    assert.ok(rest <= 8, `a rest of ${rest} beats`);
    const worst = thinnest(own, plain, 30000, 60000);
    assert.ok(worst >= 0.1, `every 8 beats keep rows: at worst ${worst} of the map's`);
    const before = inside(plain, 30000, 60000).length;
    const after = inside(own, 30000, 60000).length;
    assert.ok(after >= before * (0.7 - 0.03), `${before} → ${after} rows`);
    const a = phraseNotes(plain, 30000, 60000);
    const b = phraseNotes(own, 30000, 60000);
    assert.ok(b.loud < a.loud * 0.8 && b.soft > a.soft * 0.8, `calmer where the map is busy: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    assert.ok(after < before, `and no denser for it: ${before} → ${after}`);
    assert.deepEqual(masksOf(outside(own)), masksOf(outside(plain)));
});

test("a rest the map itself has stays, however long: less stamina, or bursts moved either way, put no rows in it", async () => {
    // a net with a dark stretch of 18 beats in the part, where only a hard push gets a row out of it
    const DARK = [36000, 42000];
    const dim = {
        ...feedback,
        prepare({ slots }) {
            const inner = feedback.prepare();
            return {
                step(i, offset, ctx, rngs) {
                    return inner.step(i, offset - (slots[i].t >= DARK[0] && slots[i].t < DARK[1] ? 30 : 0), ctx, rngs);
                },
            };
        },
    };
    const run = (parts) => generateLearnedMap(input({ parts, stamina: 1, burst: 0.3, target: 15 }), byDensity, model, { patternsOf: passAll, source: dim });
    const plain = rowsOf(await run(PARTS));
    assert.equal(inside(plain, ...DARK).length, 0, "the map has its rest");
    for (const over of [{ stamina: 0 }, { burst: 1 }, { burst: 0 }]) {
        const own = rowsOf(await run(withPart(over)));
        assert.equal(inside(own, ...DARK).length, 0, JSON.stringify(over));
        assert.ok(longestRest(own, 30000, 60000) < 18 + 7, `${JSON.stringify(over)}: a rest of ${longestRest(own, 30000, 60000)} beats`);
    }
});

test("a rest the map itself has stays while the part is short of its rows: the count from its start waits for the map's next row", async () => {
    // Rows wherever the offset reaches a line, no draw to it: the whole map's stamina 1 and bursts 0.3 leave the knob as
    // every slot's offset, so the map has a row on every slot but a dark stretch whose line is a little over the knob. That
    // stretch opens a loud phrase after a soft one, where stamina 0 took rows the count from the part's start now wants
    // back and takes nothing itself: any push on it at all is a row.
    const DARK = [48000, 50000];
    const lined = (knob) => ({
        kind: "feedback",
        caps: {},
        prepare({ slots }) {
            return { step: (i, offset) => (offset >= knob + (slots[i].t >= DARK[0] && slots[i].t < DARK[1] ? 0.1 : 0) ? singles[i % 4] : 0) };
        },
    });
    const asked = (parts) => input({ parts, stamina: 1, burst: 0.3, target: 15 });
    const { knob } = await generateLearnedMap(asked(PARTS), flat, model, { patternsOf: passAll, source: feedback });
    const run = (parts) => generateLearnedMap(asked(parts), flat, model, { patternsOf: passAll, source: lined(knob) });
    const plain = rowsOf(await run(PARTS));
    assert.equal(inside(plain, ...DARK).length, 0, "the map has its rest");
    assert.ok(inside(plain, 50000, 52000).length > 0, "and it ends");
    const own = rowsOf(await run(withPart({ stamina: 0 })));
    const made = inside(own, 30000, DARK[0]).length;
    const share = made / inside(plain, 30000, DARK[0]).length;
    assert.ok(share > 0.1 && share < 0.45, `less stamina took rows before it, ${made} left, and the count wants them back: ${share}`);
    assert.equal(inside(own, ...DARK).length, 0, "none in the rest");
    assert.ok(inside(own, 50000, 52000).length > 0, "they come back on the map's next rows");
});

// A map whose blocks are weak only once the part is drawn, on the net above. judge: what the pattern finder reads of them
// then. shut(t, stage): no row comes at t, however hard the push, as when the guard's anchor window closes (it moves with rows,
// so with none it stays closed). The stages: 0 the map's search, 1 its weak blocks, 2 the part's draw, 3 that draw's weak blocks.
function polished(parts, { judge = passAll, shut = () => false, stamina = 1 } = {}) {
    let stage = 0;
    const onProgress = ({ phase }) => {
        if (phase === "retry" && (stage === 0 || stage === 2)) stage += 1;
        if (phase === "search" && stage === 1) stage = 2;
    };
    const source = {
        kind: "feedback",
        caps: {},
        prepare({ slots }) {
            const inner = feedback.prepare();
            return {
                step(i, offset, ctx, rngs) {
                    const mask = inner.step(i, offset, ctx, rngs);
                    return shut(slots[i].t, stage) ? 0 : mask;
                },
            };
        },
    };
    const patternsOf = (text) => (stage === 3 ? judge(text) : passAll());
    return generateLearnedMap(input({ parts, stamina, burst: 0.3, target: 15 }), byDensity, model, { patternsOf, onProgress, source });
}
const weakBlock = () => [{ name: "Jacks", share: 1 }];
// every block is weak, and the fewer rows the less so: a redo that leaves rows out wins
const sparser = (text) => {
    const share = 0.5 - parseRows(text).length / 1000;
    return [{ name: "Rolls", share }, { name: "Jacks", share: 1 - share }];
};

test("a polish takes no redo that opens a rest past the cap through the map's rows, though an empty block beats any weak one", async () => {
    const plain = rowsOf(await polished(PARTS));
    assert.ok(longestRest(plain, 30000, 60000) < 2, `the part as it is: rests of ${longestRest(plain, 30000, 60000)} beats`);
    const shut = (t, stage) => stage === 3;
    for (const over of [{ burst: 0 }, { burst: 1 }, { stamina: 0 }]) {
        const draw = await polished(withPart(over), { shut });
        const own = await polished(withPart(over), { judge: weakBlock, shut });
        assert.equal(own.retries.blocks, 0, JSON.stringify(over));
        assert.deepEqual(masksOf(rowsOf(own)), masksOf(rowsOf(draw)), `${JSON.stringify(over)}: the draw stays`);
        assert.ok(longestRest(rowsOf(own), 30000, 60000) <= 8, `${JSON.stringify(over)}: a rest of ${longestRest(rowsOf(own), 30000, 60000)} beats`);
        assert.deepEqual(masksOf(outside(rowsOf(own))), masksOf(outside(plain)));
    }
});

test("more stamina than the map's keeps no share of its rows, and its redos go as they went", async () => {
    const own = await polished(withPart({ stamina: 1 }), { stamina: 0.5, judge: weakBlock, shut: (t, stage) => stage === 3 });
    assert.ok(own.retries.blocks > 0);
});

test("a polish keeps a redo that runs on past the cap only where the map has no rows", async () => {
    const DARK = [36000, 42000]; // 18 beats of the map without rows
    const dark = (t) => t >= DARK[0] && t < DARK[1];
    const before = (beats) => (t, stage) => dark(t) || (stage === 3 && t >= DARK[0] - beats * BEAT && t < DARK[0]);
    const plain = rowsOf(await polished(PARTS, { shut: dark }));
    assert.equal(inside(plain, ...DARK).length, 0, "the map has its rest");
    // left out from 4 beats before it, the map's rows there are short of the cap and that rest is still the map's
    const own = await polished(withPart({ burst: 0 }), { judge: sparser, shut: before(4) });
    assert.ok(own.retries.blocks > 0, "redone");
    assert.equal(inside(rowsOf(own), DARK[0] - 4 * BEAT, DARK[1]).length, 0);
    // left out from 8 beats before it, the last of them are past the cap
    const past = await polished(withPart({ burst: 0 }), { judge: sparser, shut: before(8) });
    assert.ok(inside(rowsOf(past), DARK[0] - 8 * BEAT, DARK[0]).length > 0);
});

test("a rest the draw has past the cap stops no redo that does not add to it", async () => {
    const SHUT = [40000, 46000]; // 18 beats of the map's rows the part's draw gets none on
    const shut = (t, stage) => stage >= 2 && t >= SHUT[0] && t < SHUT[1];
    const draw = rowsOf(await polished(withPart({ burst: 0 }), { shut }));
    assert.equal(inside(draw, ...SHUT).length, 0, "the draw has its rest");
    const own = rowsOf(await polished(withPart({ burst: 0 }), { judge: sparser, shut }));
    const next = [SHUT[1], SHUT[1] + 8 * BEAT];
    assert.notDeepEqual(masksOf(inside(own, ...next)), masksOf(inside(draw, ...next)), "the block it ends in is redone");
    assert.ok(longestRest(own, 30000, 60000) <= longestRest(draw, 30000, 60000), "and it is no longer");
});

test("the blocks counted as redone are those whose rows stayed: not the ones a part's redraw replaced", async () => {
    // the fewer rows the weaker, so the plain map's blocks are redone, and the part's redraw at stamina 1 has none left weak
    const dense = (text) => {
        const share = Math.min(1, parseRows(text).length / 250);
        return [{ name: "Rolls", share }, { name: "Jacks", share: 1 - share }];
    };
    const run = (parts) => generateLearnedMap(input({ parts, target: 7 }), byDensity, model, { patternsOf: dense });
    const plain = await run(PARTS);
    const own = await run(withPart({ stamina: 1 }));
    assert.ok(plain.parts[1].retried > 0, `the plain map redoes blocks of the part: ${plain.parts[1].retried}`);
    assert.equal(own.parts[1].retried, 0);
    assert.equal(own.retries.blocks, plain.retries.blocks - plain.parts[1].retried, "the rest of the map's still count");
});

test("a weak-block redo that lands a redrawn map on the very top of its range is undone: that is outside it", async () => {
    // every reading is 5, in range, so the first run and the second are the same run until the map the redo makes
    const denser = (text) => [{ name: "Rolls", share: Math.min(0.5, parseRows(text).length / 500) }, { name: "Jacks", share: 0.5 }];
    const range = { lo: 4.5, hi: 5.5 };
    const run = (analyze) => generateLearnedMap(input({ parts: withPart({ stamina: 1 }), range }), analyze, model, { patternsOf: denser });
    const redone = await run(flat);
    assert.ok(redone.parts[1].retried > 0, "the redo happens");
    const rowsRedone = rowsOf(redone).length;
    const own = await run(async (text) => ({ ...(await flat()), numeric: parseRows(text).length === rowsRedone ? range.hi : 5 }));
    assert.equal(own.reachable, true, `the map read ${own.result.numeric}`);
    assert.equal(own.parts[1].retried, 0);
    assert.notEqual(rowsOf(own).length, rowsRedone);
});

test("the learned report: plainNumeric only with a part character, the dan the map had without it", async () => {
    const plain = await ENGINES.learned({ parts: PARTS }, byDensity);
    assert.equal("plainNumeric" in plain, false);
    const own = await ENGINES.learned({ parts: withPart({ stamina: 1 }) }, byDensity);
    assert.equal(own.plainNumeric, plain.result.numeric);
    assert.notEqual(own.result.numeric, plain.result.numeric);
    assert.equal(own.reachable, own.result.numeric >= 0, "the answer speaks for the map as it came out");
});

test("a full grid: bursts still show, in the chords of the part's busy phrases", async () => {
    // a table with single notes and jumps: every slot takes a row, so only the rows' sizes are left to change
    const all = Array.from({ length: 16 }, (_, m) => m);
    const jumps = [3, 5, 6, 9, 10, 12];
    const table = {};
    for (const a of all) {
        for (const b of all) {
            table[`${a},${b},1`] = Object.fromEntries(singles.filter((m) => !(m & a) && !(m & b)).map((m) => [m, 10]));
            table[`${a},${b},2`] = Object.fromEntries(jumps.filter((m) => !(m & a)).map((m) => [m, 10]));
        }
    }
    const full = { ...model, note: { baseline: [6], classes: [0, 1], iterations: [] }, size: { baseline: [0, 0, -9, -9], classes: [1, 2, 3, 4], iterations: [] }, pattern: { Jumpstream: table } };
    // the first part: it has no silence, so its soft phrases are its calmest
    const asked = (over) => input({ parts: PARTS.map((p, i) => (i === 0 ? { ...p, ...over } : p)), patterns: [{ name: "Jumpstream", share: 1 }] });
    const chordShare = (out) => {
        const rows = phraseRows(rowsOf(out), 0, 30000);
        const share = (list) => list.filter((r) => r.mask & (r.mask - 1)).length / Math.max(1, list.length);
        return { loud: share(rows.loud), soft: share(rows.soft) };
    };
    const opts = { patternsOf: () => [{ name: "Jumpstream", share: 1 }] };
    // the denser the closer to the dan asked for, which it never reaches: the search ends at the densest
    const short = async (osuText) => ({ kind: "ok", numeric: parseRows(osuText).length / 1000, top3: [{ name: "Rolls", share: 1 }] });
    const plainMap = await generateLearnedMap(asked({}), short, full, opts);
    const ownMap = await generateLearnedMap(asked({ burst: 1 }), short, full, opts);
    const plain = chordShare(plainMap);
    const own = chordShare(ownMap);
    const rowsThere = (out) => inside(rowsOf(out), 0, 30000).length;
    assert.ok(Math.abs(rowsThere(ownMap) - rowsThere(plainMap)) <= rowsThere(plainMap) * 0.02, `a full grid: ${rowsThere(plainMap)} → ${rowsThere(ownMap)} rows`);
    assert.ok(own.loud > plain.loud + 0.05 && own.soft < plain.soft - 0.05, `chords: ${JSON.stringify(plain)} → ${JSON.stringify(own)}`);
});

// a model that takes a push up as readily as a push down; a real one need not (its calm phrases' rows do not all come
// back on the busy ones, and a sparse part can come out denser), so this says what the term is for, not what a song gets
test("on a model that follows the push, bursts move a part's notes more than they take them away", async () => {
    const plain = rowsOf(await ENGINES.learned({ parts: PARTS, target: 9 }, byDensity));
    const own = rowsOf(await ENGINES.learned({ parts: withPart({ burst: 1 }), target: 9 }, byDensity));
    const before = inside(plain, 30000, 60000).length;
    const after = inside(own, 30000, 60000).length;
    assert.ok(Math.abs(after - before) < before * 0.25, `${before} → ${after} rows`);
});

test("a part with its own dan and character: searched in its range with that character; nothing outside moves", async () => {
    const range = { lo: 4.5, hi: 5.5 };
    const parts = (over) => PARTS.map((p, i) => (i === 1 ? { ...p, range, ...over } : p));
    const plain = await ENGINES.learned({ parts: parts({}) });
    const own = await ENGINES.learned({ parts: parts({ stamina: 1 }) });
    assert.deepEqual(masksOf(outside(rowsOf(own))), masksOf(outside(rowsOf(plain))));
    assert.ok(inside(rowsOf(own), 30000, 60000).length > inside(rowsOf(plain), 30000, 60000).length * 1.15);
});

test("a locked part keeps its rows, its own character or not; the rest is free as ever", async () => {
    const base = await ENGINES.learned({ parts: PARTS });
    const rows = inside(rowsOf(base), 30000, 60000);
    const locked = { rows, ranges: [[30000, 60000]], knob: base.knob, planSeed: 7 };
    const run = (over) => generateLearnedMap({ ...input({ parts: withPart(over) }), locked }, flat, model, { patternsOf: passAll });
    const plain = await run({});
    const own = await run({ stamina: 1, burst: 0.9 });
    assert.equal(own.osuText, plain.osuText);
    assert.equal("plainNumeric" in own, false, "nothing was redrawn");
});

test("a map a part's character leaves out of its range is answered as it is, all the way to the card: not clamped, not made again", async () => {
    const generate = (request) => (boost) => generateLearnedMap(input(request), byDensity, model, { patternsOf: passAll, ...(boost ? { boost } : {}) });
    const asked = await generate({ parts: PARTS, target: 9 })();
    const dan = asked.result.numeric;
    const range = { lo: dan - 0.01, hi: dan + 0.01 };
    const plain = await generateToTarget({ generate: generate({ parts: PARTS, range }), range, analyze: byDensity, budgetMs: 1e9 });
    const own = await generateToTarget({ generate: generate({ parts: withPart({ stamina: 1 }), range }), range, analyze: byDensity, budgetMs: 1e9 });
    assert.equal(own.reachable, false, "the card shows it as the closest it got");
    assert.ok(own.result.numeric >= range.hi, `out of the range: ${own.result.numeric}`);
    assert.equal(own.result.numeric, (await byDensity(own.osuText)).numeric, "the dan answered is the dan of the map answered");
    assert.deepEqual(masksOf(outside(rowsOf(own))), masksOf(outside(rowsOf(plain))));
    assert.deepEqual(own.targeting.attempts.map((a) => a.rung), plain.targeting.attempts.map((a) => a.rung), "no rung for what the part did");
});

test("targeting judges the map before its parts' character: no new map for what they did, the same rungs as without them", async () => {
    const answer = (numeric, plainNumeric) => ({ osuText: "", result: { kind: "ok", numeric }, ...(plainNumeric === undefined ? {} : { plainNumeric }) });
    const range = { lo: 5, hi: 6 };
    const runs = [];
    const one = await generateToTarget({ generate: async (boost) => { runs.push(boost); return answer(4.2, 5.5); }, range, budgetMs: 1e9 });
    assert.deepEqual(runs, [null], "the plain map was in range: made once");
    assert.equal(one.result.numeric, 4.2, "and answered as it came out");
    const again = [];
    await generateToTarget({ generate: async (boost) => { again.push(boost?.rung ?? 0); return answer(5.5, boost ? 5.5 : 4.2); }, range, budgetMs: 1e9 });
    assert.ok(again.length > 1 && again[0] === 0, `short without them: the ladder as ever (${again})`);
});

// ---- repeats: a repeated section copies the rows of the first, which is not the part with the character ----

const aba = sectionSong(["A", "B", "A"], { bpm: 160 });
const abaStems = stemsFromTransfer(stemsToTransfer(computeStemsSync(aba.samples, aba.sampleRate)));
const abaEnvelope = onsetEnvelope(aba.samples, aba.sampleRate);
const abaMs = Math.round((aba.samples.length / aba.sampleRate) * 1000);
const SECTION_MS = 8 * (4 * 60000) / 160;
const abaParts = [
    { startMs: 0, endMs: SECTION_MS, kind: "drop" },
    { startMs: SECTION_MS, endMs: 2 * SECTION_MS, kind: "part" },
    { startMs: 2 * SECTION_MS, endMs: abaMs, kind: "drop" },
];
// reads the notes, or the search stops at the first density in range: a map of a few rows
const danSix = async (osuText) => ({ kind: "ok", numeric: parseRows(osuText).length / 50, top3: [{ name: "Jumpstream", share: 1 }] });
const abaRun = (parts, range = { lo: 5.5, hi: 6.5 }) => generateLearnedMap({
    timing: { bpm: 160, offsetMs: 0 }, envelope: abaEnvelope, durationMs: abaMs, stems: abaStems,
    request: { range, patterns: [{ name: "Jumpstream", share: 1 }], mix: "sections", stamina: 0.5, burst: 0.3, seed: 1, repeats: true, parts },
    meta: { title: "repeats", audioFilename: "a.mp3" },
}, danSix, goldenModel, { patternsOf: () => [{ name: "Jumpstream", share: 1 }] });
const notesOf = (rows) => rows.reduce((s, r) => s + (r.mask & 1) + ((r.mask >> 1) & 1) + ((r.mask >> 2) & 1) + ((r.mask >> 3) & 1), 0);

test("repeats: the repeat of a part with a character keeps the map's rows, it does not copy that character", async () => {
    const plain = rowsOf(await abaRun(abaParts));
    const own = rowsOf(await abaRun(abaParts.map((p, i) => (i === 0 ? { ...p, stamina: 0 } : p))));
    assert.ok(notesOf(inside(own, 0, SECTION_MS)) < notesOf(inside(plain, 0, SECTION_MS)) * 0.95, "the part itself changed");
    assert.deepEqual(masksOf(inside(own, SECTION_MS, abaMs + 1)), masksOf(inside(plain, SECTION_MS, abaMs + 1)), "its repeat did not");
});

test("repeats: a part that repeats another still takes its own character, it does not copy the rows made without it", async () => {
    // copying the first section's rows, it would barely move (about 5%: only its varied bars are drawn)
    const plain = rowsOf(await abaRun(abaParts));
    const from = 2 * SECTION_MS;
    const notes = (rows) => notesOf(inside(rows, from, abaMs + 1));
    const rest = rowsOf(await abaRun(abaParts.map((p, i) => (i === 2 ? { ...p, stamina: 0 } : p))));
    const none = rowsOf(await abaRun(abaParts.map((p, i) => (i === 2 ? { ...p, stamina: 1 } : p))));
    assert.ok(notes(rest) < notes(plain) * 0.8, `stamina 0: ${notes(plain)} → ${notes(rest)}`);
    assert.ok(notes(none) > notes(plain) * 1.2, `stamina 1: ${notes(plain)} → ${notes(none)}`);
    assert.deepEqual(masksOf(inside(rest, 0, from)), masksOf(inside(plain, 0, from)));
});

test("repeats: a part its character takes out of the range comes back by its own knob; the parts before it stay", async () => {
    const range = { lo: 4.8, hi: 5.6 };
    const parts = abaParts.map((p, i) => (i === 2 ? { ...p, stamina: 0 } : p));
    const plain = await abaRun(abaParts, range);
    assert.equal(plain.reachable, true);
    const own = await abaRun(parts, range);
    assert.equal(own.reachable, true, `back in range: ${own.result.numeric}`);
    assert.ok(own.result.numeric >= range.lo && own.result.numeric < range.hi);
    assert.deepEqual(masksOf(inside(rowsOf(own), 0, 2 * SECTION_MS)), masksOf(inside(rowsOf(plain), 0, 2 * SECTION_MS)));
});
