// The create tab's one audio player: the clock (what is heard now), song ↔ context time, and the click scheduler
// (every 50 ms, 200 ms ahead), driven through a fake AudioContext and hand-run timers.
import test from "node:test";
import assert from "node:assert/strict";
import {
    createAudioPlayer, audibleContextTime, songMsAt, contextTimeFor, dueClicks, LOOKAHEAD_MS, TICK_MS,
} from "../../app/renderer/audioPlayer.js";

test("the clock: the output timestamp moved on to now, else the render clock minus the output latency", () => {
    const ts = { contextTime: 9.9, performanceTime: 5000 };
    assert.equal(audibleContextTime({ currentTime: 10, outputTimestamp: ts, perfNow: 5040, outputLatency: 0.04, baseLatency: 0.01 }), 9.94);
    // never ahead of what is rendered
    assert.equal(audibleContextTime({ currentTime: 10, outputTimestamp: ts, perfNow: 9000, outputLatency: 0.04 }), 10);
    // no timestamp yet (just started) → currentTime − outputLatency, or baseLatency when that is 0
    const none = { contextTime: 0, performanceTime: 0 };
    assert.ok(Math.abs(audibleContextTime({ currentTime: 10, outputTimestamp: none, perfNow: 1, outputLatency: 0.2, baseLatency: 0.01 }) - 9.8) < 1e-9);
    assert.ok(Math.abs(audibleContextTime({ currentTime: 10, outputTimestamp: null, perfNow: 1, outputLatency: 0, baseLatency: 0.01 }) - 9.99) < 1e-9);
});

test("song time and context time are one line through the anchor", () => {
    const anchor = { ctxSec: 12.5, songMs: 30000 };
    assert.equal(songMsAt(12.5, anchor), 30000);
    assert.equal(songMsAt(13.5, anchor), 31000);
    assert.equal(contextTimeFor(31000, anchor), 13.5);
    assert.equal(contextTimeFor(songMsAt(17.25, anchor), anchor), 17.25);
});

test("due clicks: the ones in [from, to), numbers or { t }, same as a linear scan", () => {
    const times = Array.from({ length: 500 }, (_, i) => i * 37 + (i % 3));
    for (const [from, to] of [[0, 100], [-50, 0], [1000, 1000], [999, 5001], [18000, 99999]]) {
        assert.deepEqual(dueClicks(times, from, to), times.filter((x) => x >= from && x < to), `${from}..${to}`);
    }
    assert.deepEqual(dueClicks([{ t: 5, accent: true }, { t: 10 }], 0, 10), [{ t: 5, accent: true }]);
});

// --- a fake Web Audio context and timers -------------------------------------------------------
function fakeContext() {
    const sources = [];
    const ctx = {
        currentTime: 10, outputLatency: 0, baseLatency: 0, sampleRate: 8000, state: "running", destination: {},
        outputTimestamp: { contextTime: 0, performanceTime: 0 },
        sources,
        resume() { ctx.state = "running"; return Promise.resolve(); },
        getOutputTimestamp() { return ctx.outputTimestamp; },
        createGain() { return { gain: { value: 1 }, connect: (n) => n }; },
        createBuffer(channels, length) { const data = new Float32Array(length); return { length, getChannelData: () => data }; },
        createBufferSource() {
            const node = {
                buffer: null, started: null, stopped: false, onended: null,
                connect: (n) => n,
                start(...args) { node.started = args; },
                stop() { node.stopped = true; },
            };
            sources.push(node);
            return node;
        },
    };
    return ctx;
}

function setup() {
    const ctx = fakeContext();
    const timers = new Map();
    let nextId = 1;
    const player = createAudioPlayer({
        createContext: () => ctx,
        setTimer: (fn, ms) => { timers.set(nextId, { fn, ms }); return nextId++; },
        clearTimer: (id) => timers.delete(id),
        perfNow: () => 0,
    });
    const song = { duration: 60, length: 60 * 8000, sampleRate: 8000 };
    player.load(song);
    const tick = () => { for (const { fn } of [...timers.values()]) fn(); };
    const clicks = () => ctx.sources.filter((s) => s.buffer !== song && s.started && !s.stopped);
    const songSources = () => ctx.sources.filter((s) => s.buffer === song);
    return { ctx, player, timers, tick, clicks, songSources, song };
}

