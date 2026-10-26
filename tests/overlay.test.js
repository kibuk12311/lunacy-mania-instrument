// The overlay's pure parts: formatting, the KPS window, tosu frames, the map's notes, the lanes, a whole play
// through the session, the settings and the drawing geometry.
import test from "node:test";
import assert from "node:assert/strict";
import { formatAccuracy, formatCount, formatKps, formatRatio, formatUr, maniaAccuracy, unstableRate } from "../src/overlay/format.js";
import { createKpsMeter, smoothRate } from "../src/overlay/kps.js";
import { readPlayFrame, readPreciseFrame, totalHits } from "../src/overlay/tosuData.js";
import { parseManiaNotes } from "../src/overlay/maniaNotes.js";
import { createLaneTracker, TAP_MS } from "../src/overlay/lanes.js";
import { createOverlaySession, LEAVE_MS } from "../src/overlay/session.js";
import { applyPatch, hotkeyLabel, normalizeOverlaySettings, placeWidget, STYLES, WIDGETS, widgetSize } from "../src/overlay/settings.js";
import { easeToward, graphCeiling, graphPoints, holdRounded, laneColor, laneRects, PALETTE } from "../src/overlay/draw.js";
import { createNpsTrack, PROFILE_POINTS } from "../src/overlay/nps.js";
import { createVisibilityGate } from "../src/overlay/visibility.js";
import { fakeSnapshot } from "../src/overlay/fake.js";

// ---- format ----

test("MAX:300 ratio: two decimals, ∞ with no 300s, a dash before the first note", () => {
    assert.equal(formatRatio(421, 100), "4.21:1");
    assert.equal(formatRatio(1, 3), "0.33:1");
    assert.equal(formatRatio(50, 0), "∞");
    assert.equal(formatRatio(0, 0), "—");
    assert.equal(formatRatio(5000, 2), "2500:1");
    assert.equal(formatRatio(undefined, null), "—");
});

test("mania accuracy counts MAX like 300 and reads null before any judgement", () => {
    assert.equal(maniaAccuracy({}), null);
    assert.equal(maniaAccuracy({ max: 10 }), 100);
    assert.equal(maniaAccuracy({ max: 1, n300: 1, n200: 1, miss: 1 }), (100 * (300 + 300 + 200)) / 1200);
    assert.equal(formatAccuracy(98.7654), "98.77%");
    assert.equal(formatAccuracy(null), "—");
    assert.equal(formatAccuracy(101), "100.00%");
});

test("unstable rate is ten standard deviations of the hit errors", () => {
    assert.equal(unstableRate([]), null);
    assert.equal(unstableRate([5]), null);
    assert.equal(unstableRate([-10, 10]), 100);
    assert.equal(unstableRate([0, 0, 0, 0]), 0);
    assert.equal(formatUr(123.456), "123.46");
    assert.equal(formatUr(0), "—");
    assert.equal(formatUr(null), "—");
    assert.equal(formatKps(11.6), "12");
    assert.equal(formatKps(undefined), "0");
    assert.equal(formatCount(-3), "0");
    assert.equal(formatCount("1532"), "1532");
});

// ---- KPS ----

test("KPS: a steady stream reads its rate, smoothed, wherever the clock is between presses; the max is the curve's peak", () => {
    const k = createKpsMeter();
    for (let i = 0; i < 100; i += 1) k.press(i * 100); // 10 a second for 10 s
    for (const t of [5000, 5033, 5050, 5066, 5099]) assert.ok(Math.abs(k.now(t) - 10) < 1e-9, `${t}: ${k.now(t)}`);
    assert.ok(Math.abs(k.max() - 10) < 1e-9);
    assert.equal(k.now(12_000), 0);
    k.reset();
    assert.equal(k.max(), 0);
    assert.equal(k.now(900), 0);
});

test("KPS: a press that comes in late barely moves the shown rate (it used to add a whole 1)", () => {
    const k = createKpsMeter();
    for (let i = 0; i < 50; i += 1) k.press(i * 100);
    const before = k.now(4995);
    k.press(4990); // judged in the frame that came just now
    assert.ok(Math.abs(k.now(4995) - before) < 0.1);
});

