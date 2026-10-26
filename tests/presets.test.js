// Saved rate presets: what is kept, how values are clamped, duplicates merged, the limit and the chip label.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizePresets, presetLabel, samePreset, MAX_PRESETS } from "../src/rate/presets.js";
import { setLang } from "../src/i18n/i18n.js";

const P = (over = {}) => ({ rate: 1.2, pitch: false, od: null, hp: null, mirror: false, noLn: false, ...over });

test("a preset keeps exactly its six fields; missing ones get their defaults", () => {
    assert.deepEqual(normalizePresets([{ rate: 1.3, pitch: true, od: 8, hp: 7, mirror: true, noLn: true, extra: "x" }]),
        [{ rate: 1.3, pitch: true, od: 8, hp: 7, mirror: true, noLn: true }]);
    assert.deepEqual(normalizePresets([{ rate: 1.1 }]), [P({ rate: 1.1 })]);
    // empty OD/HP fields mean "the map's own"
    assert.deepEqual(normalizePresets([{ rate: 1.1, od: "", hp: undefined }]), [P({ rate: 1.1 })]);
});

test("bad entries are dropped; values are clamped and rounded", () => {
    assert.deepEqual(normalizePresets([null, 5, "x", [], { rate: "abc" }, { pitch: true }, { rate: NaN }]), []);
    assert.deepEqual(normalizePresets([{ rate: 3, od: 12, hp: -1 }]), [P({ rate: 2, od: 10, hp: 0 })]);
    assert.deepEqual(normalizePresets([{ rate: 0.1 }]), [P({ rate: 0.5 })]);
    assert.deepEqual(normalizePresets([{ rate: 1.234, od: 8.26, hp: "7.5" }]), [P({ rate: 1.23, od: 8.3, hp: 7.5 })]);
    // only true turns a switch on
    assert.deepEqual(normalizePresets([{ rate: 1.2, pitch: "yes", mirror: 1, noLn: "true" }]), [P()]);
    // OD that is not a number keeps the map's own
    assert.deepEqual(normalizePresets([{ rate: 1.2, od: "x" }]), [P()]);
});

test("not a list → empty", () => {
    for (const bad of [null, undefined, {}, "x", 3]) assert.deepEqual(normalizePresets(bad), []);
});

test("the same preset twice is kept once, the first one", () => {
    const list = normalizePresets([P({ rate: 1.2 }), P({ rate: 1.3 }), P({ rate: 1.2000001 }), P({ rate: 1.2, mirror: true })]);
    assert.deepEqual(list, [P({ rate: 1.2 }), P({ rate: 1.3 }), P({ rate: 1.2, mirror: true })]);
    assert.ok(samePreset(P({ rate: 1.2 }), { rate: 1.2 }));
    assert.ok(!samePreset(P({ od: 8 }), P()));
    assert.ok(!samePreset(P(), null));
});

test("at most 12, the first ones", () => {
    assert.equal(MAX_PRESETS, 12);
    const many = Array.from({ length: 20 }, (_, i) => P({ rate: 1 + i * 0.05 }));
    const list = normalizePresets(many);
    assert.equal(list.length, 12);
    assert.equal(list[0].rate, 1);
    assert.equal(list[11].rate, 1.55);
});

test("chip label in Russian and English", () => {
    try {
        setLang("ru");
        assert.equal(presetLabel(P({ rate: 1.2, pitch: true })), "×1.2 · NC");
        assert.equal(presetLabel(P({ rate: 1.3, od: 8, mirror: true })), "×1.3 · OD 8 · Зеркало");
        assert.equal(presetLabel(P({ rate: 1.25, pitch: true, od: 8.5, hp: 7, mirror: true, noLn: true })), "×1.25 · NC · OD 8.5 · HP 7 · Зеркало · Без LN");
        setLang("en");
        assert.equal(presetLabel(P({ rate: 1.3, od: 8, mirror: true })), "×1.3 · OD 8 · Mirror");
        assert.equal(presetLabel(P({ rate: 1, noLn: true })), "×1 · No LN");
    } finally {
        setLang("ru");
    }
});
