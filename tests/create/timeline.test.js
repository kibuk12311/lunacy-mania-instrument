// The song timeline and part editor: split at the cursor, merge with the next, a part's own dan («любой» step = the
// whole level), which badge a part shows, and the editor on the fake DOM (select, seek, edits, the lock toggle).
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { setLang } from "../../src/i18n/i18n.js";
import {
    splitPart, mergeParts, partRange, badgeText, partAt, energyFallback, toPartSpecs, createTimeline, MAX_PARTS, repeatGroups,
} from "../../app/renderer/timeline.js";

const PARTS = [
    { startMs: 0, endMs: 30000, kind: "intro" },
    { startMs: 30000, endMs: 60000, kind: "drop", range: { lo: 13.5, hi: 14.5 } },
    { startMs: 60000, endMs: 90000, kind: "break", empty: true },
];

test("split at the cursor: two halves with the same settings, both marked edited; never at an edge", () => {
    const split = splitPart(PARTS, 1, 45000);
    assert.deepEqual(split.map((p) => [p.startMs, p.endMs, p.kind]), [[0, 30000, "intro"], [30000, 45000, "drop"], [45000, 60000, "drop"], [60000, 90000, "break"]]);
    assert.deepEqual(split[1].range, { lo: 13.5, hi: 14.5 });
    assert.deepEqual(split[2].range, { lo: 13.5, hi: 14.5 });
    assert.ok(split[1].edited && split[2].edited);
    assert.ok(!split[0].edited);
    assert.equal(splitPart(PARTS, 1, 30200, 1000), null, "too close to the start");
    assert.equal(splitPart(PARTS, 1, 59900, 1000), null, "too close to the end");
    assert.equal(splitPart(PARTS, 1, 70000), null, "the cursor is not in this part");
    const full = Array.from({ length: MAX_PARTS }, (_, i) => ({ startMs: i * 10000, endMs: (i + 1) * 10000, kind: "part" }));
    assert.equal(splitPart(full, 0, 5000), null, `at most ${MAX_PARTS} parts`);
    assert.equal(PARTS.length, 3, "the list given is not changed");
});

test("merge with the next: the first part's settings over both, edited; the last part has no next", () => {
    const merged = mergeParts(PARTS, 0);
    assert.deepEqual(merged.map((p) => [p.startMs, p.endMs, p.kind]), [[0, 60000, "intro"], [60000, 90000, "break"]]);
    assert.equal(merged[0].range, undefined);
    assert.ok(merged[0].edited);
    assert.equal(mergeParts(PARTS, 2), null);
});

test("a part's own dan: a step is its band, «любой» is the whole level [level − 0.5, level + 0.5)", () => {
    assert.deepEqual(partRange(13, "any"), { lo: 12.5, hi: 13.5 });
    assert.deepEqual(partRange(13, "low"), { lo: 12.5, hi: 12.7 });
    const mid = partRange(12, "mid");
    assert.ok(Math.abs(mid.lo - 11.9) < 1e-9 && Math.abs(mid.hi - 12.1) < 1e-9);
});

test("the badge: ✓ in range, ≈ … (asked for …) out of it, plain ≈ without an own range, nothing for empty or short parts", () => {
    setLang("en");
    try {
        const dan = { numeric: 13.9, label: "Gamma high", top3: [] };
        assert.deepEqual(badgeText({ dan, wanted: { lo: 13.5, hi: 14.5 }, inRange: true }), { text: "✓ Gamma high", ok: true });
        assert.deepEqual(badgeText({ dan, wanted: { lo: 13.5, hi: 14.5 }, inRange: false }), { text: "≈ Gamma high (asked for Delta low — Delta high)", ok: false });
        assert.deepEqual(badgeText({ dan, wanted: null, inRange: null }), { text: "≈ Gamma high", ok: null });
        assert.equal(badgeText({ dan: null, wanted: null }), null);
        assert.equal(badgeText({ dan, empty: true }), null);
        assert.equal(badgeText(null), null);
    } finally {
        setLang("ru");
    }
});

test("helpers: the part under a time, an energy curve from the envelope, the specs sent to the generator", () => {
    assert.equal(partAt(PARTS, 0), 0);
    assert.equal(partAt(PARTS, 45000), 1);
    assert.equal(partAt(PARTS, 89999), 2);
    assert.equal(partAt(PARTS, 95000), 2, "past the end: the last part");
    const energy = Float32Array.from({ length: 1000 }, (_, i) => (i >= 500 ? 1 : 0.25));
    const curve = energyFallback({ energy, hopSec: 0.01 }, 10000, 10);
    assert.equal(curve.length, 10);
    assert.ok(curve.every((v) => v >= 0 && v <= 1));
    assert.ok(curve[9] > curve[0]);
    const specs = toPartSpecs([{ ...PARTS[1], edited: true, level: 14, step: "any", patterns: [{ name: "Jumpstream", share: 2 }, { name: "Jack", share: 2 }] }, PARTS[2]]);
    assert.deepEqual(specs, [
        { startMs: 30000, endMs: 60000, kind: "drop", range: { lo: 13.5, hi: 14.5 }, patterns: [{ name: "Jumpstream", share: 0.5 }, { name: "Jack", share: 0.5 }] },
        { startMs: 60000, endMs: 90000, kind: "break", empty: true },
    ]);
});

