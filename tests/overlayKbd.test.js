// osu! stable's real keys in the overlay: the key lines' "kbd" source (src/overlay/lanes.js), the play clock that puts
// a key's real time on the map's clock steadily whatever tosu's frames do (src/overlay/playClock.js), the session's
// onKey (src/overlay/session.js), and a whole made-up play under tosu jitter and stalls (tests/helpers/playSim.js):
// with the keyboard the KPS and the bars are the real presses to the millisecond; rebuilt from the judgements (0.10.5)
// they are not.
import test from "node:test";
import assert from "node:assert/strict";
import { createLaneTracker } from "../src/overlay/lanes.js";
import { createPlayClock, JUMP_MS } from "../src/overlay/playClock.js";
import { createOverlaySession, STALL_MS } from "../src/overlay/session.js";
import { simulatePlay } from "./helpers/playSim.js";

const NOTES = { keys: 4, notes: [{ t: 1000, col: 0, end: null }, { t: 1100, col: 3, end: null }, { t: 1200, col: 1, end: 1400 }] };

test("lanes: the first key takes the lanes over from the map's guesses and keeps them; tosu's counters can't take them back", () => {
    const l = createLaneTracker({ keys: 4 });
    l.setMap(NOTES);
    assert.equal(l.source(), "map");
    l.judge({ hit: 1 }, 1010);
    assert.deepEqual(l.counts(), [1, 0, 0, 0]);
    const p = l.keyDown(2, 1050.25);
    assert.deepEqual(p, { t: 1050.25, col: 2, took: true });
    assert.equal(l.source(), "kbd");
    assert.deepEqual(l.counts(), [0, 0, 1, 0], "the guesses go");
    assert.deepEqual(l.bars(1060, 1500), [{ col: 2, start: 1050.25, end: null }], "held until it comes up");
    assert.deepEqual(l.pressed(1060), [false, false, true, false]);
    l.keyUp(2, 1062.5);
    assert.deepEqual(l.bars(1070, 1500), [{ col: 2, start: 1050.25, end: 1062.5 }], "its real length, however short");
    assert.equal(l.keyDown(1, 1100).took, false);
    assert.deepEqual(l.judge({ hit: 5 }, 1300), [], "judgements no longer make presses");
    assert.deepEqual(l.keysFrame([{ pressed: true, count: 0 }], 1300), []);
    assert.deepEqual(l.keysFrame([{ pressed: true, count: 3 }], 1310), [], "tosu's counters moving don't take them back");
    assert.equal(l.source(), "kbd");
    assert.equal(l.keyDown(4, 1320), null, "a lane past the last");
    l.setMap(NOTES);
    assert.equal(l.source(), "kbd", "the map's notes coming late keep the real presses");
    assert.deepEqual(l.counts(), [0, 1, 1, 0]);
    l.keyDown(0, 1400);
    l.releaseAll(1450);
    assert.equal(l.bars(1460, 1500).find((b) => b.col === 0 && b.start === 1400).end, 1450, "the keyboard gone: held lanes let go");
    l.reset();
    assert.equal(l.source(), "map", "a new play gives the lanes back to the map until a key comes again");
    assert.equal(l.lanes(), 4);
});

test("lanes: a key mod's key count for the keyboard; the map's again on the next play", () => {
    const l = createLaneTracker({ keys: 4 });
    l.setMap(NOTES);
    l.keyDown(6, 1000, 7);
    assert.equal(l.lanes(), 7);
    assert.deepEqual(l.counts(), [0, 0, 0, 0, 0, 0, 1]);
    l.setMap(NOTES);
    assert.equal(l.lanes(), 7, "the keyboard's lanes stay");
    l.reset();
    assert.equal(l.lanes(), 4);
});

test("play clock: the quickest frame's line, whatever the delays; a jump starts it over", () => {
    const c = createPlayClock();
    assert.equal(c.at(0), null);
    // map = real − 500 at 1×; frames 0–60 ms late, one of them on time
    const delays = [40, 12, 55, 0.5, 33, 60, 21];
    delays.forEach((d, i) => c.sample(i * 100 - 500, i * 100 + d, 1));
    assert.equal(c.at(1000), 499.5, "the quickest frame (0.5 ms late) sets it");
    // a frame far ahead of the line: a seek (osu!'s skip)
    c.sample(5000, 800, 1);
    assert.equal(c.at(800), 5000);
    // the clock picking up after a pause: far behind the line
    c.sample(5100, 800 + 3000 + 100, 1);
    assert.equal(c.at(3900), 5100);
    // a late frame within JUMP_MS is jitter, not a jump
    c.sample(5200, 4000 + JUMP_MS - 10, 1);
    assert.equal(c.at(4000), 5200);
    // DT: another rate starts it over at that rate
    c.sample(6000, 4500, 1.5);
    assert.equal(c.at(4600), 6150);
    c.reset();
    assert.equal(c.at(5000), null);
});