test("KPS: a late press inserted in the past raises the max of the samples it belongs to", () => {
    const k = createKpsMeter();
    k.press(100);
    k.press(300);
    assert.ok(Math.abs(k.max() - 3.75) < 1e-9); // at 500 and 700: weights 1 and 0.5 over a 0.4 s half-window
    k.press(200); // arrives after 300
    assert.ok(Math.abs(k.max() - 6.25) < 1e-9); // at 600: 0.75 + 1 + 0.75
});

test("KPS history: a fixed 100 ms grid over 10 s, then the point at the clock; finished samples never move", () => {
    const k = createKpsMeter();
    for (let i = 0; i < 120; i += 1) k.press(i * 83 + ((i * 37) % 29));
    const a = k.history(9050);
    const b = k.history(9083);
    const c = k.history(9120);
    assert.equal(a.values.length, 102);
    assert.equal(a.shift, 0.5);
    assert.ok(Math.abs(b.shift - 0.83) < 1e-9);
    // the same grid samples while the clock moves inside a step, the same values one step on
    assert.deepEqual(a.values.slice(0, 101), b.values.slice(0, 101));
    assert.deepEqual(c.values.slice(0, 100), a.values.slice(1, 101));
    assert.equal(a.values.at(-1), k.now(9050));
});

test("KPS: the smoothed rate is a triangle around t - half; nothing after t counts", () => {
    assert.equal(smoothRate([1000], 1400, { half: 400 }), 2.5);
    assert.equal(smoothRate([1000], 1200, { half: 400 }), 1.25);
    assert.equal(smoothRate([1000], 1800, { half: 400 }), 0);
    assert.equal(smoothRate([1000, 1500], 1400, { half: 400 }), 2.5);
    // centred on t itself (the NPS of a map, known ahead): times up to t + half count
    assert.equal(smoothRate([1200], 1400, { half: 400, lag: 0 }), 1.25);
});

// ---- tosu ----

const playFrame = (over = {}) => ({
    state: { number: 2, name: "play" },
    beatmap: { checksum: "abc", time: { live: 1000 }, mode: { number: 3 } },
    play: {
        mode: { number: 3, name: "mania" },
        hits: { "0": 1, "50": 0, "100": 2, "300": 30, geki: 120, katu: 5 },
        accuracy: 97.5, unstableRate: 101.2, hitErrorArray: [1, -2, 3],
        mods: { name: "DT", array: [{ acronym: "DT" }], rate: 1.5 },
    },
    ...over,
});

test("a tosu v2 frame: state, map, rate, live time, mania judgements", () => {
    const f = readPlayFrame(playFrame());
    assert.equal(f.state, "playing");
    assert.equal(f.mode, 3);
    assert.equal(f.checksum, "abc");
    assert.equal(f.rate, 1.5);
    assert.equal(f.liveMs, 1000);
    assert.deepEqual(f.hits, { max: 120, n300: 30, n200: 5, n100: 2, n50: 0, miss: 1 });
    assert.equal(totalHits(f.hits), 158);
    assert.equal(f.accuracy, 97.5);
    assert.equal(f.ur, 101.2);
    assert.deepEqual(f.hitErrors, [1, -2, 3]);
});

test("a frame with nothing in it reads as zeros and nulls; results fall back to resultsScreen", () => {
    const f = readPlayFrame({});
    assert.equal(f.state, "other");
    assert.deepEqual(f.hits, { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 });
    assert.equal(f.liveMs, null);
    assert.equal(f.accuracy, null);
    const r = readPlayFrame({ state: { number: 7 }, play: { hits: {} }, resultsScreen: { hits: { geki: 9, "300": 3 } } });
    assert.equal(r.state, "results");
    assert.equal(r.hits.max, 9);
    assert.equal(r.hits.n300, 3);
});