function setup() {
    const dom = fakeDom({});
    const seeks = [];
    const changes = [];
    const locks = [];
    let cursor = 45000;
    const tl = createTimeline({
        canvas: dom.$("timeline"), editor: dom.$("part-editor"),
        getCursor: () => cursor, onSeek: (ms) => seeks.push(ms), onChange: (parts) => changes.push(parts),
        onReset: () => changes.push("reset"), onToggleLock: (i) => locks.push(i),
    });
    tl.setSong({ durationMs: 90000, energy: new Float32Array(432).fill(0.5) });
    tl.setParts(PARTS.map((p) => ({ ...p })), { detected: true });
    return { ...dom, tl, seeks, changes, locks, setCursor: (ms) => { cursor = ms; } };
}

const all = (n) => [n, ...n.children.flatMap(all)];
const find = (root, pred) => all(root).find(pred);

test("the editor: a click picks the part and seeks; kind, no notes and the dan edit it and mark it", async () => {
    setLang("en");
    try {
        const { $, tl, seeks, changes } = setup();
        const editor = $("part-editor");
        assert.ok(textOf(editor).includes("3 parts found · 1 drop"), textOf(editor));
        assert.ok(textOf(editor).includes("Click a part to give it its own pattern and dan"));

        const width = tl.width;
        await fire($("timeline"), "pointerdown", { offsetX: width * 0.5, button: 0 });
        await fire($("timeline"), "pointerup", { offsetX: width * 0.5 });
        assert.equal(tl.selected, 1);
        assert.equal(Math.round(seeks[0]), 45000);

        const kind = find(editor, (n) => n.dataset?.role === "kind");
        assert.equal(kind.value, "drop");
        kind.value = "build";
        await fire(kind, "change");
        assert.equal(tl.parts[1].kind, "build");
        assert.equal(tl.parts[1].edited, true);
        assert.equal(tl.edited, true);
        assert.equal(changes.length, 1);

        const level = find(editor, (n) => n.dataset?.role === "level");
        const step = find(editor, (n) => n.dataset?.role === "step");
        assert.equal(level.value, "", "no own dan yet");
        level.value = "15";
        await fire(level, "change");
        assert.deepEqual(tl.parts[1].range, { lo: 14.5, hi: 15.5 }, "«any» step first");
        const stepNow = find(editor, (n) => n.dataset?.role === "step");
        stepNow.value = "high";
        await fire(stepNow, "change");
        assert.ok(Math.abs(tl.parts[1].range.lo - 15.3) < 1e-9);
        assert.ok(step);
        const levelNow = find(editor, (n) => n.dataset?.role === "level");
        levelNow.value = "";
        await fire(levelNow, "change");
        assert.equal(tl.parts[1].range, undefined, "back to the whole map's dan");

        const empty = find(editor, (n) => n.dataset?.role === "empty");
        empty.checked = true;
        await fire(empty, "change");
        assert.equal(tl.parts[1].empty, true);

        const chip = find(editor, (n) => n.dataset?.pattern === "Jack");
        await fire(chip);
        assert.deepEqual(tl.parts[1].patterns.map((p) => p.name), ["Jack"]);
        await fire(find(editor, (n) => n.dataset?.pattern === "Jack"));
        assert.equal(tl.parts[1].patterns, undefined, "no chip left: the whole map's patterns");
    } finally {
        setLang("ru");
    }
});

test("the editor: split at the cursor, merge, reset; the lock toggle only once there is a result", async () => {
    setLang("en");
    try {
        const { $, tl, changes, locks } = setup();
        tl.select(1);
        const editor = $("part-editor");
        const button = (text) => find(editor, (n) => n.tagName === "BUTTON" && n.textContent === text);
        assert.equal(button("Lock"), undefined);
        await fire(button("Split at the cursor"));
        assert.equal(tl.parts.length, 4);
        assert.equal(tl.parts[2].startMs, 45000);
        await fire(button("Merge with the next"));
        assert.equal(tl.parts.length, 3);
        await fire(button("Reset parts"));
        assert.equal(changes.at(-1), "reset");

        tl.setResult({ reports: [{ index: 0, startMs: 0, endMs: 30000, dan: { label: "Gamma low", numeric: 12.6 }, wanted: null, inRange: null }], locks: new Set([1]), canLock: true });
        tl.select(1);
        assert.ok(button("Locked"), "part 1 is locked");
        await fire(button("Locked"));
        assert.deepEqual(locks, [1]);
        tl.select(0);
        assert.ok(button("Lock"));
    } finally {
        setLang("ru");
    }
});

