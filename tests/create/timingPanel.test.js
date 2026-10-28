// The timing panel: the octave buttons, the offset nudge, adding / removing red lines, one BPM for the song,
// typed values, the panel itself (sections table, buttons, snap chips) on the fake DOM, and the octave row
// «130 / 260?» of a detected timing's alternatives.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { setLang } from "../../src/i18n/i18n.js";
import {
    scaleBpm, nudgeSection, addSectionAt, removeSection, oneBpm, setSection, withMirrors, createTimingPanel, octaveChoices,
} from "../../app/renderer/timingPanel.js";

const T = (...sections) => withMirrors(sections.map(([timeMs, bpm, meter = 4]) => ({ timeMs, bpm, meter })));

test("mirrors: bpm and offsetMs follow the first red line", () => {
    assert.deepEqual(T([312, 174], [60000, 180, 3]), {
        sections: [{ timeMs: 312, bpm: 174, meter: 4 }, { timeMs: 60000, bpm: 180, meter: 3 }], bpm: 174, offsetMs: 312,
    });
});

test("octave buttons: ×2, ÷2, ×1.5, ×⅔ on the chosen section, inside 40–400 BPM", () => {
    const t = T([312, 174], [60000, 120]);
    assert.equal(scaleBpm(t, 0, 2).sections[0].bpm, 348);
    assert.equal(scaleBpm(t, 0, 0.5).sections[0].bpm, 87);
    assert.equal(scaleBpm(t, 1, 1.5).sections[1].bpm, 180);
    assert.equal(scaleBpm(T([0, 261]), 0, 2 / 3).sections[0].bpm, 174, "no float dust");
    assert.equal(scaleBpm(t, 0, 2).bpm, 348, "the mirror follows");
    assert.equal(scaleBpm(t, 0, 2).sections[1].bpm, 120, "the other section stays");
    assert.equal(scaleBpm(T([0, 250]), 0, 2), null, "500 BPM is refused");
    assert.equal(scaleBpm(T([0, 70]), 0, 0.5), null, "35 BPM is refused");
    assert.equal(t.sections[0].bpm, 174, "the timing given is not changed");
});

test("nudge: the chosen red line moves by whole ms, never past its neighbours or below 0", () => {
    const t = T([312, 174], [60000, 180]);
    assert.equal(nudgeSection(t, 0, 1).offsetMs, 313);
    assert.equal(nudgeSection(t, 0, -5).offsetMs, 307);
    assert.equal(nudgeSection(t, 1, 5).sections[1].timeMs, 60005);
    assert.equal(nudgeSection(t, 1, 5).sections[0].timeMs, 312, "only the chosen line moves");
    assert.equal(nudgeSection(T([3, 174]), 0, -5).offsetMs, 0, "stops at 0");
    assert.equal(nudgeSection(T([0, 174], [10, 174]), 1, -10), null, "cannot land on the previous line");
    assert.equal(nudgeSection(T([0, 174], [10, 174]), 0, 10), null, "cannot land on the next line");
});

test("a point added at the cursor sits on the nearest beat and takes that section's BPM", () => {
    const t = T([100, 120]); // beats every 500 ms
    const { timing, index } = addSectionAt(t, 10240, 60000);
    assert.equal(index, 1);
    assert.deepEqual(timing.sections, [{ timeMs: 100, bpm: 120, meter: 4 }, { timeMs: 10100, bpm: 120, meter: 4 }]);
    // on top of an existing line: nothing new
    assert.equal(addSectionAt(timing, 10120, 60000).timing.sections.length, 2);
    assert.equal(addSectionAt(timing, 10120, 60000).index, 1);
    // before the first line: the new line becomes the first one
    const early = addSectionAt(T([5100, 120]), 1080, 60000);
    assert.equal(early.index, 0);
    assert.deepEqual(early.timing.sections.map((s) => s.timeMs), [1100, 5100]);
    assert.equal(addSectionAt(t, 70000, 60000).timing.sections.length, 1, "past the end of the song: nothing");
});

test("remove a point (never the last one) and one BPM for the whole song", () => {
    const t = T([312, 174], [60000, 180], [90000, 174]);
    assert.deepEqual(removeSection(t, 1).sections.map((s) => s.timeMs), [312, 90000]);
    assert.deepEqual(removeSection(t, 0).offsetMs, 60000);
    assert.equal(removeSection(T([0, 100]), 0), null);
    // the chosen section's BPM and phase, moved to the first beat at or after 0
    const one = oneBpm(T([312, 174], [60000.5, 120]), 1);
    assert.equal(one.sections.length, 1);
    assert.equal(one.bpm, 120);
    assert.ok(Math.abs(one.offsetMs - (60000.5 % 500)) < 1e-9, String(one.offsetMs));
});