test("a precise frame: K1 K2 M1 M2 today, K1–K4 if tosu ever sends them, null without keys", () => {
    const p = readPreciseFrame({ currentTime: 1234, keys: { k1: { isPressed: true, count: 5 }, k2: { isPressed: false, count: 3 }, m1: { count: 0 }, m2: { count: 1 } } });
    assert.equal(p.timeMs, 1234);
    assert.deepEqual(p.keys, [{ pressed: true, count: 5 }, { pressed: false, count: 3 }, { pressed: false, count: 0 }, { pressed: false, count: 1 }]);
    const four = readPreciseFrame({ currentTime: 1, keys: { k1: { count: 1 }, k2: { count: 2 }, k3: { count: 3 }, k4: { count: 4 } } });
    assert.deepEqual(four.keys.map((k) => k.count), [1, 2, 3, 4]);
    assert.equal(readPreciseFrame({ currentTime: 5 }).keys, null);
});

// ---- notes ----

const OSU = [
    "osu file format v14", "", "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "",
    "[HitObjects]",
    "64,192,1000,1,0,0:0:0:0:",
    "448,192,1000,1,0,0:0:0:0:",
    "192,192,1200,128,0,1600:0:0:0:0:",
    "320,192,1100,1,0,0:0:0:0:",
    "broken line",
].join("\r\n");

test("the map's notes: lanes from x, hold ends, sorted by time", () => {
    const { keys, notes } = parseManiaNotes(OSU);
    assert.equal(keys, 4);
    assert.deepEqual(notes, [
        { t: 1000, col: 0, end: null },
        { t: 1000, col: 3, end: null },
        { t: 1100, col: 2, end: null },
        { t: 1200, col: 1, end: 1600 },
    ]);
    assert.deepEqual(parseManiaNotes("").notes, []);
});

// ---- lanes ----

test("map lanes: each judgement takes the next note; holds are judged twice; misses take the oldest", () => {
    const lanes = createLaneTracker();
    lanes.setMap(parseManiaNotes(OSU));
    assert.equal(lanes.source(), "map");
    // the two notes at 1000 hit
    assert.deepEqual(lanes.judge({ hit: 2 }, 1010), [{ t: 1000, col: 0 }, { t: 1000, col: 3 }]);
    // the note at 1100 missed
    assert.deepEqual(lanes.judge({ miss: 1 }, 1290), []);
    // the hold's head, then its release: one press, the bar as long as the hold
    assert.deepEqual(lanes.judge({ hit: 1 }, 1210), [{ t: 1200, col: 1 }]);
    assert.deepEqual(lanes.judge({ hit: 1 }, 1600), []);
    assert.deepEqual(lanes.counts(), [1, 1, 0, 1]);
    const bars = lanes.bars(1600, 2000);
    assert.deepEqual(bars.find((b) => b.col === 1), { col: 1, start: 1200, end: 1600 });
    assert.deepEqual(bars.find((b) => b.col === 0), { col: 0, start: 1000, end: 1000 + TAP_MS });
    assert.deepEqual(lanes.pressed(1300), [false, true, false, false]);
});

test("map lanes: a note too far behind is skipped instead of shifting every later lane", () => {
    const lanes = createLaneTracker();
    lanes.setMap(parseManiaNotes(OSU));
    // nothing judged until 2500: the notes before 1500 are dropped, the next judgement is the hold's release
    assert.deepEqual(lanes.judge({ hit: 1 }, 2550), []);
    assert.deepEqual(lanes.counts(), [0, 0, 0, 0]);
    // a note far in the future is not taken early
    lanes.reset();
    assert.deepEqual(lanes.judge({ hit: 5 }, 100), []);
});

test("key lanes: the counters take over once they move, holds stay open until released", () => {
    const lanes = createLaneTracker();
    lanes.setMap(parseManiaNotes(OSU));
    const keys = (c, p = [false, false, false, false]) => c.map((count, i) => ({ count, pressed: p[i] }));
    assert.deepEqual(lanes.keysFrame(keys([7, 7, 7, 7]), 900), []); // the counters before the play
    assert.equal(lanes.source(), "map");
    assert.deepEqual(lanes.keysFrame(keys([8, 7, 7, 7], [true, false, false, false]), 1000), [{ t: 1000, col: 0 }]);
    assert.equal(lanes.source(), "keys");
    assert.deepEqual(lanes.judge({ hit: 1 }, 1000), []); // the map is not used any more
    assert.deepEqual(lanes.pressed(1100), [true, false, false, false]);
    lanes.keysFrame(keys([8, 7, 7, 7]), 1150);
    assert.deepEqual(lanes.bars(1200, 1000), [{ col: 0, start: 1000, end: 1150 }]);
    lanes.keysFrame(keys([8, 9, 7, 7]), 1200); // two presses between frames: two taps
    assert.deepEqual(lanes.counts(), [1, 2, 0, 0]);
    lanes.keysFrame(keys([0, 0, 0, 0]), 1300); // osu! reset its counters: no negative presses
    assert.deepEqual(lanes.counts(), [1, 2, 0, 0]);
});