// a stable frame: map time live, `hits` MAX judgements
const frame = (live, max = 0, extra = {}) => ({
    state: "playing", client: "stable", mode: 3, checksum: "m1", rate: 1, mods: [], liveMs: live, accuracy: null, ur: null, hitErrors: [],
    hits: { max, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 }, ...extra,
});

test("session: keys count only while the play's clock runs; the first takes the KPS over; bars at the keys' own times", () => {
    const s = createOverlaySession();
    assert.equal(s.onKey({ col: 0, down: true, at: 10, keys: 4 }), false, "no play: no key");
    s.onFrame(frame(0), 1000);
    assert.equal(s.onKey({ col: 0, down: true, at: 1010, keys: 4 }), false, "the clock hasn't moved yet");
    s.setMap("m1", NOTES);
    assert.equal(s.playKeys(), 4);
    s.onFrame(frame(100), 1100);
    s.onFrame(frame(1020, 1), 2020); // a judgement: the map's guess
    assert.equal(s.snapshot(2030).lanes.source, "map");
    assert.ok(s.snapshot(2030).kps.max > 0);
    assert.equal(s.onKey({ col: 1, down: true, at: 2040.5, keys: 4 }), true);
    s.onKey({ col: 1, down: false, at: 2071, keys: 4 });
    const snap = s.snapshot(2100);
    assert.equal(snap.lanes.source, "kbd");
    assert.deepEqual(snap.lanes.counts, [0, 1, 0, 0], "the map's guess is gone");
    assert.deepEqual(snap.lanes.bars, [{ col: 1, start: 1040.5, end: 1071 }], "map time = real − 1000, to the fraction");
    assert.ok(Math.abs(snap.clock - 1100) < 1e-9, "the snapshot's clock is the play clock now");
    // the KPS is the real press alone (the judgement's press went with the takeover)
    s.onFrame(frame(2000, 1), 3000);
    assert.ok(s.snapshot(3000).kps.max > 0 && s.snapshot(3000).kps.max <= 2.5 + 1e-9, `${s.snapshot(3000).kps.max}`);
    // the frames stand: a short standstill may be tosu sending its last frame again, its keys are the play's
    s.onKey({ col: 2, down: true, at: 3010, keys: 4 });
    s.onFrame(frame(2050, 1), 3050);
    s.onFrame(frame(2050, 1), 3150);
    assert.equal(s.onKey({ col: 3, down: true, at: 3160, keys: 4 }), true, "standing 110 ms: no pause yet");
    s.onKey({ col: 3, down: false, at: 3170, keys: 4 });
    assert.equal(s.snapshot(3200).running, true);
    // standing longer than STALL_MS: a pause, keys pressed in it are no presses; a key let go still closes its bar
    for (let now = 3250; now <= 4650; now += 100) s.onFrame(frame(2050, 1), now);
    assert.equal(s.onKey({ col: 0, down: true, at: 3050 + STALL_MS + 50, keys: 4 }), false, "paused");
    assert.equal(s.onKey({ col: 2, down: false, at: 4610, keys: 4 }), true);
    assert.equal(s.snapshot(4650).running, false);
    assert.deepEqual(s.snapshot(4650).lanes.counts, [0, 1, 1, 1]);
    // a retry (the clock back): the lanes are the map's again until the next key
    s.onFrame(frame(100), 4000);
    assert.equal(s.snapshot(4000).lanes.source, "map");
});

test("session: tosu stalls but the keys go on: the clock runs on with them; then it stands 300 ms after the last", () => {
    const s = createOverlaySession();
    s.onFrame(frame(0), 1000);
    s.setMap("m1", NOTES);
    s.onFrame(frame(100), 1100);
    s.onKey({ col: 0, down: true, at: 1150, keys: 4 });
    // no frame from here on; keys every 100 ms up to real 2500
    for (let at = 1200; at <= 2500; at += 100) s.onKey({ col: at % 400 === 0 ? 1 : 2, down: true, at, keys: 4 });
    assert.ok(Math.abs(s.snapshot(2550).clock - 1550) < 1e-9, "still running at the real rate");
    assert.ok(Math.abs(s.snapshot(4000).clock - 1800) < 1e-9, "300 ms past the last key, then it stands");
    s.keysGone(2600);
    assert.ok(s.snapshot(2700).lanes.bars.every((b) => b.end !== null), "the keyboard gone: nothing held");
});