test("typed values: a bad BPM, meter or an out-of-order start is refused", () => {
    const t = T([312, 174], [60000, 180]);
    assert.equal(setSection(t, 0, { bpm: 175.5 }).bpm, 175.5);
    assert.equal(setSection(t, 1, { timeMs: 30000 }).sections[1].timeMs, 30000);
    assert.equal(setSection(t, 1, { meter: 3 }).sections[1].meter, 3);
    assert.equal(setSection(t, 0, { bpm: 20 }), null);
    assert.equal(setSection(t, 0, { bpm: Number.NaN }), null);
    assert.equal(setSection(t, 1, { timeMs: 100 }), null, "before the previous line");
    assert.equal(setSection(t, 0, { timeMs: -1 }), null);
    assert.equal(setSection(t, 1, { meter: 0 }), null);
    assert.equal(setSection(t, 1, { meter: 17 }), null);
});

function panel(timing = T([312, 174], [60000, 180]), opts = {}) {
    const { $ } = fakeDom({});
    const changes = [];
    const p = createTimingPanel({
        root: $("timing-sections"), snapsRoot: $("snaps"), bpmInput: $("bpm"), offsetInput: $("offset"), note: $("timing-note"),
        getCursor: () => 10240, getDurationMs: () => 120000, onChange: (t, why) => changes.push([t, why]), ...opts,
    });
    p.set(timing);
    return { $, p, changes };
}

const buttonsOf = (node) => (node.tagName === "BUTTON" ? [node] : node.children.flatMap(buttonsOf));
const byText = (node, text) => buttonsOf(node).find((b) => b.textContent === text);

test("the panel: the section table for 2+ red lines, the buttons edit the chosen one, #bpm and #offset follow", async () => {
    setLang("en");
    try {
        const { $, p, changes } = panel();
        const root = $("timing-sections");
        assert.equal(root.hidden, false);
        assert.ok(textOf(root).includes("Start"), textOf(root));
        assert.ok(textOf(root).includes("Meter"), textOf(root));
        assert.equal($("bpm").value, "174");
        assert.equal($("offset").value, "312");

        await fire(byText(root, "×2"));
        assert.equal(p.timing.sections[0].bpm, 348);
        assert.equal($("bpm").value, "348");
        assert.equal(changes.at(-1)[1], "edit");

        p.select(1);
        assert.equal($("bpm").value, "180");
        assert.equal($("offset").value, "60000");
        await fire(byText(root, "+5"));
        assert.equal(p.timing.sections[1].timeMs, 60005);
        p.nudge(-1);
        assert.equal(p.timing.sections[1].timeMs, 60004);

        $("bpm").value = "190";
        await fire($("bpm"), "change");
        assert.equal(p.timing.sections[1].bpm, 190);
        $("bpm").value = "9000";
        await fire($("bpm"), "change");
        assert.equal(p.valid(), false);
        assert.equal(p.timing.sections[1].bpm, 190, "kept until the typed value is good");
        $("bpm").value = "200";
        await fire($("bpm"), "change");
        assert.equal(p.valid(), true);

        await fire(byText(root, "+ point here"));
        assert.equal(p.timing.sections.length, 3);
        assert.equal(p.selected, 1, "the new point is chosen");
        await fire(byText(root, "One BPM for the whole song"));
        assert.equal(p.timing.sections.length, 1);
    } finally {
        setLang("ru");
    }
});

test("the snap chips: 1/4 always on, 1/8 1/3 1/6 toggle, β on triplets for a 1/4 model, even scroll speed on", async () => {
    setLang("en");
    try {
        const { $, p } = panel(T([0, 150]));
        const snaps = $("snaps");
        const chip = (text) => {
            const all = (n) => [n, ...n.children.flatMap(all)];
            return all(snaps).find((n) => n.dataset?.snap === text);
        };
        assert.deepEqual(p.snaps(), [4]);
        await fire(chip("4"));
        assert.deepEqual(p.snaps(), [4], "1/4 cannot be switched off");
        await fire(chip("3"));
        await fire(chip("8"));
        assert.deepEqual(p.snaps(), [4, 3, 8]);
        await fire(chip("3"));
        assert.deepEqual(p.snaps(), [4, 8]);
        assert.ok(chip("3").textContent.includes("β"));
        assert.equal(chip("3").title, "triplets are rule-placed for now — the model was trained on 1/4 only");
        assert.ok(!chip("8").textContent.includes("β"));
        p.setModelInfo({ kind: "xgb-v2", grid: "snap-v2", maps: 9000 });
        assert.ok(!chip("3").textContent.includes("β"));
        assert.equal(p.normalizeSv(), true);
        assert.ok(textOf(snaps).includes("Even scroll speed"));
        assert.ok(textOf(snaps).includes("Snap divisors"));
    } finally {
        setLang("ru");
    }
});