// ---- session ----

const frame = (state, live, hits, extra = {}) => ({
    state, mode: 3, checksum: "abc", rate: 1, liveMs: live,
    hits: { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0, ...hits }, accuracy: null, ur: null, hitErrors: [], ...extra,
});

test("session: a play's judgements become presses, KPS, ratio and lanes; a retry starts over", () => {
    const s = createOverlaySession();
    assert.equal(s.onFrame(frame("songselect", 0, {}), 0).mapWanted, null);
    assert.equal(s.snapshot(0).phase, "idle");
    assert.equal(s.onFrame(frame("playing", 900, {}), 100).mapWanted, "abc");
    s.setMap("abc", parseManiaNotes(OSU));
    s.onFrame(frame("playing", 1010, { max: 2 }), 210);
    s.onFrame(frame("playing", 1110, { max: 2, n300: 1 }), 310);
    let snap = s.snapshot(310);
    assert.equal(snap.phase, "playing");
    assert.equal(snap.running, true);
    assert.equal(snap.ratio, "2.00:1");
    assert.ok(snap.kps.now > 0);
    assert.ok(Math.abs(snap.kps.max - 6.875) < 1e-9); // the notes at 1000, 1000 and 1100, peaking at 1400
    assert.deepEqual(snap.lanes.counts, [1, 0, 1, 1]);
    assert.equal(snap.lanes.source, "map");
    assert.ok(snap.accuracy === 100);
    // the clock runs on between frames, no further than 300 ms
    assert.equal(s.snapshot(410).clock, 1210);
    assert.equal(s.snapshot(5000).clock, 1110 + 300);
    // retry: the counts drop and the clock goes back
    s.onFrame(frame("playing", 50, {}), 400);
    snap = s.snapshot(400);
    assert.equal(snap.kps.max, 0);
    assert.deepEqual(snap.lanes.counts, [0, 0, 0, 0]);
    assert.equal(snap.ratio, "—");
});

test("session: without the map's notes, every judgement counts as one press", () => {
    const s = createOverlaySession();
    s.onFrame(frame("playing", 1000, {}), 0);
    s.setMap("abc", null); // the map could not be read
    s.onFrame(frame("playing", 1100, { max: 3, miss: 1 }), 100);
    const snap = s.snapshot(100);
    assert.equal(snap.kps.max, 7.5); // 3 presses at 1100, all at the peak of the window ending at 1500
    assert.equal(snap.lanes.source, "none");
});

test("session: the results screen keeps the play's numbers; leaving it goes idle; at 1.5× KPS is in real time", () => {
    const s = createOverlaySession();
    s.onFrame(frame("playing", 1000, {}, { rate: 1.5 }), 0);
    s.onFrame(frame("playing", 1150, { max: 3 }, { rate: 1.5 }), 100);
    // 3 presses at map 1150 = 766.7 ms of real time: the nearest sample is 1200 (it would be 7.5 at 1500 in map time)
    assert.ok(Math.abs(s.snapshot(100).kps.max - 6.875) < 1e-9);
    s.onFrame(frame("results", 1150, { max: 3, n300: 1 }, { rate: 1.5, accuracy: 99 }), 200);
    const snap = s.snapshot(200);
    assert.equal(snap.phase, "results");
    assert.equal(snap.running, false);
    assert.equal(snap.ratio, "3.00:1");
    assert.equal(snap.accuracy, 99);
    assert.ok(Math.abs(snap.kps.max - 6.875) < 1e-9);
    s.onFrame(frame("songselect", 0, {}), 300);
    assert.equal(s.phase(), "idle");
});

