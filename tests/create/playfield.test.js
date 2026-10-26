// The playfield preview: what is on screen at a scroll speed, where a note is drawn, its snap colour, and the
// controls on the fake DOM (speed and hit clicks remembered, keys and wheel seek, pausing on other tabs).
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { setLang } from "../../src/i18n/i18n.js";
import { SNAP_COLORS } from "../../app/renderer/snapColors.js";
import { visibleSpanMs, visibleRange, noteY, snapOf, createPlayfield, JUDGE_Y } from "../../app/renderer/playfield.js";

test("the visible span follows the scroll speed: 11485 / speed ms", () => {
    assert.equal(visibleSpanMs(24), 11485 / 24);
    assert.ok(visibleSpanMs(10) > visibleSpanMs(40));
});

test("visibleRange is the same as a linear scan", () => {
    const rows = [];
    for (let t = 0, i = 0; t < 60000; i += 1) {
        rows.push({ t, mask: 1 << (i % 4) });
        t += 40 + ((i * 37) % 160);
    }
    for (const [from, to] of [[-500, 0], [0, 478], [12345, 12823], [59000, 70000], [30000, 30000], [70000, 80000]]) {
        const [i0, i1] = visibleRange(rows, from, to);
        const linear = rows.map((r, i) => [r, i]).filter(([r]) => r.t >= from && r.t <= to).map(([, i]) => i);
        assert.deepEqual(Array.from({ length: i1 - i0 }, (_, k) => i0 + k), linear, `${from}..${to}`);
    }
});

test("a note is on the judge line at its own time, a span later it is at the top", () => {
    const span = visibleSpanMs(24);
    assert.equal(noteY(5000, 5000, span, JUDGE_Y), JUDGE_Y);
    assert.ok(Math.abs(noteY(5000 + span, 5000, span, JUDGE_Y)) < 1e-9);
    assert.ok(noteY(4900, 5000, span, JUDGE_Y) > JUDGE_Y, "a passed note is below the line");
});

test("snapOf gives the snap colour (1/1, 1/2, 1/3, 1/4, 1/6)", () => {
    const timing = { sections: [{ timeMs: 0, bpm: 100, meter: 4 }] }; // 600 ms beats
    assert.equal(snapOf(1200, timing).color, SNAP_COLORS[1]);
    assert.equal(snapOf(1500, timing).color, SNAP_COLORS[2]);
    assert.equal(snapOf(1400, timing).color, SNAP_COLORS[3]);
    assert.equal(snapOf(1350, timing).color, SNAP_COLORS[4]);
    assert.equal(snapOf(1300, timing).color, SNAP_COLORS[6]);
});

function fakePlayer() {
    const listeners = new Set();
    const p = {
        position: 10000, playing: false, durationMs: 60000, hitClicks: "unset", toggles: 0,
        now: () => p.position,
        seek(ms) { p.position = Math.max(0, Math.min(60000, ms)); for (const fn of listeners) fn({ playing: p.playing }); },
        play() { p.playing = true; for (const fn of listeners) fn({ playing: true }); },
        pause() { p.playing = false; for (const fn of listeners) fn({ playing: false }); },
        toggle() { p.toggles += 1; if (p.playing) p.pause(); else p.play(); },
        setHitClicks(times) { p.hitClicks = times; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    return p;
}

const all = (n) => [n, ...n.children.flatMap(all)];

test("the controls: speed and hit clicks remembered, the play button follows the player", async () => {
    setLang("en");
    try {
        const dom = fakeDom({}, { storage: { "create-play-speed": "30", "create-play-clicks": "1" } });
        const player = fakePlayer();
        const field = createPlayfield({ canvas: dom.$("playfield"), controls: dom.$("play-controls"), player, getTiming: () => ({ bpm: 120, offsetMs: 0 }) });
        const nodes = all(dom.$("play-controls"));
        const slider = nodes.find((n) => n.type === "range");
        const box = nodes.find((n) => n.type === "checkbox");
        const play = nodes.find((n) => n.tagName === "BUTTON");
        assert.equal(slider.value, "30");
        assert.equal(box.checked, true);
        assert.equal(field.speed, 30);
        assert.ok(textOf(dom.$("play-controls")).includes("Beat grid only for now"), "no map yet: the grid note");
        assert.ok(textOf(dom.$("play-controls")).includes("Space — play/pause"));
        assert.equal(play.textContent, "▶ play");
        await fire(play);
        assert.equal(play.textContent, "❚❚ pause");

        field.setRows([{ t: 1000, mask: 1 }, { t: 1500, mask: 6 }]);
        assert.deepEqual(player.hitClicks, [1000, 1500], "hit clicks on the notes");
        assert.ok(!textOf(dom.$("play-controls")).includes("Beat grid only for now"));
        box.checked = false;
        await fire(box, "change");
        assert.equal(player.hitClicks, null);
        assert.equal(dom.storage.get("create-play-clicks"), "0");
        slider.value = "12";
        await fire(slider, "input");
        assert.equal(field.speed, 12);
        assert.equal(dom.storage.get("create-play-speed"), "12");

        // another tab, or the window hidden: pause
        dom.window.dispatchEvent({ type: "tab-shown", detail: "create" });
        assert.equal(player.playing, true);
        dom.window.dispatchEvent({ type: "tab-shown", detail: "rate" });
        assert.equal(player.playing, false);
    } finally {
        setLang("ru");
    }
});

test("keys and wheel on the playfield: ←/→ 2 s, the wheel one beat", async () => {
    const dom = fakeDom({}, { storage: null });
    const player = fakePlayer();
    const field = createPlayfield({ canvas: dom.$("playfield"), controls: dom.$("play-controls"), player, getTiming: () => ({ bpm: 120, offsetMs: 0 }) });
    assert.equal(field.speed, 24, "no storage: the default speed");
    const canvas = dom.$("playfield");
    await fire(canvas, "keydown", { key: "ArrowRight", preventDefault() {} });
    assert.equal(player.position, 12000);
    await fire(canvas, "keydown", { key: "ArrowLeft", preventDefault() {} });
    await fire(canvas, "keydown", { key: "ArrowLeft", preventDefault() {} });
    assert.equal(player.position, 8000);
    player.position = 8100;
    await fire(canvas, "wheel", { deltaY: 100, preventDefault() {} });
    assert.equal(player.position, 8500, "to the next beat (500 ms beats)");
    await fire(canvas, "wheel", { deltaY: -100, preventDefault() {} });
    assert.equal(player.position, 8000, "to the previous beat");
    await fire(canvas, "wheel", { deltaY: -100, preventDefault() {} });
    assert.equal(player.position, 7500);
});