test("the note: variable BPM, refined from the waveform, or detected automatically", () => {
    setLang("en");
    try {
        const { $, p } = panel(T([0, 150]));
        p.set({ ...T([0, 150], [30000, 175]), variable: true }, { detected: true });
        assert.equal($("timing-note").textContent, "Variable BPM found: 2 parts — check each one");
        p.set({ ...T([0, 150]), refinedErrMs: 1.24 }, { refined: true });
        assert.equal($("timing-note").textContent, "Timing refined from the waveform (±1.2 ms)");
        p.set(T([0, 150]), { detected: true });
        assert.equal($("timing-note").textContent, "detected automatically — have a listen and fix it if the clicks are off the beat");
        assert.equal($("timing-sections").children.some((c) => c.dataset?.role === "table"), false, "one red line: no table");
    } finally {
        setLang("ru");
    }
});

test("0.9.8 «Автоподбор»: setSnaps sets the grid chips; 1/4 always stays, unknown grids are dropped", () => {
    const { p } = panel();
    p.setSnaps([8, 3, 12]);
    assert.deepEqual(p.snaps(), [4, 3, 8]);
    p.setSnaps([]);
    assert.deepEqual(p.snaps(), [4]);
});

test("the octave choices of a detected timing: its own line and its alternatives, slowest first", () => {
    const detected = { ...T([16, 260]), alternatives: [{ timeMs: 247, bpm: 130, share: 0.4 }] };
    assert.deepEqual(octaveChoices(detected), [{ timeMs: 247, bpm: 130 }, { timeMs: 16, bpm: 260 }]);
    assert.deepEqual(octaveChoices(T([16, 260])), [], "no alternatives");
    assert.deepEqual(octaveChoices({ ...T([16, 260], [60000, 180]), alternatives: detected.alternatives }), [], "several red lines");
    assert.deepEqual(octaveChoices({ ...T([16, 260]), alternatives: [{ timeMs: 5, bpm: 900 }, { timeMs: -1, bpm: 130 }, { bpm: 130 }] }), [], "none usable");
});

test("the octave row «130 / 260?»: one click puts the other octave in, the row stays to go back", async () => {
    setLang("en");
    try {
        const { $, p, changes } = panel(T([0, 150]));
        const root = $("timing-sections");
        const row = () => root.children.find((c) => c.dataset?.role === "octave");
        assert.equal(row(), undefined, "a timing that was not detected: no row");
        p.set({ ...T([16, 260]), alternatives: [{ timeMs: 247, bpm: 130, share: 0.4 }] }, { detected: true });
        assert.equal(textOf(row()), "Tempo unsure: | 130? | / | 260");
        assert.equal(byText(row(), "130?").title, "Use 130 BPM: the music fits this tempo almost as well");
        await fire(byText(row(), "130?"));
        assert.deepEqual(p.timing, { sections: [{ timeMs: 247, bpm: 130, meter: 4 }], bpm: 130, offsetMs: 247 });
        assert.equal(changes.at(-1)[1], "edit", "the parts are worked out again, as after any edit");
        assert.equal($("bpm").value, "130");
        assert.equal(textOf(row()), "Tempo unsure: | 130 | / | 260?");
        // ×2 from 130 is 260 again, one of the choices: the row stays
        await fire(byText(root, "×2"));
        assert.equal(p.timing.bpm, 260);
        assert.equal(textOf(row()), "Tempo unsure: | 130? | / | 260");
        $("bpm").value = "175";
        await fire($("bpm"), "change");
        assert.equal(row(), undefined, "a BPM of the user's own: nothing to choose between");
        p.set({ ...T([16, 260]), alternatives: [{ timeMs: 247, bpm: 130 }], refinedErrMs: 1 }, { refined: true });
        assert.equal(row(), undefined, "a refined timing is the user's own: no row");
    } finally {
        setLang("ru");
    }
});