test("session: one odd frame in the middle of a play keeps the play (KPS max, lanes); a lasting one ends it", () => {
    const s = createOverlaySession();
    s.onFrame(frame("playing", 900, {}), 0);
    s.setMap("abc", parseManiaNotes(OSU));
    s.onFrame(frame("playing", 1010, { max: 2 }), 100);
    s.onFrame(frame("playing", 1110, { max: 2, n300: 1 }), 200);
    const before = s.snapshot(200);
    assert.ok(before.kps.max > 0);
    // tosu reads song select (or the menu) for one frame, then the play again
    s.onFrame(frame("songselect", 0, {}), 300);
    assert.equal(s.phase(), "playing", "one frame is not the end of the play");
    assert.equal(s.snapshot(300).running, false, "but its clock stops meanwhile");
    s.onFrame(frame("menu", 0, {}), 450);
    assert.equal(s.phase(), "playing");
    s.onFrame(frame("playing", 1210, { max: 2, n300: 1 }), 500);
    let snap = s.snapshot(500);
    assert.equal(snap.phase, "playing");
    assert.equal(snap.kps.max, before.kps.max, "the max is kept");
    assert.deepEqual(snap.lanes.counts, before.lanes.counts, "the lanes are kept");
    assert.equal(snap.ratio, "2.00:1");
    // song select for LEAVE_MS: the play is over, the next one starts from nothing
    s.onFrame(frame("songselect", 0, {}), 600);
    s.onFrame(frame("songselect", 0, {}), 600 + LEAVE_MS - 1);
    assert.equal(s.phase(), "playing");
    s.onFrame(frame("songselect", 0, {}), 600 + LEAVE_MS);
    assert.equal(s.phase(), "idle");
    s.onFrame(frame("playing", 900, {}), 1200);
    snap = s.snapshot(1200);
    assert.equal(snap.kps.max, 0);
    assert.equal(snap.ratio, "—");
});

test("session: the results screen ends a play at once, without waiting", () => {
    const s = createOverlaySession();
    s.onFrame(frame("playing", 1000, {}), 0);
    s.onFrame(frame("playing", 1100, { max: 4 }), 100);
    s.onFrame(frame("songselect", 0, {}), 200); // a stray frame first
    s.onFrame(frame("results", 1100, { max: 4 }, { accuracy: 100 }), 250);
    assert.equal(s.phase(), "results");
    assert.equal(s.snapshot(250).hits.max, 4);
});

test("session: precise frames move the clock and feed the key counters", () => {
    const s = createOverlaySession();
    s.onFrame(frame("playing", 1000, {}), 0);
    s.onPrecise({ timeMs: 1005, keys: [0, 0, 0, 0].map((count) => ({ count, pressed: false })) }, 5);
    s.onPrecise({ timeMs: 1015, keys: [1, 0, 0, 1].map((count) => ({ count, pressed: false })) }, 15);
    const snap = s.snapshot(15);
    assert.equal(snap.clock, 1015);
    assert.equal(snap.lanes.source, "keys");
    assert.deepEqual(snap.lanes.counts, [1, 0, 0, 1]);
    assert.ok(snap.kps.max > 4.5); // 2 presses at 1015: 2 × 2.5 × 0.9625 at the 1400 sample
});

// ---- settings ----

test("settings: defaults, every widget, broken values cleaned", () => {
    const d = normalizeOverlaySettings(null);
    assert.equal(d.enabled, false);
    assert.equal(d.showOnResults, true);
    assert.deepEqual(Object.keys(d.widgets), WIDGETS);
    for (const w of WIDGETS) {
        assert.equal(d.widgets[w].enabled, true);
        assert.ok(STYLES.includes(d.widgets[w].style));
        assert.equal(d.widgets[w].scale, 1);
        assert.equal(d.widgets[w].x, null);
    }
    assert.deepEqual(d.widgets.judgements.show, { counts: true, ratio: true, accuracy: true, ur: true });
    const bad = normalizeOverlaySettings({ enabled: "yes", widgets: { kps: { style: "x", opacity: 7, scale: -1, x: "a", show: { graph: false } } } });
    assert.equal(bad.enabled, false);
    assert.equal(bad.widgets.kps.style, "card");
    assert.equal(bad.widgets.kps.opacity, 1);
    assert.equal(bad.widgets.kps.scale, 0.5);
    assert.equal(bad.widgets.kps.x, null);
    assert.deepEqual(bad.widgets.kps.show, { now: true, max: true, graph: false });
    assert.ok(STYLES.length >= 4);
});

