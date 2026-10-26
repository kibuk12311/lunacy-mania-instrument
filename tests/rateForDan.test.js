import test from "node:test";
import assert from "node:assert/strict";
import { rateForDan } from "../src/rate/rateForDan.js";

const round1 = (x) => Math.round(x * 10) / 10;
const ok = (numeric) => ({ kind: "ok", numeric, label: `L${numeric}`, primary: "Jumpstream" });

// numeric = 12 + 3·(rate − 1) to 0.1; `table` overrides single rates (a number, or a result object)
function fakeAnalyzer(table = {}) {
    const calls = [];
    const analyze = async (osuText, rate) => {
        calls.push(rate);
        assert.equal(osuText, "chart");
        const forced = table[rate.toFixed(2)];
        if (forced !== undefined) return typeof forced === "number" ? ok(forced) : forced;
        return ok(round1(12 + 3 * (rate - 1)));
    };
    return { analyze, calls };
}

test("step 0.01: the target is hit within the tolerance in at most 10 tries", async () => {
    const { analyze, calls } = fakeAnalyzer();
    const r = await rateForDan({ analyze, osuText: "chart", target: 13, step: 0.01 });
    assert.equal(r.ok, true);
    assert.equal(r.reason, "hit");
    assert.equal(r.reached, true);
    assert.ok(Math.abs(r.numeric - 13) <= 0.05, String(r.numeric));
    assert.ok(r.tries.length <= 10 && r.tries.length === calls.length, String(r.tries.length));
    assert.equal(r.label, `L${r.numeric}`);
    assert.equal(r.primary, "Jumpstream");
    assert.equal(r.result.numeric, r.numeric);
    assert.equal(r.base.numeric, 12);
    assert.equal(r.tries[0].rate, 1);
    // every rate tried sits on the 0.01 grid
    assert.ok(r.tries.every((x) => Math.abs(x.rate * 100 - Math.round(x.rate * 100)) < 1e-9));
});

test("step 0.05 on 0.8–1.45: the nearest grid rate is picked, in at most 6 tries", async () => {
    const { analyze } = fakeAnalyzer();
    const r = await rateForDan({ analyze, osuText: "chart", target: 12.9, step: 0.05, min: 0.8, max: 1.45 });
    assert.equal(r.rate, 1.3);
    assert.equal(r.numeric, 12.9);
    assert.equal(r.reason, "hit");
    assert.ok(r.tries.length <= 6, String(r.tries.length));
    const down = await rateForDan({ analyze, osuText: "chart", target: 11.4, step: 0.05, min: 0.8, max: 1.45 });
    assert.equal(down.rate, 0.8);
    assert.equal(down.reason, "hit");
    assert.ok(down.tries.length <= 6);
});

test("a target already met at 1.0 takes one try", async () => {
    const { analyze, calls } = fakeAnalyzer();
    const r = await rateForDan({ analyze, osuText: "chart", target: 12.03 });
    assert.deepEqual(calls, [1]);
    assert.equal(r.rate, 1);
    assert.equal(r.reason, "hit");
    assert.deepEqual(r.tries, [{ rate: 1, numeric: 12 }]);
});

test("out of reach: the end of the range, not reached", async () => {
    const { analyze } = fakeAnalyzer();
    const up = await rateForDan({ analyze, osuText: "chart", target: 20 });
    assert.equal(up.ok, true);
    assert.equal(up.reason, "above-range");
    assert.equal(up.rate, 2);
    assert.equal(up.numeric, 15);
    assert.equal(up.reached, false);
    assert.equal(up.tries.length, 2);
    const down = await rateForDan({ analyze, osuText: "chart", target: 5 });
    assert.equal(down.reason, "below-range");
    assert.equal(down.rate, 0.5);
    assert.equal(down.reached, false);
    const narrow = await rateForDan({ analyze, osuText: "chart", target: 20, step: 0.05, min: 0.8, max: 1.45 });
    assert.equal(narrow.rate, 1.45);
    assert.equal(narrow.reason, "above-range");
});