test("play: the song starts at the position, hit clicks go out 200 ms ahead, every tick, never twice", () => {
    const { ctx, player, timers, tick, clicks, songSources } = setup();
    player.setHitClicks(Array.from({ length: 50 }, (_, i) => 1000 + i * 100));
    player.seek(1000);
    player.play();
    assert.equal(player.playing, true);
    const [src] = songSources();
    const [when, offset] = src.started;
    assert.ok(when > ctx.currentTime && when - ctx.currentTime < 0.2, `starts just ahead: ${when}`);
    assert.equal(offset, 1);
    assert.deepEqual([...timers.values()].map((x) => x.ms), [TICK_MS]);
    assert.equal(LOOKAHEAD_MS, 200);

    // the first pass ran at play(): everything up to 200 ms past what is being rendered
    const rendered = songMsAt(ctx.currentTime, { ctxSec: when, songMs: 1000 });
    const first = clicks().map((s) => s.started[0]);
    assert.deepEqual(first, [1000, 1100].filter((t) => t < rendered + LOOKAHEAD_MS).map((t) => contextTimeFor(t, { ctxSec: when, songMs: 1000 })));
    ctx.currentTime += 0.1;
    tick();
    ctx.currentTime += 0.1;
    tick();
    tick();
    const times = clicks().map((s) => Math.round(songMsAt(s.started[0], { ctxSec: when, songMs: 1000 })));
    assert.deepEqual(times, [...new Set(times)], "no click twice");
    assert.ok(times.includes(1200) && times.includes(1300), times.join());
    assert.ok(!times.includes(1500), "not further than the look-ahead");
});

test("pause stops the song and the clicks still waiting; now() and seek work paused and playing", () => {
    const { ctx, player, timers, clicks, songSources } = setup();
    player.setHitClicks([5000, 5100, 5200]);
    player.seek(5000);
    player.play();
    const [when] = songSources()[0].started;
    ctx.currentTime = when + 0.5; // half a second heard
    assert.equal(Math.round(player.now()), 5500);
    player.pause();
    assert.equal(player.playing, false);
    assert.equal(songSources()[0].stopped, true);
    assert.equal(clicks().length, 0, "waiting clicks were stopped");
    assert.equal(timers.size, 0);
    assert.equal(Math.round(player.now()), 5500);
    player.seek(20000);
    assert.equal(player.now(), 20000);
    player.seek(-5);
    assert.equal(player.now(), 0);
    player.seek(1e9);
    assert.equal(player.now(), 60000);

    player.seek(1000);
    player.play();
    player.seek(30000);
    const last = songSources().at(-1);
    assert.equal(last.started[1], 30, "a seek while playing restarts at the new place");
    assert.equal(songSources().filter((s) => !s.stopped).length, 1);
    assert.equal(player.playing, true);
});

test("the clock follows the output latency", () => {
    const { ctx, player, songSources } = setup();
    ctx.outputLatency = 0.1;
    player.seek(2000);
    player.play();
    const [when] = songSources()[0].started;
    ctx.currentTime = when + 0.5;
    assert.equal(Math.round(player.now()), 2400, "0.5 s rendered, 0.1 s of it not heard yet");
    ctx.currentTime = when + 0.05;
    assert.equal(player.now(), 2000, "not before the start");
});

test("playFrom: a window with its own clicks (accented), then back to where it began", () => {
    const { ctx, player, tick, clicks, songSources } = setup();
    player.setHitClicks([30000, 30050]);
    const events = [];
    player.subscribe((e) => events.push(e.playing));
    player.playFrom(30, 8, { clicks: [{ t: 30000, accent: true }, { t: 30100 }, { t: 40000 }] });
    const src = songSources()[0];
    assert.equal(src.started[1], 30);
    assert.equal(src.started[2], 8);
    for (let i = 0; i < 30; i += 1) { ctx.currentTime += 0.05; tick(); }
    const heard = clicks().map((s) => Math.round(songMsAt(s.started[0], { ctxSec: src.started[0], songMs: 30000 })));
    assert.deepEqual(heard, [30000, 30100], "only the window's own clicks, none past its end");
    assert.notEqual(clicks()[0].buffer, clicks()[1].buffer, "the accented click sounds different");
    src.onended();
    assert.equal(player.playing, false);
    assert.equal(player.now(), 30000);
    assert.deepEqual(events, [true, false]);
});

test("the song ending by itself stops the player at the end", () => {
    const { player, songSources } = setup();
    player.seek(59000);
    player.play();
    songSources()[0].onended();
    assert.equal(player.playing, false);
    assert.equal(player.now(), 60000);
});

test("nothing loaded: play does nothing", () => {
    const player = createAudioPlayer({ createContext: () => fakeContext(), setTimer: () => 1, clearTimer() {} });
    player.play();
    assert.equal(player.playing, false);
    assert.equal(player.now(), 0);
    assert.equal(player.durationMs, 0);
});