test("settings: a patch changes only what it names", () => {
    const base = normalizeOverlaySettings(null);
    const next = applyPatch(base, { enabled: true, widgets: { keys: { style: "neon", show: { counts: false } }, nope: { style: "neon" } } });
    assert.equal(next.enabled, true);
    assert.equal(next.widgets.keys.style, "neon");
    assert.deepEqual(next.widgets.keys.show, { lines: true, counts: false });
    assert.deepEqual(next.widgets.kps, base.widgets.kps);
    assert.equal(base.enabled, false, "the old object is left alone");
    assert.equal(hotkeyLabel("CommandOrControl+Shift+O"), "Ctrl+Shift+O");
});

test("settings: sizes follow the scale; compact is one wide line; a lost position is placed again", () => {
    assert.deepEqual(widgetSize("kps", "card", 2), { width: 420, height: 256 });
    const compact = widgetSize("judgements", "compact", 1);
    assert.ok(compact.width > compact.height * 5);
    const screens = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
    const s = applyPatch(normalizeOverlaySettings(null), { widgets: { kps: { x: 500, y: 400 }, keys: { x: 9000, y: 9000 } } });
    assert.deepEqual(placeWidget("kps", s, screens), { x: 500, y: 400, width: 210, height: 128 });
    const keys = placeWidget("keys", s, screens);
    assert.ok(keys.x < 1920 && keys.y < 1080);
});

// ---- drawing ----

test("lane bars: the newest at the bottom, a held note growing to the clock, the old ones gone", () => {
    const rects = laneRects([
        { col: 0, start: 900, end: 945 }, // a tap 100 ms ago
        { col: 2, start: 500, end: null }, // still held
        { col: 1, start: -2000, end: -1900 }, // scrolled off the top
        { col: 3, start: 1200, end: 1300 }, // in the future (map hold not reached)
    ], { clock: 1000, spanMs: 1000, keys: 4, width: 200, height: 100, gap: 0 });
    assert.equal(rects.length, 2);
    const tap = rects.find((r) => r.col === 0);
    assert.equal(tap.x, 0);
    assert.equal(tap.w, 50);
    assert.ok(Math.abs(tap.y - 90) < 1e-9);
    assert.ok(Math.abs(tap.h - 4.5) < 1e-9);
    const held = rects.find((r) => r.col === 2);
    assert.equal(held.y, 50);
    assert.equal(held.h, 50);
});

test("KPS graph points span the width and keep a calm stretch low", () => {
    const pts = graphPoints([0, 5, 10], { width: 100, height: 52, pad: 1 });
    assert.deepEqual(pts.map((p) => p.x), [0, 50, 100]);
    assert.equal(pts[0].y, 51);
    assert.equal(pts[2].y, 1);
    const calm = graphPoints([2, 2], { width: 10, height: 52, pad: 1 });
    assert.ok(calm[0].y > 30);
});

test("every style has lane colours; the fake snapshot is shaped like a real one", () => {
    for (const style of STYLES) assert.equal(PALETTE[style].lanes.length, 4, style);
    assert.equal(laneColor("nope", 5), PALETTE.card.lanes[1]);
    const fake = fakeSnapshot(5000);
    const real = createOverlaySession().snapshot(0);
    // the made-up one carries the Dan widget's made-up payload too (main's comes with the config)
    assert.deepEqual(Object.keys(fake).filter((k) => k !== "dan").sort(), Object.keys(real).sort());
    assert.equal(fake.dan.checksum, fake.checksum);
    assert.deepEqual(Object.keys(fake.lanes).sort(), Object.keys(real.lanes).sort());
    assert.ok(fake.lanes.bars.length > 0);
    assert.match(fake.ratio, /^\d+\.\d\d:1$/);
});

