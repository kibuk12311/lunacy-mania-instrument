import test from "node:test";
import assert from "node:assert/strict";
import {
    corpusWeights, sourceWeight, packKeyOf, creatorKeyOf, creatorIdsFromMeta, SOURCE_WEIGHT, WEIGHT_CAPS,
} from "../../src/corpus/weights.js";

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
function shares(items, w, key) {
    const total = sum([...w]);
    const by = new Map();
    items.forEach((it, i) => { const k = key(it); if (k != null) by.set(k, (by.get(k) ?? 0) + w[i]); });
    return new Map([...by].map(([k, v]) => [k, v / total]));
}

// A synthetic index: 300 osu! songs by 60 creators (one prolific), one big Etterna dump and 20 small packs.
function syntheticIndex() {
    const items = [];
    for (let s = 0; s < 300; s++) {
        const diffs = 1 + (s % 4);
        for (let d = 0; d < diffs; d++) {
            items.push({ group: `osu${s}`, source: s % 2 ? "sets" : "hf", ranked: s % 2 === 0, pack: null,
                creator: s < 60 ? "prolific" : `mapper${s % 59}`, bin: `dan:${String(3 + (s % 14)).padStart(2, "0")}` });
        }
    }
    for (let s = 0; s < 400; s++) items.push({ group: `dump${s}`, source: "etterna", pack: "etterna:valedumps", creator: null, bin: "dan:10" });
    for (let p = 0; p < 20; p++) {
        for (let s = 0; s < 10; s++) items.push({ group: `pk${p}-${s}`, source: "etterna", pack: `etterna:${p}`, creator: null, bin: `dan:${String(4 + p % 10).padStart(2, "0")}` });
    }
    return items;
}

test("source weights: Etterna and Malody converts count less than osu! ranked/loved", () => {
    assert.equal(sourceWeight({ source: "hf", ranked: true }), SOURCE_WEIGHT.ranked);
    assert.equal(sourceWeight({ source: "ranked", ranked: true }), SOURCE_WEIGHT.ranked);
    assert.equal(sourceWeight({ source: "sets", ranked: true }), SOURCE_WEIGHT.ranked);
    for (const src of ["etterna", "malody"]) {
        assert.ok(sourceWeight({ source: src }) < sourceWeight({ source: "hf", ranked: true }), src);
        assert.ok(sourceWeight({ source: src }) < sourceWeight({ source: "sets" }), src);
    }
    assert.equal(sourceWeight({ source: "malody" }), sourceWeight({ source: "etterna" }));
    assert.equal(sourceWeight({ source: "unheard-of" }), 1);
    assert.equal(sourceWeight({ source: "etterna" }, { etterna: 0.2 }), 0.2);
});

test("one song group with many diffs weighs 1/sqrt(diffs) per diff", () => {
    const items = [
        ...Array.from({ length: 4 }, () => ({ group: "a", source: "hf", ranked: true })),
        { group: "b", source: "hf", ranked: true },
    ];
    const { weights } = corpusWeights(items);
    // 4 diffs × 1/2 each = 2 for song a, 1 for song b; normalised to a mean of 1
    const total = sum([...weights]);
    assert.ok(Math.abs(total - items.length) < 1e-9);
    assert.ok(Math.abs(weights[0] / weights[4] - 0.5) < 1e-9);
});

test("pack and creator caps hold on a synthetic index, and the dan-bin cap too", () => {
    const items = syntheticIndex();
    const res = corpusWeights(items);
    assert.equal(res.capsHeld, true);
    const w = res.weights;
    const tol = 1 + 2e-3;
    for (const [k, s] of shares(items, w, (it) => it.pack)) assert.ok(s <= WEIGHT_CAPS.pack * tol, `pack ${k} share ${s}`);
    for (const [k, s] of shares(items, w, (it) => it.creator)) assert.ok(s <= WEIGHT_CAPS.creator * tol, `creator ${k} share ${s}`);
    const bins = shares(items, w, (it) => it.bin);
    const sorted = [...bins.values()].sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    for (const [k, s] of bins) assert.ok(s <= WEIGHT_CAPS.bin * median * 1.01, `bin ${k} share ${s} vs median ${median}`);
    // the dump was cut hard, small packs and ordinary creators were not touched relative to each other
    const dumpShare = shares(items, w, (it) => it.pack).get("etterna:valedumps");
    assert.ok(dumpShare <= WEIGHT_CAPS.pack * tol);
    assert.ok(Math.abs(sum([...w]) - items.length) < 1e-6, "mean weight 1");
    assert.ok([...w].every((x) => Number.isFinite(x) && x > 0));
    assert.ok(res.stats.maxPackShare <= WEIGHT_CAPS.pack * tol);
    assert.ok(res.stats.maxCreatorShare <= WEIGHT_CAPS.creator * tol);
});

