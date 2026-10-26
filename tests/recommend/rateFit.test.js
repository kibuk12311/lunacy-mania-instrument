import test from "node:test";
import assert from "node:assert/strict";
import { suggestRate } from "../../src/recommend/rateFit.js";
import { setLang } from "../../src/i18n/i18n.js";

// Our dan rises 0.6 per +0.1x: 1.0x → 12.0, 1.1x → 12.6, 0.9x → 11.4.
function fakeAnalyze(perRate = 6, base = 12) {
    const calls = [];
    const analyze = async (osuText, rate) => {
        calls.push(rate);
        const numeric = Math.round((base + (rate - 1) * perRate) * 10) / 10;
        return { kind: "ok", numeric, label: `n${numeric}`, primary: "jumpstream", halfWidth: 0.3 };
    };
    return { calls, analyze };
}

test("finds the rate that lands the map in the middle of the goal", async () => {
    const { calls, analyze } = fakeAnalyze();
    const r = await suggestRate({ analyze, osuText: "osu", trackerDan: 12.4, center: 13.0 });
    assert.deepEqual(r, {
        ok: true, ours: { label: "n12", numeric: 12, primary: "jumpstream" },
        rate: 1.1, rateLabel: "Gamma mid", reason: null,
    });
    assert.equal(calls[0], 1);
    assert.ok(calls.length <= 7, `binary search, not a scan: ${calls}`);
    assert.ok(calls.every((x) => x === Math.round(x * 100) / 100 && x >= 0.75 && x <= 1.6));
});

test("slows the map down when the goal is below the tracker dan", async () => {
    const { analyze } = fakeAnalyze();
    const r = await suggestRate({ analyze, osuText: "osu", trackerDan: 13, center: 12.7 });
    assert.equal(r.rate, 0.95);
    assert.equal(r.rateLabel, "Gamma low");
    assert.equal(r.reason, null);
});

test("picks the closest grid rate", async () => {
    const { analyze } = fakeAnalyze();
    assert.equal((await suggestRate({ analyze, osuText: "", trackerDan: 12, center: 12.65 })).rate, 1.1);
    assert.equal((await suggestRate({ analyze, osuText: "", trackerDan: 12, center: 12.85 })).rate, 1.15);
    assert.equal((await suggestRate({ analyze, osuText: "", trackerDan: 12, center: 11.35 })).rate, 0.9);
});

test("already in the goal: no rate and a single analysis", async () => {
    const { calls, analyze } = fakeAnalyze();
    const r = await suggestRate({ analyze, osuText: "osu", trackerDan: 13.45, center: 13.51 });
    assert.equal(r.ok, true);
    assert.equal(r.rate, null);
    assert.equal(r.rateLabel, null);
    assert.equal(r.reason, "in-target");
    assert.deepEqual(calls, [1]);
});

test("1.0x wins when one rate step would overshoot the centre by more", async () => {
    // our dan moves 0.5 per 0.05x, as on 260–300 BPM maps; window 13.26–13.76, centre 13.51
    for (const trackerDan of [13.61, 13.36]) {
        const { analyze } = fakeAnalyze(10, 13.7);
        const r = await suggestRate({ analyze, osuText: "osu", trackerDan, center: 13.51 });
        assert.equal(r.rate, null, `${trackerDan}`);
        assert.equal(r.rateLabel, null);
        assert.equal(r.reason, "in-target");
    }
    // a tie keeps 1.0x instead of jumping to the other edge
    const { analyze } = fakeAnalyze(10, 13.7);
    assert.equal((await suggestRate({ analyze, osuText: "osu", trackerDan: 13.26, center: 13.51 })).reason, "in-target");
});

test("an unreachable goal gives the edge rate", async () => {
    const { analyze } = fakeAnalyze();
    const up = await suggestRate({ analyze, osuText: "osu", trackerDan: 10, center: 15 });
    assert.equal(up.rate, 1.6);
    assert.equal(up.reason, "out-of-range");
    assert.equal(up.rateLabel, "Delta low"); // 10 + (15.6 − 12)
    const down = await suggestRate({ analyze, osuText: "osu", trackerDan: 15, center: 10 });
    assert.equal(down.rate, 0.75);
    assert.equal(down.reason, "out-of-range");
    const narrow = await suggestRate({ analyze, osuText: "osu", trackerDan: 12, center: 13.5, max: 1.2 });
    assert.equal(narrow.rate, 1.2);
    assert.equal(narrow.reason, "out-of-range");
});

test("maps our analyzer cannot rate are refused in Russian", async () => {
    const answer = (result) => async () => result;
    assert.deepEqual(await suggestRate({ analyze: answer({ kind: "not-rice", reason: "ln", keys: 4 }), osuText: "", trackerDan: 12, center: 13 }),
        { ok: false, message: "не 4K рис — наш анализатор такие не считает" });
    assert.deepEqual(await suggestRate({ analyze: answer({ kind: "too-short" }), osuText: "", trackerDan: 12, center: 13 }),
        { ok: false, message: "карта слишком короткая" });
    assert.deepEqual(await suggestRate({ analyze: answer({ kind: "error", message: "сломалось" }), osuText: "", trackerDan: 12, center: 13 }),
        { ok: false, message: "сломалось" });
    const thrown = await suggestRate({ analyze: async () => { throw new Error("воркер упал"); }, osuText: "", trackerDan: 12, center: 13 });
    assert.deepEqual(thrown, { ok: false, message: "воркер упал" });
});

test("a failure at another rate keeps our dan but drops the rate", async () => {
    const analyze = async (text, rate) => (rate === 1
        ? { kind: "ok", numeric: 12, label: "Beta mid", primary: "stream" }
        : { kind: "error", message: "x" });
    const r = await suggestRate({ analyze, osuText: "", trackerDan: 12, center: 13 });
    assert.deepEqual(r, { ok: true, ours: { label: "Beta mid", numeric: 12, primary: "stream" }, rate: null, rateLabel: null, reason: null });
});

test("in English maps our analyzer cannot rate are refused in English", async () => {
    const answer = (result) => async () => result;
    const ask = (result) => suggestRate({ analyze: answer(result), osuText: "", trackerDan: 12, center: 13 });
    setLang("en");
    try {
        assert.deepEqual(await ask({ kind: "not-rice", reason: "ln", keys: 4 }), { ok: false, message: "not 4K rice — our analyzer doesn't rate these" });
        assert.deepEqual(await ask({ kind: "too-short" }), { ok: false, message: "this map is too short" });
        assert.deepEqual(await ask({ kind: "error" }), { ok: false, message: "our analyzer couldn't rate this map" });
        assert.deepEqual(await ask({ kind: "error", message: "worker crashed" }), { ok: false, message: "worker crashed" });
    } finally {
        setLang("ru");
    }
    assert.deepEqual(await ask({ kind: "error" }), { ok: false, message: "наш анализатор не смог посчитать карту" });
});