test("KPS graph: the grid scrolls by its shift, the newest point sits at the right edge, the top is the given ceiling", () => {
    const history = { values: [0, 5, 10, 20, 7], shift: 0.5 }; // 4 grid samples one step apart, then the clock's point
    const pts = graphPoints(history, { width: 90, height: 52, pad: 1, top: 10 });
    assert.deepEqual(pts.map((p) => p.x), [-15, 15, 45, 75, 90]);
    assert.equal(pts[2].y, 1);
    assert.equal(pts[3].y, 1, "above the ceiling stays at the top edge");
    assert.equal(pts[0].y, 51);
    // the same values a frame later: only the x moves, the scale stays
    const later = graphPoints({ ...history, shift: 0.8 }, { width: 90, height: 52, pad: 1, top: 10 });
    assert.deepEqual(later.map((p) => p.y), pts.map((p) => p.y));
});

test("graph ceiling and easing: the scale sits above the max and moves to it smoothly; the big number holds its integer", () => {
    assert.equal(graphCeiling(0), 10);
    assert.ok(Math.abs(graphCeiling(20) - 23) < 1e-9);
    assert.equal(easeToward(null, 12, 16, 600), 12);
    const step = easeToward(10, 20, 16, 600);
    assert.ok(step > 10 && step < 10.5, "one frame moves the scale a little");
    assert.ok(Math.abs(easeToward(10, 20, 6000, 600) - 20) < 0.01);
    assert.equal(holdRounded(10, 10.55), 10);
    assert.equal(holdRounded(10, 10.45), 10);
    assert.equal(holdRounded(10, 9.4), 10);
    assert.equal(holdRounded(10, 10.8), 11);
    assert.equal(holdRounded(10, NaN), 0);
});

// ---- NPS ----

const npsNotes = (from, to, stepMs, hold = false) => {
    const notes = [];
    for (let t = from; t < to; t += stepMs) notes.push({ t, col: 0, end: hold ? t + stepMs / 2 : null });
    return notes;
};

test("NPS: the map's density at the play position, its peak and its whole profile; a hold note counts once", () => {
    const nps = createNpsTrack();
    assert.deepEqual(nps.at(1000), { ready: false, now: 0, peak: 0, profile: [], progress: 0 });
    // 5 a second for 10 s, then 10 a second (holds) for 10 s
    nps.setMap([...npsNotes(0, 10_000, 200), ...npsNotes(10_000, 20_000, 100, true)]);
    const calm = nps.at(5000);
    assert.ok(calm.ready);
    assert.ok(Math.abs(calm.now - 5) < 1e-9, String(calm.now));
    assert.ok(Math.abs(nps.at(15_000).now - 10) < 1e-9, "a hold note's end is not another note");
    assert.ok(Math.abs(calm.peak - 10) < 1e-9);
    assert.equal(calm.profile.length, PROFILE_POINTS);
    assert.ok(calm.profile[20] < calm.profile[140]);
    assert.ok(Math.abs(calm.progress - 5000 / 19_900) < 1e-9);
    assert.equal(nps.at(-500).progress, 0);
    assert.equal(nps.at(99_000).progress, 1);
    // no lag: the map is known ahead, so the change at 10 s is half through right at 10 s
    const edge = nps.at(10_000).now;
    assert.ok(edge > 6.5 && edge < 8.5, String(edge));
});

test("NPS: with DT (1.5x) the map runs in real time, every number 1.5 times higher; the playhead follows map time", () => {
    const nps = createNpsTrack();
    nps.setMap(npsNotes(0, 30_000, 100)); // 10 a second
    nps.setRate(1.5);
    const r = nps.at(15_000); // map ms
    assert.ok(Math.abs(r.now - 15) < 1e-9, String(r.now));
    assert.ok(Math.abs(r.peak - 15) < 1e-9);
    assert.ok(Math.abs(r.progress - 15_000 / 29_900) < 1e-9);
    nps.setRate(0.75);
    assert.ok(Math.abs(nps.at(15_000).now - 7.5) < 1e-9);
});