test("a badge never runs past its own part into the next one's", () => {
    setLang("en");
    try {
        const { $, tl } = setup();
        const dan = { label: "Gamma mid/high", numeric: 13.2 };
        // 0–8 s of a 90 s song: about 38 px of a 432 px timeline, less than "≈ Gamma mid/high" takes
        tl.setResult({ reports: [
            { index: 0, startMs: 0, endMs: 8000, dan, wanted: { lo: 13.5, hi: 14.5 }, inRange: false },
            { index: 1, startMs: 8000, endMs: 90000, dan, wanted: null, inRange: null },
        ] });
        const ctx = $("timeline").getContext("2d");
        const badges = ctx.calls.filter((c) => c[0] === "fillText" && String(c[1]).startsWith("≈"));
        assert.equal(badges.length, 2);
        const room = (432 * 8000) / 90000;
        const [, , x, , maxWidth] = badges.find((c) => c[2] < 10);
        assert.ok(Number.isFinite(maxWidth) && x + maxWidth <= room, `the first badge fits in ${room} px: x ${x}, max ${maxWidth}`);
    } finally {
        setLang("ru");
    }
});

test("detected parts replace the old ones only while nothing was edited", () => {
    const { tl } = setup();
    tl.select(0);
    assert.equal(tl.edited, false);
    tl.setParts([{ startMs: 0, endMs: 90000, kind: "part" }], { detected: true });
    assert.equal(tl.parts.length, 1);
    assert.equal(tl.selected, null, "the pick is dropped with the old parts");
});

// ---- wave 3 (stream U): the song structure on the curve and «Regenerate only this part» ----

test("repeat groups: sections that repeat each other share one colour; chained repeats join one group", () => {
    const groups = repeatGroups([
        { aMs: 0, bMs: 20000, lenMs: 10000, sim: 0.9 },
        { aMs: 20000, bMs: 60000, lenMs: 10000, sim: 0.85 }, // the second A repeats again: same group
        { aMs: 30000, bMs: 70000, lenMs: 5000, sim: 0.8 },
        { aMs: 1, bMs: Number.NaN, lenMs: 1 }, // not a repeat
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].spans, [[0, 10000], [20000, 30000], [60000, 70000]]);
    assert.deepEqual(groups[1].spans, [[30000, 35000], [70000, 75000]]);
    assert.notEqual(groups[0].color, groups[1].color);
    assert.deepEqual(repeatGroups(null), []);
});

test("the chosen variant's phrase starts are ticks and its repeats underlines; a new song clears them", () => {
    const { $, tl } = setup();
    const ctx = $("timeline").getContext("2d");
    const structure = { phrases: [{ startMs: 0, bars: 8 }, { startMs: 22500, bars: 8 }, { startMs: 45000, bars: 4 }], repeats: [{ aMs: 0, bMs: 45000, lenMs: 22500, sim: 0.9 }] };
    ctx.calls.length = 0;
    tl.setResult({ reports: null, structure });
    const ticks = ctx.calls.filter((c) => c[0] === "fillRect" && c[2] === 64 - 14 && c[4] === 10);
    assert.deepEqual(ticks.map((c) => c[1]), [Math.round(432 * 0.25), Math.round(432 * 0.5)], "the song's start needs no tick");
    const lines = ctx.calls.filter((c) => c[0] === "fillRect" && c[2] === 64 - 3 && c[4] === 2);
    assert.deepEqual(lines.map((c) => [Math.round(c[1]), Math.round(c[3])]), [[0, 108], [216, 108]]);
    ctx.calls.length = 0;
    tl.setSong({ durationMs: 90000, energy: null });
    assert.equal(ctx.calls.filter((c) => c[0] === "fillRect" && (c[4] === 10 || c[4] === 2)).length, 0);
});

test("«Regenerate only this part» shows with the lock toggle when there is more than one part, and names the part", async () => {
    setLang("en");
    try {
        const dom = fakeDom({});
        const only = [];
        const tl = createTimeline({
            canvas: dom.$("timeline"), editor: dom.$("part-editor"), getCursor: () => 0,
            onSeek() {}, onChange() {}, onReset() {}, onToggleLock() {}, onOnlyThis: (i) => only.push(i),
        });
        tl.setSong({ durationMs: 90000, energy: null });
        tl.setParts(PARTS.map((p) => ({ ...p })));
        const button = () => find(dom.$("part-editor"), (n) => n.tagName === "BUTTON" && n.textContent === "Regenerate only this part");
        tl.select(1);
        assert.equal(button(), undefined, "no result yet");
        tl.setResult({ reports: [], locks: new Set(), canLock: true });
        tl.select(1);
        await fire(button());
        assert.deepEqual(only, [1]);
        tl.setParts([{ startMs: 0, endMs: 90000, kind: "part" }]);
        tl.setResult({ reports: [], locks: new Set(), canLock: true });
        tl.select(0);
        assert.equal(button(), undefined, "one part: nothing else to keep");
    } finally {
        setLang("ru");
    }
});