test("caps that cannot hold (every chart in 3 packs) give equal pack shares and say so", () => {
    const items = [];
    for (let p = 0; p < 3; p++) for (let s = 0; s < 10 * (p + 1); s++) items.push({ group: `${p}-${s}`, source: "etterna", pack: `p${p}` });
    const res = corpusWeights(items);
    assert.equal(res.capsHeld, false);
    for (const s of shares(items, res.weights, (it) => it.pack).values()) assert.ok(Math.abs(s - 1 / 3) < 1e-3);
    assert.ok([...res.weights].every((x) => Number.isFinite(x) && x > 0));
});

test("weights are deterministic and an empty index is fine", () => {
    const items = syntheticIndex();
    assert.deepEqual([...corpusWeights(items).weights], [...corpusWeights(items.map((x) => ({ ...x }))).weights]);
    assert.equal(corpusWeights([]).weights.length, 0);
});

test("pack keys: Etterna pack id, Malody zip, Drive / Dan Reform pack name, pack-like osu! sets; none for a plain set", () => {
    assert.equal(packKeyOf({ source: "etterna", folder: "3281 +i m a z i n e x o+" }), "etterna:3281");
    assert.equal(packKeyOf({ source: "etterna", folder: "x", packId: 77 }), "etterna:77");
    assert.equal(packKeyOf({ source: "malody", folder: "mal-10-11-1 [3365] 0" }), "malody:mal-10-11-1");
    assert.equal(packKeyOf({ source: "packs", folder: "dan-reform - 1st Pack - v1" }), "packs:dan-reform");
    assert.equal(packKeyOf({ source: "packs", folder: "beajek-eta-stamina - Various Artists - Beajek's Eta Stamina Practice Pack" }), "packs:beajek-eta-stamina");
    assert.equal(packKeyOf({ source: "sets", folder: "123", packLike: true, beatmapSetId: 123 }), "set:123");
    assert.equal(packKeyOf({ source: "songs", folder: "55 Various Artists - X Pack", packLike: true, beatmapSetId: null }), "set:55 Various Artists - X Pack");
    assert.equal(packKeyOf({ source: "hf", folder: "1000065", packLike: false }), null);
    assert.equal(packKeyOf({ source: "ranked", folder: "ranked-loved - 1 A - B" }), null);
});

test("creator keys: lower-case trimmed name, merged by osu! user id; converts have none", () => {
    const ids = creatorIdsFromMeta([{ creator: "Evening", creatorId: 7 }, { creator: "evening_old", creatorId: 7 }, { creator: "Other", creatorId: 9 }]);
    assert.equal(creatorKeyOf({ source: "hf", creator: "  Evening " }, ids), "u:7");
    assert.equal(creatorKeyOf({ source: "sets", creator: "Evening_Old" }, ids), "u:7");
    assert.equal(creatorKeyOf({ source: "sets", creator: "Someone New" }, ids), "n:someone new");
    assert.equal(creatorKeyOf({ source: "sets", creator: "" }, ids), null);
    // the chart's own creator id wins over the name (a user renamed since: one key for both names)
    assert.equal(creatorKeyOf({ source: "hf", creator: "New Name", creatorId: 7 }, ids), "u:7");
    assert.equal(creatorKeyOf({ source: "hf", creator: "Someone New", creatorId: 99 }, ids), "u:99");
    assert.equal(creatorKeyOf({ source: "hf", creator: "Someone New", creatorId: null }, ids), "n:someone new");
    // Etterna / Malody converts carry difficulty names or pack authors in the creator field
    assert.equal(creatorKeyOf({ source: "etterna", creator: "ANOTHER" }, ids), null);
    assert.equal(creatorKeyOf({ source: "malody", creator: "4k advanced Lv.17" }, ids), null);
});

test("a single creator or a single map never drives the weights to 0 or NaN", () => {
    for (const items of [
        [{ group: "a", source: "sets", creator: "n:m", pack: "p", bin: "dan:04" }],
        Array.from({ length: 5 }, (_, i) => ({ group: `g${i}`, source: "sets", creator: "n:m", bin: `dan:0${i}` })),
    ]) {
        const res = corpusWeights(items);
        assert.ok([...res.weights].every((x) => Number.isFinite(x) && x > 0), JSON.stringify([...res.weights]));
        assert.ok(Math.abs(sum([...res.weights]) - items.length) < 1e-9);
        assert.ok(res.rounds < 10, `stopped early (${res.rounds} rounds)`);
    }
});