test("session: the NPS of the map comes with the snapshot once its notes are in, at the play's rate", () => {
    const s = createOverlaySession();
    s.onFrame(frame("playing", 900, {}, { rate: 1.5 }), 0);
    assert.equal(s.snapshot(0).nps.ready, false);
    s.setMap("abc", parseManiaNotes(OSU));
    const snap = s.snapshot(0);
    assert.equal(snap.nps.ready, true);
    assert.ok(snap.nps.peak > 0);
    assert.ok(snap.nps.now > 0);
    // a retry keeps the map's NPS, another map drops it until its notes come
    s.onFrame(frame("playing", 50, {}, { rate: 1.5 }), 100);
    assert.equal(s.snapshot(100).nps.ready, true);
    s.onFrame(frame("playing", 50, {}, { checksum: "other" }), 200);
    assert.equal(s.snapshot(200).nps.ready, false);
});

// ---- showing and hiding ----

// tosu frames every 150 ms as [state, live ms, judgements] -> what the gate answers after each
function gateRun(sequence, { showOnResults = true, stepMs = 150 } = {}) {
    const s = createOverlaySession();
    const gate = createVisibilityGate();
    return sequence.map(([state, live, max = 0], i) => {
        const at = i * stepMs;
        s.onFrame(frame(state, live, { max }), at);
        const phase = s.phase();
        return gate.update({
            want: phase === "playing" || (phase === "results" && showOnResults),
            advancing: phase === "results" || s.advancing(),
            now: at,
        });
    });
}

test("visibility: a stray play or results frame in song select never shows the widgets", () => {
    const select = (n) => Array.from({ length: n }, () => ["songselect", 0]);
    // one frame of "play" (went into a map and straight back out, or a misread state), one of "results" (a score
    // opened from the leaderboard and closed), two of "play" with a clock that does not move
    for (const blip of [[["playing", 5000]], [["results", 0]], [["playing", 5000], ["playing", 5000]]]) {
        const shown = gateRun([...select(4), ...blip, ...select(6)]);
        assert.deepEqual(shown.filter(Boolean), [], JSON.stringify(blip));
    }
});

test("visibility: a real play shows within half a second and stays through a single odd frame; leaving hides", () => {
    const play = (from, n) => Array.from({ length: n }, (_, i) => ["playing", from + i * 150]);
    const shown = gateRun([
        ["songselect", 0], ...play(-1500, 4), // 150..600 ms: playing, the clock moving
        ...play(-900, 6),
        ["songselect", 0], // one stray frame in the middle of the play
        ...play(0, 4),
        ...Array.from({ length: 7 }, () => ["songselect", 0]),
    ]);
    assert.equal(shown.indexOf(true), 4, "shown at 600 ms, 450 ms after the play began");
    assert.ok(shown.slice(4, 16).every(Boolean), "the odd frame does not hide it");
    // the play ends once song select has lasted LEAVE_MS (500), the windows go 300 ms after that
    assert.equal(shown.at(-1), false);
    assert.equal(shown.at(-2), true, "not hidden before the play has really ended");
    assert.equal(shown.at(-5), true, "not hidden by the first frames of song select");
});

test("visibility: the results screen after a play stays on; a paused start with no clock shows after 1.5 s", () => {
    const played = Array.from({ length: 6 }, (_, i) => ["playing", i * 150, i]);
    const shown = gateRun([...played, ["results", 900, 5], ["results", 900, 5]]);
    assert.deepEqual(shown.slice(-3), [true, true, true]);
    const hidden = gateRun([...played, ["results", 900, 5], ["results", 900, 5], ["results", 900, 5]], { showOnResults: false });
    assert.equal(hidden.at(-1), false);
    const stuck = gateRun(Array.from({ length: 12 }, () => ["playing", 0]));
    assert.equal(stuck.indexOf(true), 10, "1500 ms of play state alone is trusted");
    const g = createVisibilityGate();
    g.update({ want: true, now: 0 });
    assert.equal(g.pending(100), 300);
    assert.equal(g.pending(500), 1000, "past 400 ms it waits for a sign of life or for 1.5 s");
});
