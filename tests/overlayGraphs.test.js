// The KPS graph held steady against presses that come late (osu! stable's judgements reach the overlay with the next
// tosu frame, 100-300 ms after their notes: the curve used to droop at its newest end between frames and jump back
// up with each one, a few times a second; src/overlay/kps.js's settle delay), and the keyboard's presses taken at the
// start of a pause in osu! stable going again when the play resumes from where it stood (src/overlay/session.js).
import test from "node:test";
import assert from "node:assert/strict";
import { createKpsMeter, SETTLE_FOLLOW, SETTLE_MAX_MS, smoothRate } from "../src/overlay/kps.js";
import { createLaneTracker } from "../src/overlay/lanes.js";
import { createOverlaySession, STALL_MS } from "../src/overlay/session.js";

// A stream of `perSecond` presses from `from` to `to` ms, delivered by "frames" every frameMs: a frame at F brings the
// presses made up to F - judgedMs (a note is judged a little after it), each with its lateness when `tellLate`.
// Snapshots every 33 ms. → for each grid time drawn: the value it was first drawn with and the one it ended with;
// the newest point against the rate the presses really had there; how far the drawn end moved per snapshot
function streamThroughMeter({ perSecond = 16, chord = 2, from = 1000, to = 15000, frameMs = 150, judgedMs = 100, tellLate = true }) {
    const k = createKpsMeter();
    const presses = [];
    for (let t = from; t < to; t += (1000 / perSecond) * chord) for (let c = 0; c < chord; c += 1) presses.push(t);
    let next = 0;
    const first = new Map();
    const last = new Map();
    const nowErr = [];
    const pace = [];
    let prevAt = null;
    let nextFrame = 0;
    for (let now = 0; now < to + 1000; now += 33) {
        while (nextFrame <= now) {
            while (next < presses.length && presses[next] <= nextFrame - judgedMs) {
                k.press(presses[next], 1, tellLate ? nextFrame - presses[next] : 0);
                next += 1;
            }
            nextFrame += frameMs;
        }
        const h = k.history(now);
        const at = Number.isFinite(h.at) ? h.at : now;
        const lastGrid = Math.floor(at / 100) * 100;
        const n = h.values.length - 2;
        h.values.slice(0, -1).forEach((v, i) => {
            const g = lastGrid - (n - i) * 100;
            if (!first.has(g)) first.set(g, v);
            last.set(g, v);
        });
        if (now > from + 3000 && now < to - 500) nowErr.push(Math.abs(k.now(now) - smoothRate(presses, at)));
        if (prevAt !== null && now > from + 3000) pace.push((at - prevAt) / 33);
        prevAt = at;
    }
    const revisions = [...first].map(([g, v]) => Math.abs(last.get(g) - v));
    return { k, revisions, worstRevision: Math.max(...revisions), worstNowErr: Math.max(...nowErr), pace };
}

test("KPS graph: judgements a tosu frame late no longer bend the drawn curve back up; the number reads the real rate", () => {
    // 16 a second in 2-note chords, judged 100 ms after their notes (late hits, tosu's read), a frame every 150 ms
    const before = streamThroughMeter({ tellLate: false }); // as 0.10.5 drew it: up to the clock itself
    assert.ok(before.worstRevision > 2.5, `the old curve's drawn points moved by up to ${before.worstRevision.toFixed(2)} KPS`);
    assert.ok(before.worstNowErr > 3.5, `the old number sagged ${before.worstNowErr.toFixed(2)} below the rate between frames`);
    const after = streamThroughMeter({});
    // what is left: the last tenth of the presses, later than the delay covers, adding their small edge weight
    assert.ok(after.worstRevision < before.worstRevision / 2, `a drawn point moves by ${after.worstRevision.toFixed(3)} KPS at most`);
    assert.ok(after.worstNowErr < 0.05, `the number is within ${after.worstNowErr.toFixed(3)} of the rate the presses had`);
    assert.ok(after.k.delay() >= 200 && after.k.delay() <= 250, `settle delay ${after.k.delay()} ms: the presses' lateness`);
    // the graph still scrolls with the clock (the delay settles in the first seconds)
    assert.ok(after.pace.every((p) => Math.abs(p - 1) < 1e-9), "steady once settled");
    // presses each in its own frame (a quick tosu, singles): nothing left to move
    const quick = streamThroughMeter({ chord: 1, frameMs: 50, judgedMs: 10 });
    assert.ok(quick.worstRevision < 0.3 && quick.worstNowErr < 0.1, `${quick.worstRevision} ${quick.worstNowErr}`);
    // slower frames (a tosu polling every 300 ms): the delay follows
    const slow = streamThroughMeter({ frameMs: 300 });
    assert.ok(slow.k.delay() >= 330 && slow.worstNowErr < 0.5, `300 ms frames: delay ${slow.k.delay()}, ${slow.worstNowErr}`);
});