test("session: tosu stalls sending its last frame again and again: the keys still count (no pause for STALL_MS)", () => {
    const run = (repeat) => {
        const s = createOverlaySession();
        s.onFrame(frame(0), 1000);
        s.setMap("m1", NOTES);
        let taken = 0;
        let lastLive = 0;
        for (let now = 1100; now <= 4000; now += 100) {
            const stalled = now >= 2000 && now < 3200; // 1.2 s of tosu's reading stuck
            if (!stalled) s.onFrame(frame((lastLive = now - 1000)), now);
            else if (repeat) s.onFrame(frame(lastLive), now);
            for (let k = 0; k < 4; k++) {
                const at = now + k * 25;
                if (s.onKey({ col: k, down: true, at, keys: 4 })) taken += 1;
                s.onKey({ col: k, down: false, at: at + 10, keys: 4 });
            }
        }
        return { taken, counts: s.snapshot(4000).lanes.counts };
    };
    assert.deepEqual(run(false), { taken: 120, counts: [30, 30, 30, 30] }, "no frames in the stall");
    assert.deepEqual(run(true), { taken: 120, counts: [30, 30, 30, 30] }, "the last frame again in the stall");
});

test("session: a play that is not the player's own (autoplay, spectating, a replay) takes no key", () => {
    const s = createOverlaySession();
    s.onFrame(frame(0, 0, { watching: true }), 1000);
    s.setMap("m1", NOTES);
    s.onFrame(frame(100, 0, { watching: true }), 1100);
    assert.equal(s.watching(), true);
    assert.equal(s.onKey({ col: 0, down: true, at: 1150, keys: 4 }), false);
    assert.equal(s.snapshot(1200).lanes.source, "map");
    s.onFrame(frame(200), 1200);
    assert.equal(s.watching(), false);
    assert.equal(s.onKey({ col: 0, down: true, at: 1250, keys: 4 }), true);
});

test("session: the play's key count: the map's, a key mod's, none for co-op or before the notes", () => {
    const s = createOverlaySession();
    s.onFrame(frame(0), 0);
    assert.equal(s.playKeys(), null, "the map's notes aren't in yet");
    s.setMap("m1", { keys: 7, notes: [{ t: 10, col: 6, end: null }] });
    assert.equal(s.playKeys(), 7);
    const k = createOverlaySession();
    k.onFrame(frame(0, 0, { mods: ["4K"] }), 0);
    assert.equal(k.playKeys(), 4, "the key mod");
    const cp = createOverlaySession();
    cp.onFrame(frame(0, 0, { mods: ["CP"] }), 0);
    cp.setMap("m1", NOTES);
    assert.equal(cp.playKeys(), null, "co-op: not read");
});

// The measurement (tools/measure-key-lines.mjs prints the table): the same made-up play through both sources.
test("a whole play under tosu jitter and stalls: the keyboard's KPS and bars are the real presses; the judgements' are not", () => {
    for (const network of ["steady", "jitter", "bursts"]) {
        for (const rate of [1, 1.5]) {
            const kbd = simulatePlay({ source: "kbd", network, rate, seed: 7 });
            const map = simulatePlay({ source: "map", network, rate, seed: 7 });
            const what = `${network} ${rate}×`;
            assert.equal(kbd.source, "kbd");
            assert.equal(kbd.counted, kbd.presses, `${what}: every press counted, ghost presses too`);
            assert.equal(kbd.unmatched, 0, `${what}: a bar for every press`);
            assert.equal(kbd.bars, kbd.presses, `${what}: and no other`);
            // the only error left: the helper's clock matched to ±0.3 ms and the quickest frame's 0.5 ms (× rate)
            assert.ok(kbd.startMax <= 1 * rate + 0.3, `${what}: bar starts within ${kbd.startMax.toFixed(2)} ms`);
            assert.ok(kbd.endMean <= 1 * rate, `${what}: bar ends within ${kbd.endMean.toFixed(2)} ms`);
            assert.ok(Math.abs(kbd.kpsMax - kbd.trueMax) < 0.05, `${what}: KPS max ${kbd.kpsMax} vs ${kbd.trueMax}`);
            assert.ok(kbd.kpsNowMean < 0.05 && kbd.kpsNowMax < 0.5, `${what}: KPS now off by ${kbd.kpsNowMean.toFixed(3)} on average, ${kbd.kpsNowMax.toFixed(2)} at most`);
            // 0.10.5's map rebuild on the same play
            assert.equal(map.source, "map");
            assert.ok(map.counted < map.presses - map.ghost / 2, `${what}: the map rebuild misses presses (${map.counted} of ${map.presses})`);
            assert.ok(kbd.startMean < 1 && map.startMean > 10, `${what}: its bars sit at the notes, not the presses (${map.startMean.toFixed(1)} ms off on average)`);
            assert.ok(map.kpsMax < map.trueMax - 1, `${what}: its KPS max is short (${map.kpsMax} vs ${map.trueMax.toFixed(2)})`);
            assert.ok(map.kpsNowMean > 10 * kbd.kpsNowMean, `${what}: its KPS now is off by ${map.kpsNowMean.toFixed(2)} on average`);
        }
    }
});