test("a failing far end moves one step inward, at most twice", async () => {
    const error = { kind: "error", message: "x", transient: true };
    const { analyze, calls } = fakeAnalyzer({ "2.00": error, "1.95": error });
    const r = await rateForDan({ analyze, osuText: "chart", target: 20 });
    assert.deepEqual(calls, [1, 2, 1.95, 1.9]);
    assert.equal(r.rate, 1.9);
    assert.equal(r.reason, "above-range");
    assert.deepEqual(r.tries.slice(1, 3), [{ rate: 2, numeric: null }, { rate: 1.95, numeric: null }]);

    const worse = fakeAnalyzer({ "2.00": error, "1.95": error, "1.90": error });
    const none = await rateForDan({ analyze: worse.analyze, osuText: "chart", target: 20 });
    assert.deepEqual(worse.calls, [1, 2, 1.95, 1.9]);
    assert.equal(none.ok, true);
    assert.equal(none.rate, 1);
    assert.equal(none.reached, false);
});

test("a base result that is not a dan fails the search", async () => {
    const notRice = { kind: "not-rice", reason: "ln" };
    const { analyze, calls } = fakeAnalyzer({ "1.00": notRice });
    const r = await rateForDan({ analyze, osuText: "chart", target: 13 });
    assert.deepEqual(r, { ok: false, reason: "base-failed", result: notRice });
    assert.deepEqual(calls, [1]);
    const thrown = await rateForDan({ analyze: async () => { throw new Error("boom"); }, osuText: "chart", target: 13 });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.reason, "base-failed");
    assert.equal(thrown.result.kind, "error");
});

test("a rate whose analysis fails inside the range is skipped and never picked", async () => {
    const clean = await rateForDan({ analyze: fakeAnalyzer().analyze, osuText: "chart", target: 12.9, step: 0.05, min: 0.8, max: 1.45 });
    const firstInside = clean.tries[2].rate;
    const { analyze } = fakeAnalyzer({ [firstInside.toFixed(2)]: { kind: "error", message: "x" } });
    const r = await rateForDan({ analyze, osuText: "chart", target: 12.9, step: 0.05, min: 0.8, max: 1.45 });
    assert.equal(r.rate, 1.3);
    assert.notEqual(r.rate, firstInside);
    assert.deepEqual(r.tries[2], { rate: firstInside, numeric: null });
});

test("a jittery (not monotonic) dan still gives the best rate tried", async () => {
    const { analyze } = fakeAnalyzer({ "1.25": 12.88, "1.35": 13.3, "1.30": 13.2 });
    const r = await rateForDan({ analyze, osuText: "chart", target: 12.9, step: 0.05, min: 0.8, max: 1.45, tolerance: 0.01 });
    assert.equal(r.reason, "closest");
    assert.equal(r.reached, true);
    assert.equal(r.rate, 1.25);
    assert.equal(r.numeric, 12.88);
});

test("a tie goes to the rate closer to 1.0", async () => {
    const { analyze } = fakeAnalyzer({ "1.20": 12.5, "1.40": 13.5 });
    const r = await rateForDan({ analyze, osuText: "chart", target: 13, step: 0.2, min: 0.6, max: 1.4 });
    assert.deepEqual(r.tries.map((x) => x.rate), [1, 1.4, 1.2]);
    assert.equal(r.rate, 1.2);
    assert.equal(r.reason, "closest");
});

test("cancelling stops before the next analysis", async () => {
    const { analyze, calls } = fakeAnalyzer();
    const r = await rateForDan({ analyze, osuText: "chart", target: 13, step: 0.01, isCancelled: () => calls.length >= 2 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "cancelled");
    assert.equal(calls.length, 2);
    const before = await rateForDan({ analyze, osuText: "chart", target: 13, isCancelled: () => true });
    assert.deepEqual(before, { ok: false, reason: "cancelled", result: null });
});

test("onTry is told about every try, in order", async () => {
    const seen = [];
    const error = { kind: "error", message: "x" };
    const { analyze } = fakeAnalyzer({ "2.00": error });
    const r = await rateForDan({ analyze, osuText: "chart", target: 13, step: 0.01, onTry: (x) => seen.push(x) });
    assert.equal(seen.length, r.tries.length);
    assert.deepEqual(seen, r.tries);
    assert.equal(seen[1].numeric, null);
});

test("maxTries caps the number of analyses", async () => {
    const { analyze, calls } = fakeAnalyzer();
    const r = await rateForDan({ analyze, osuText: "chart", target: 13.01, step: 0.01, tolerance: 0.001, maxTries: 4 });
    assert.equal(calls.length, 4);
    assert.equal(r.reason, "closest");
    assert.ok(Math.abs(r.numeric - 13.01) <= 0.5);
});