test("KPS settle delay: none for presses that come at once, never past SETTLE_MAX_MS, followed at SETTLE_FOLLOW of the clock", () => {
    const k = createKpsMeter();
    for (let t = 0; t < 3000; t += 100) k.press(t); // the keyboard: at once
    k.history(3000);
    assert.equal(k.delay(), 0);
    assert.equal(k.history(3000).at, 3000);
    // a stalled tosu: presses 2 s late; the delay climbs at SETTLE_FOLLOW of the clock, up to SETTLE_MAX_MS
    for (let t = 3000; t < 6000; t += 100) k.press(t, 1, 2000);
    k.history(6100);
    assert.ok(Math.abs(k.delay() - SETTLE_FOLLOW * 3100) < 1e-9, `${k.delay()}`);
    for (let now = 6100; now <= 12_000; now += 33) k.history(now);
    assert.equal(k.delay(), SETTLE_MAX_MS);
    // a play's first press sets the delay at once (nothing drawn yet to keep steady); reset() forgets it
    k.reset();
    assert.equal(k.delay(), 0);
    k.press(500, 1, 140);
    assert.equal(k.delay(), 140);
});

test("KPS dropAfter: the presses after t go, and the max they made with them", () => {
    const k = createKpsMeter();
    for (let t = 0; t < 4000; t += 200) k.press(t); // 5 a second
    const steady = k.max();
    assert.ok(Math.abs(steady - 5) < 1e-9, `${steady}`);
    for (let t = 4000; t < 4600; t += 25) k.press(t); // a burst of 40 a second that was none
    assert.ok(k.max() > 20);
    k.dropAfter(3999);
    assert.ok(Math.abs(k.max() - steady) < 1e-9, `the max back to ${k.max()}`);
    assert.equal(k.now(4600), smoothRate([3400, 3600, 3800], 4600));
    // older peaks already pruned from the meter's memory still count
    const long = createKpsMeter({ historyMs: 1000 });
    for (let t = 0; t < 1000; t += 25) long.press(t); // 40 a second, long gone by the end
    for (let t = 1000; t < 20_000; t += 200) long.press(t);
    const peak = long.max();
    long.press(20_100);
    long.dropAfter(20_000);
    assert.equal(long.max(), peak);
});

test("lanes dropKeysAfter: the keyboard's bars after t go with their counts; a bar let go after t ends at t", () => {
    const l = createLaneTracker({ keys: 4 });
    l.keyDown(0, 1000);
    l.keyUp(0, 1040);
    l.keyDown(1, 1100); // held into the pause, let go in it
    l.keyUp(1, 1900);
    l.keyDown(2, 1300); // pressed in the pause
    l.keyUp(2, 1330);
    l.keyDown(3, 1400); // pressed in the pause, still held
    assert.equal(l.dropKeysAfter(1200), 2);
    assert.deepEqual(l.counts(), [1, 1, 0, 0]);
    assert.deepEqual(l.bars(1200, 1500), [{ col: 0, start: 1000, end: 1040 }, { col: 1, start: 1100, end: 1200 }]);
    l.keyUp(3, 1500); // its bar is gone: nothing to close
    assert.equal(l.bars(1600, 1500).length, 2);
    const m = createLaneTracker({ keys: 4 });
    m.setMap({ keys: 4, notes: [{ t: 1000, col: 0, end: null }] });
    m.judge({ hit: 1 }, 1010);
    assert.equal(m.dropKeysAfter(0), 0, "the map's guesses are not the keyboard's");
});

const frame = (live, max = 0) => ({
    state: "playing", client: "stable", mode: 3, checksum: "m1", rate: 1, mods: [], liveMs: live, accuracy: null, ur: null, hitErrors: [],
    hits: { max, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 },
});
const NOTES = { keys: 4, notes: Array.from({ length: 200 }, (_, i) => ({ t: 500 + i * 250, col: i % 4, end: null })) };

// a stable play with the keyboard: frames every 100 ms (map = real - 1000), a key every 100 ms; then the clock stands
// at 3000 (a pause, keys mashed in its first second, taken: it could have been tosu stalling) and picks up again
// `resumeAt` real ms later from `resumeLive`
function pausedPlay({ resumeLive, resumeAt = 9000 }) {
    const s = createOverlaySession();
    s.onFrame(frame(0), 1000);
    s.setMap("m1", NOTES);
    let key = 0;
    const press = (at) => {
        const col = key++ % 4;
        const taken = s.onKey({ col, down: true, at, keys: 4 });
        s.onKey({ col, down: false, at: at + 30, keys: 4 });
        return taken;
    };
    for (let now = 1100; now <= 4000; now += 100) {
        press(now - 50);
        s.onFrame(frame(now - 1000), now);
    }
    const before = s.snapshot(4000);
    // the pause: the clock stands at 3000; keys in the first STALL_MS are taken, the rest are not
    let taken = 0;
    for (let now = 4100; now < resumeAt; now += 100) {
        s.onFrame(frame(3000), now);
        if (press(now + 20)) taken += 1;
    }
    s.onFrame(frame(resumeLive), resumeAt);
    return { s, before, taken, after: s.snapshot(resumeAt) };
}

test("session: keys taken at the start of an osu! stable pause go when the play resumes from where it stood", () => {
    const { before, taken, after, s } = pausedPlay({ resumeLive: 3050 });
    assert.ok(taken >= STALL_MS / 100 - 1, `keys taken in the pause's first STALL_MS: ${taken}`);
    assert.deepEqual(after.lanes.counts, before.lanes.counts, "the counts are the play's again");
    assert.ok(after.lanes.bars.every((b) => b.start <= 3000 + 1e-9), "no bar past where the clock stood");
    assert.ok(after.lanes.bars.every((b) => b.end === null || b.end <= 3000 + 1e-9), "a key let go in the pause ends there");
    assert.equal(after.kps.max, before.kps.max, "the mashing raised no max");
    // the clock runs on from 3050: no phantom bar comes back as it passes 3000-4500
    for (let now = 9100; now <= 10_600; now += 100) s.onFrame(frame(3050 + now - 9000), now);
    const later = s.snapshot(10_600);
    assert.ok(later.lanes.bars.every((b) => b.start <= 3000 + 1e-9), "none of them comes back");
    assert.equal(later.kps.max, before.kps.max);
});

test("session: keys taken while tosu stalled stay when the clock comes back ahead (the game went on)", () => {
    // the frames stand 1.2 s but the game went on: the next one is 1.2 s ahead
    const { before, taken, after } = pausedPlay({ resumeLive: 3000 + 1300, resumeAt: 5300 });
    assert.ok(taken > 0);
    const sum = (c) => c.reduce((a, b) => a + b, 0);
    assert.equal(sum(after.lanes.counts), sum(before.lanes.counts) + taken, "the stall's keys are the play's");
});

test("session: osu! stable's judgements through the session: the drawn KPS curve stays as drawn", () => {
    // a 16-a-second stream judged ~30 ms after each note; tosu reads every 150 ms; snapshots every 33 ms
    const notes = Array.from({ length: 16 * 20 }, (_, i) => ({ t: 1000 + i * 62.5, col: i % 4, end: null }));
    const s = createOverlaySession();
    const START = 500; // real ms at map 0
    s.onFrame(frame(0), START);
    s.setMap("m1", { keys: 4, notes });
    const first = new Map();
    const last = new Map();
    let nextFrame = START + 150;
    for (let now = START + 33; now < START + 21_000; now += 33) {
        while (nextFrame <= now) {
            const live = nextFrame - START;
            s.onFrame(frame(live, notes.filter((n) => n.t + 30 <= live).length), nextFrame);
            nextFrame += 150;
        }
        const h = s.snapshot(now).kps.history;
        const lastGrid = Math.floor(h.at / 100) * 100;
        const n = h.values.length - 2;
        h.values.slice(0, -1).forEach((v, i) => {
            const g = lastGrid - (n - i) * 100;
            if (!first.has(g)) first.set(g, v);
            last.set(g, v);
        });
    }
    const worst = Math.max(...[...first].map(([g, v]) => Math.abs(last.get(g) - v)));
    assert.ok(worst < 0.3, `a drawn point moved by ${worst.toFixed(2)} KPS`);
    assert.ok(Math.abs(s.snapshot(START + 15_000).kps.now - 16) < 0.3, `${s.snapshot(START + 15_000).kps.now}`);
});
