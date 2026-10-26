// Interlude followed live: interlude-reader's lines (recorded against the fake Interlude into
// tests/fixtures/interlude-reader-lines.json by tools/record-interlude-lines.mjs) through the app's parts —
// the overlay adapter (src/overlay/interludeData.js) and a whole play in the overlay session, the reader process with
// its restarts (app/interludeReader.js, a fake child process), the card following the selection and its priority
// against osu! (app/interludeLive.js + the selection controller), the error texts in both languages, the settings in
// interlude.json, and the overlay windows kept up when Windows minimizes or hides them.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapJudgements, readInterludeFrame, readEvent, pressTime, shortJudgement, chartTimeNotes } from "../src/overlay/interludeData.js";
import { createOverlaySession } from "../src/overlay/session.js";
import { parseManiaNotes } from "../src/overlay/maniaNotes.js";
import { unstableRate } from "../src/overlay/format.js";
import { createReaderProcess, parseReaderLine, readerArgs, restartDelay, BACKOFF } from "../app/interludeReader.js";
import { createInterludeLive, liveText } from "../app/interludeLive.js";
import { createInterludeClient, liveSettingsOf } from "../app/interludeClient.js";
import { createInterludeHandlers } from "../app/interludeIpc.js";
import { createSelectionController } from "../app/selectionController.js";
import { createJsonStore } from "../app/jsonStore.js";
import { createOverlay, KEEP_UP_MS } from "../app/overlay/overlayManager.js";
import { renderView } from "../app/renderer/view.js";
import { makeChart } from "./fixtures/makeChart.js";
import { makeInterludeFolder } from "./fixtures/interludeFolder.js";
import { setLang, t } from "../src/i18n/i18n.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(readFileSync(path.join(here, "fixtures", "interlude-reader-lines.json"), "utf8"));
const lines = recorded.session.map((l) => ({ at: l.at, msg: JSON.parse(l.line) }));
const states = lines.filter((l) => !l.msg.status);
const plays = states.filter((l) => l.msg.play);
const tick = () => new Promise((r) => setImmediate(r));
const temp = (name) => mkdtemp(path.join(tmpdir(), `${name}-`));

// ---- the recorded lines ----

test("the recorded session has what the app relies on: attach, selections, two plays with events, score, waiting", () => {
    assert.equal(lines[0].msg.status, "attached");
    assert.ok(states.some((l) => l.msg.chart?.hash === "hashA"));
    assert.ok(states.some((l) => l.msg.chart?.hash === "hashB" && l.msg.chart.rate === 1.25));
    assert.deepEqual([...new Set(plays.map((l) => l.msg.play.playId))], [1, 2]);
    assert.ok(plays.reduce((n, l) => n + l.msg.play.events.length, 0) > 20);
    assert.ok(states.some((l) => l.msg.screen === "score" && l.msg.play === null));
    assert.equal(lines.at(-1).msg.status, "waiting");
    assert.equal(JSON.parse(recorded.fieldError).code, "field_not_found");
    assert.equal(JSON.parse(recorded.dacError).code, "dac_not_found");
    assert.equal(parseReaderLine("not json"), null);
    assert.equal(parseReaderLine('{"v":2}'), null);
    assert.equal(parseReaderLine(recorded.fieldError).code, "field_not_found");
});

// ---- the adapter ----

test("adapter: a play line → a session frame (chart time, rate, six slots, Interlude's accuracy in percent, events, keys)", () => {
    const line = plays.find((l) => l.msg.play.events.length > 0).msg;
    const f = readInterludeFrame(line);
    assert.equal(f.state, "playing");
    assert.equal(f.client, "interlude");
    assert.equal(f.checksum, "interlude:hashB");
    assert.equal(f.rate, 1.25);
    assert.equal(f.liveMs, line.play.timeMs);
    assert.equal(f.playId, line.play.playId);
    assert.deepEqual(Object.values(f.hits), line.play.judgements);
    assert.ok(Math.abs(f.accuracy - line.play.accuracy * 100) < 1e-9);
    assert.deepEqual(f.judgeNames.labels, ["MARV", "PERF", "GREAT", "GOOD", "BAD", "MISS"]);
    assert.equal(f.judgeNames.ruleset, "SC (J4)");
    const e = f.events[0];
    assert.deepEqual(Object.keys(e).sort(), ["col", "delta", "index", "judgement", "kind", "missed", "t"]);
    assert.equal(pressTime({ t: 500, delta: -4, missed: false }, 1.25), 495);
    assert.equal(pressTime({ t: 500, delta: null, missed: true }, 1.25), 500);
    assert.equal(readEvent({ t: "x", c: 1 }), null);
    // level select, score and others
    assert.equal(readInterludeFrame(states[2].msg).state, "songselect");
    const score = readInterludeFrame(states.find((l) => l.msg.screen === "score").msg);
    assert.equal(score.state, "results");
    assert.equal(score.hits, null, "no numbers of its own: the session keeps the play's");
    assert.equal(readInterludeFrame({ screen: "mainmenu" }).state, "menu");
    assert.equal(readInterludeFrame({ screen: "play", play: null }).state, "other", "a play screen without a play object is not a play");
});

test("adapter: rulesets that don't have six judgements keep their own rows; long names are shortened", () => {
    const five = mapJudgements({ hits: { PERFECT: 10, GREAT: 4, GOOD: 2, BAD: 1, MISS: 3 } });
    assert.equal(five.mapped, false);
    assert.equal(five.labels, null);
    assert.deepEqual(five.names, ["PERFECT", "GREAT", "GOOD", "BAD", "MISS"]);
    assert.deepEqual(five.hits, { max: 10, n300: 4, n200: 2, n100: 1, n50: 0, miss: 3 });
    const eight = mapJudgements({ hits: { A: 1, B: 1, C: 1, D: 1, E: 1, F: 2, G: 3, X: 9 } });
    assert.deepEqual(eight.hits, { max: 1, n300: 1, n200: 1, n100: 1, n50: 6, miss: 9 });
    assert.deepEqual(mapJudgements({ judgements: [1, 2, 3, 4, 5, 6] }).names, ["J1", "J2", "J3", "J4", "J5", "J6"]);
    assert.equal(shortJudgement("MARVELLOUS"), "MARV");
    assert.equal(shortJudgement("300g"), "300g");
    assert.equal(shortJudgement("Fantastic"), "FANT");
    assert.equal(shortJudgement("Wonderful"), "Wonde.");
});

test("adapter: the chart's notes on the reader's clock (0 at the first note)", () => {
    const parsed = parseManiaNotes(makeChart({ kind: "stream", bpm: 300, seconds: 2 }));
    const rel = chartTimeNotes(parsed);
    assert.equal(rel.notes[0].t, 0);
    assert.equal(rel.notes[1].t, parsed.notes[1].t - parsed.notes[0].t);
    assert.equal(rel.keys, 4);
    assert.deepEqual(chartTimeNotes(null).notes, []);
});

// ---- the overlay session from Interlude's frames ----

test("session: a play from Interlude's frames — real presses for KPS and the key lines, UR from the deltas, NPS from the chart, a retry by play id, the results", () => {
    const s = createOverlaySession();
    const notes = chartTimeNotes(parseManiaNotes(makeChart({ kind: "stream", bpm: 300, seconds: 100 })));
    let wanted = null;
    let presses = 0;
    const deltas = [];
    for (const l of states) {
        const f = readInterludeFrame(l.msg);
        if (f.playId === 2) break;
        const r = s.onFrame(f, l.at);
        if (r.mapWanted) {
            wanted = r.mapWanted;
            s.setMap(r.mapWanted, notes);
        }
        for (const e of f.events ?? []) {
            if (!e.missed && e.kind === "hit") presses += 1;
            if (!e.missed && e.delta !== null && e.judgement !== null) deltas.push(e.delta);
        }
    }
    assert.equal(wanted, "interlude:hashB", "the chart's notes are asked for");
    const last = plays.filter((l) => l.msg.play.playId === 1).at(-1);
    const snap = s.snapshot(last.at);
    assert.equal(s.phase(), "playing");
    assert.equal(snap.rate, 1.25);
    assert.deepEqual(Object.values(snap.hits), last.msg.play.judgements);
    assert.ok(Math.abs(snap.accuracy - last.msg.play.accuracy * 100) < 1e-9);
    assert.equal(snap.lanes.source, "keys");
    assert.equal(snap.lanes.counts.reduce((a, b) => a + b, 0), presses, "one press per hit event");
    assert.ok(snap.kps.max > 0);
    assert.ok(Math.abs(snap.ur - unstableRate(deltas)) < 1e-6, `UR ${snap.ur} vs ${unstableRate(deltas)}`);
    assert.equal(snap.nps.ready, true);
    assert.ok(snap.nps.peak > 20 && snap.nps.peak < 30, `20 notes a second at 1.25× → about 25 (${snap.nps.peak})`);
    assert.equal(snap.judgeNames.mapped, true);
    // the retry: play id 2 starts over even though the map is the same
    const retryAt = plays.find((l) => l.msg.play.playId === 2);
    s.onFrame(readInterludeFrame(retryAt.msg), retryAt.at);
    const after = s.snapshot(retryAt.at);
    assert.ok(after.lanes.counts.reduce((a, b) => a + b, 0) < presses);
    assert.ok(after.kps.max < snap.kps.max || after.kps.max === 0);
    assert.equal(after.nps.ready, true, "the same chart keeps its notes");
    // the score screen: results with the play's numbers
    let lastHits = null;
    for (const l of states.slice(states.indexOf(retryAt))) {
        const f = readInterludeFrame(l.msg);
        if (f.state === "playing") lastHits = l.msg.play.judgements;
        s.onFrame(f, l.at + 1000);
        if (f.state === "results") break;
    }
    assert.equal(s.phase(), "results");
    assert.deepEqual(Object.values(s.snapshot(0).hits), lastHits);
});

test("session: Interlude's score screen opened from level select shows nothing; holds and ghost taps", () => {
    const s = createOverlaySession();
    s.onFrame(readInterludeFrame({ screen: "score", chart: { hash: "h" }, play: null }), 0);
    assert.equal(s.phase(), "idle");
    const play = (timeMs, events, keysDown = []) => ({ screen: "play", chart: { hash: "h", keys: 4 }, play: {
        playId: 1, timeMs, rate: 1, hits: { A: 1, B: 0, C: 0, D: 0, E: 0, MISS: 0 }, accuracy: 1, events, keysDown } });
    s.onFrame(readInterludeFrame(play(0, [])), 0);
    s.onFrame(readInterludeFrame(play(100, [{ i: 0, t: 100, c: 1, k: "hold", d: 0, j: 0, m: false }], [1])), 100);
    let snap = s.snapshot(100);
    assert.deepEqual(snap.lanes.pressed, [false, true, false, false]);
    s.onFrame(readInterludeFrame(play(300, [], [1])), 300);
    assert.equal(s.snapshot(300).lanes.pressed[1], true, "still held");
    s.onFrame(readInterludeFrame(play(400, [{ i: 0, t: 420, c: 1, k: "release", d: -20, j: 0, m: false }, { i: -1, t: 410, c: 3, k: "ghosttap" }], [3])), 400);
    snap = s.snapshot(400);
    assert.equal(snap.lanes.bars.find((b) => b.col === 1).end, 400);
    assert.deepEqual(snap.lanes.counts, [0, 1, 0, 1], "a ghost tap is a press too");
});

// ---- the reader process ----

function fakeSpawner() {
    const children = [];
    const spawn = (file, args, opts) => {
        const child = new EventEmitter();
        child.pid = 1000 + children.length;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.file = file;
        child.args = args;
        child.opts = opts;
        child.killed = false;
        child.kill = () => { child.killed = true; child.emit("exit", null); };
        // stdin closing: the reader exits 0 by itself
        child.stdin.on("finish", () => setImmediate(() => child.emit("exit", 0)));
        children.push(child);
        return child;
    };
    return { spawn, children };
}

function fakeTimers() {
    let now = 0;
    const timers = [];
    return {
        now: () => now,
        setTimer: (fn, ms) => { const h = { fn, at: now + ms }; timers.push(h); return h; },
        clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
        advance(ms) {
            now += ms;
            for (const h of [...timers].sort((a, b) => a.at - b.at)) {
                if (h.at <= now && timers.includes(h)) {
                    timers.splice(timers.indexOf(h), 1);
                    h.fn();
                }
            }
        },
        pending: () => timers.map((h) => h.at - now),
    };
}

test("reader process: lines parsed, stdin a pipe, restarts after crashes with a growing pause, stops by closing stdin", async () => {
    const { spawn, children } = fakeSpawner();
    const clock = fakeTimers();
    const got = [];
    const st = [];
    let download = false;
    const r = createReaderProcess({
        exe: () => "C:\\app\\interlude-reader.exe", args: () => readerArgs({ allowDownload: download }), spawn, exists: () => true,
        onMessage: (m) => got.push(m), onState: (s) => st.push(s), setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    });
    r.start();
    r.start();
    assert.equal(children.length, 1, "started once");
    assert.deepEqual(children[0].args, [], "no --allow-download unless allowed");
    assert.deepEqual(children[0].opts.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(children[0].opts.windowsHide, true);
    for (const l of lines.slice(0, 4)) children[0].stdout.write(`${JSON.stringify(l.msg)}\r\n`);
    children[0].stdout.write("garbage\n");
    await tick();
    assert.equal(got.length, 4);
    assert.equal(got[0].status, "attached");
    // crashes: 1 s, 2 s, 4 s …
    const delays = [];
    for (let i = 0; i < 4; i += 1) {
        children.at(-1).emit("exit", 3);
        delays.push(clock.pending()[0]);
        clock.advance(clock.pending()[0]);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
    assert.equal(children.length, 5);
    assert.equal(st.filter((s) => s.state === "crashed").length, 4);
    assert.equal(restartDelay(20), BACKOFF.maxMs);
    // a run that lasted: back to the base pause
    clock.advance(BACKOFF.stableMs + 1);
    children.at(-1).emit("exit", 1);
    assert.equal(clock.pending()[0], 1000);
    clock.advance(1000);
    // the download setting: a new process with the flag
    download = true;
    const before = children.length;
    await r.restart();
    assert.equal(children.length, before + 1);
    assert.deepEqual(children.at(-1).args, ["--allow-download"]);
    // stop: stdin closed, no restart
    await r.stop();
    assert.equal(children.at(-1).stdin.writableEnded, true);
    assert.equal(st.at(-1).state, "stopped");
    clock.advance(120_000);
    assert.equal(children.length, before + 1, "never started again once stopped");
    assert.equal(r.running(), false);
});

test("reader process: a missing exe is told, not retried in a loop; a stuck reader is killed on stop", async () => {
    const st = [];
    const r = createReaderProcess({ exe: () => "C:\\nope.exe", exists: () => false, spawn: () => { throw new Error("no"); }, onState: (s) => st.push(s) });
    r.start();
    assert.equal(st[0].state, "missing");
    const { spawn, children } = fakeSpawner();
    const r2 = createReaderProcess({ exe: () => "x.exe", exists: () => true, spawn: (...a) => {
        const c = spawn(...a);
        c.stdin.removeAllListeners("finish"); // a reader that ignores stdin closing
        return c;
    } });
    r2.start();
    await r2.stop();
    assert.equal(children[0].killed, true);
});

// ---- the live coordinator: selection → card, priority, texts ----

function fakeClient({ library = new Map(), linked = true } = {}) {
    const calls = { forget: 0, select: [], cleared: 0 };
    let refreshed = new Map();
    return {
        calls,
        addAfterRefresh: (hash, meta) => refreshed.set(hash, meta),
        status: async () => ({ linked }),
        library: {
            meta: async (hash) => library.get(hash) ?? null,
            forget: () => {
                calls.forget += 1;
                for (const [k, v] of refreshed) library.set(k, v);
                refreshed = new Map();
            },
        },
        select: async (hash) => { calls.select.push(hash); return { hash, text: `osu text of ${hash}`, label: hash }; },
        clearSelection: () => { calls.cleared += 1; },
    };
}

const instantTimers = { setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {} };

test("live: a selection goes on the card at its rate, once per change; not in the library → read again once, then its names", async () => {
    const interlude = fakeClient({ library: new Map([["hashA", { title: "Freedom Dive", artist: "xi", version: "4K Another" }]]) });
    const card = { shown: [], info: [] };
    card.showExternal = (r) => card.shown.push(r);
    card.showInfo = (r) => card.info.push(r);
    const frames = [];
    const live = createInterludeLive({ interlude, card, overlay: () => ({ onInterlude: (m) => frames.push(m) }), ...instantTimers });
    const settle = async () => { for (let i = 0; i < 8; i += 1) await tick(); };
    // line by line, as they come (a quarter of a second or more apart in level select)
    for (const l of states.filter((x) => !x.msg.play).slice(0, 5)) {
        live.onMessage(l.msg);
        await settle();
    }
    assert.equal(card.shown.length, 1);
    assert.equal(card.shown[0].id, "hashA");
    assert.equal(card.shown[0].rate, 1);
    assert.equal(card.shown[0].text, "osu text of hashA");
    // hashB isn't there: the library copy is read again once, then the names from the reader with a note
    assert.equal(interlude.calls.forget >= 1, true);
    const b = card.info.find((i) => i.title === "Blue Zenith" && i.rate === 1.25);
    assert.ok(b, JSON.stringify(card.info));
    assert.equal(b.artist, "xi");
    assert.equal(b.diff, "4K Insane");
    assert.equal(b.note, t("app.interlude.live.notInLibrary"));
    // the play lines repeat the selection 30 times a second: nothing more is put on the card
    const shownBefore = card.shown.length + card.info.length;
    for (const l of plays) live.onMessage(l.msg);
    await tick();
    assert.equal(card.shown.length + card.info.length, shownBefore);
    assert.ok(frames.length >= plays.length, "every state line reaches the overlay");
    assert.equal(live.state().status, "attached");
    live.onMessage(lines.at(-1).msg);
    assert.equal(live.state().status, "waiting");
    assert.equal(frames.at(-1), null, "Interlude gone: the overlay forgets its play");
});

test("live: a chart imported since is found after the copy is read again; no folder linked → the note says to link one", async () => {
    const interlude = fakeClient();
    interlude.addAfterRefresh("hashB", { title: "Blue Zenith" });
    const card = { shown: [], info: [], showExternal: (r) => card.shown.push(r), showInfo: (r) => card.info.push(r) };
    const live = createInterludeLive({ interlude, card, ...instantTimers });
    live.onMessage({ v: 1, client: "interlude", screen: "levelselect", chart: { hash: "hashB", title: "Blue Zenith", rate: 1.1 } });
    for (let i = 0; i < 6; i += 1) await tick();
    assert.equal(interlude.calls.forget, 1);
    assert.equal(card.shown[0]?.id, "hashB");
    assert.equal(card.shown[0].rate, 1.1);
    const unlinked = fakeClient({ linked: false });
    const card2 = { info: [], showExternal: () => assert.fail("nothing to analyse"), showInfo: (r) => card2.info.push(r) };
    const live2 = createInterludeLive({ interlude: unlinked, card: card2, ...instantTimers });
    live2.onMessage({ v: 1, client: "interlude", screen: "levelselect", chart: { hash: "X", title: "T", artist: "A", diff: "D" } });
    for (let i = 0; i < 4; i += 1) await tick();
    assert.equal(card2.info[0].note, t("app.interlude.live.noFolderNote"));
    assert.equal(unlinked.calls.forget, 0);
});

test("live: scrolling past charts only puts the one it stopped on on the card", async () => {
    const pending = [];
    const interlude = fakeClient({ library: new Map([["a", {}], ["b", {}], ["c", {}]]) });
    const card = { shown: [], showExternal: (r) => card.shown.push(r), showInfo: () => {} };
    const live = createInterludeLive({
        interlude, card, setTimer: (fn) => { pending.push(fn); return pending.length; }, clearTimer: (h) => { pending[h - 1] = null; },
    });
    for (const hash of ["a", "b", "c"]) live.onMessage({ v: 1, client: "interlude", screen: "levelselect", chart: { hash, rate: 1 } });
    for (const fn of pending) fn?.();
    for (let i = 0; i < 6; i += 1) await tick();
    assert.deepEqual(card.shown.map((s) => s.id), ["c"]);
});

test("priority: whichever of osu! and Interlude changed its selection last has the card", async () => {
    const views = [];
    const ctrl = createSelectionController({
        fetchOsu: async () => "osu map",
        analyze: async (text, rate) => ({ kind: "ok", label: `${text} @${rate}` }),
        cache: { get: async () => undefined, set: async () => {} },
        onView: (v) => views.push(v),
    });
    const interlude = fakeClient({ library: new Map([["il-1", {}], ["il-2", {}]]) });
    const live = createInterludeLive({ interlude, card: ctrl, ...instantTimers });
    const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };
    const il = (hash, rate = 1) => live.onMessage({ v: 1, client: "interlude", screen: "levelselect", chart: { hash, rate } });
    const osu = (checksum, rate = 1) => ctrl.onFrame({ state: "songselect", checksum, rate });
    const card = () => views.at(-1).result?.label;

    osu("osu-a");
    await settle();
    assert.equal(card(), "osu map @1");
    il("il-1", 1.2); // Interlude changed last
    await settle();
    assert.equal(card(), "osu text of il-1 @1.2");
    osu("osu-a"); // osu!'s frames go on with the same map: Interlude keeps the card
    await settle();
    assert.equal(card(), "osu text of il-1 @1.2");
    il("il-1", 1.2); // the same Interlude line again: nothing
    osu("osu-b"); // osu! changed last
    await settle();
    assert.equal(card(), "osu map @1");
    assert.equal(interlude.calls.cleared, 1, "the Interlude chart stops being the tabs' map");
    il("il-1", 1.3); // a new rate in Interlude is a change
    await settle();
    assert.equal(card(), "osu text of il-1 @1.3");
    il("il-2");
    await settle();
    assert.equal(card(), "osu text of il-2 @1");
});

test("card: a chart only known by name shows its names, rate and note; osu! takes the card back from it too", async () => {
    const views = [];
    let ended = 0;
    const ctrl = createSelectionController({
        fetchOsu: async () => "osu", analyze: async () => ({ kind: "ok", label: "osu" }),
        cache: { get: async () => undefined, set: async () => {} }, onView: (v) => views.push(v),
    });
    ctrl.onFrame({ state: "songselect", checksum: "o1", rate: 1 });
    await tick();
    ctrl.showInfo({ id: "h", rate: 1.25, title: "Blue Zenith", artist: "xi", diff: "4K Insane", note: "not here", onEnd: () => { ended += 1; } });
    assert.equal(views.at(-1).screen, "external-info");
    for (const lang of ["ru", "en"]) {
        setLang(lang);
        const html = renderView(views.at(-1), { compact: false });
        assert.match(html, /xi - Blue Zenith/);
        assert.match(html, /\[4K Insane\]/);
        assert.match(html, /1\.25×/);
        assert.match(html, /not here/);
    }
    setLang("ru");
    ctrl.onFrame({ state: "songselect", checksum: "o1", rate: 1 });
    ctrl.onTosuStatus("down");
    assert.equal(views.at(-1).screen, "external-info");
    ctrl.onFrame({ state: "songselect", checksum: "o2", rate: 1 });
    await tick();
    assert.equal(ended, 1);
    assert.equal(views.at(-1).screen, "result");
});

test("texts: every live state and error code in Russian and English, the DAC hint only while downloading is off", () => {
    const fieldError = JSON.parse(recorded.fieldError);
    const dacError = JSON.parse(recorded.dacError);
    for (const lang of ["ru", "en"]) {
        setLang(lang);
        const texts = {
            off: liveText({ status: "off" }),
            waiting: liveText({ status: "waiting" }),
            attached: liveText({ status: "attached", version: "0.7.28.7" }),
            field: liveText({ status: "attached", code: fieldError.code, reason: fieldError.reason, warn: true }),
            fieldErr: liveText({ status: "error", code: fieldError.code, reason: fieldError.reason }),
            dac: liveText({ status: "error", code: dacError.code, reason: dacError.reason, allowDownload: false }),
            dacAllowed: liveText({ status: "error", code: dacError.code, reason: dacError.reason, allowDownload: true }),
            attach: liveText({ status: "error", code: "attach_failed", reason: "access denied" }),
            other: liveText({ status: "error", code: "runtime_init_failed", reason: "x" }),
            missing: liveText({ status: "missing" }),
            crashed: liveText({ status: "crashed", retryMs: 4000 }),
        };
        for (const [k, v] of Object.entries(texts)) assert.ok(v && !v.includes("{"), `${lang} ${k}: ${v}`);
        assert.match(texts.attached, /0\.7\.28\.7/);
        assert.ok(texts.field.startsWith(t("app.interlude.live.attached", { version: "?" })) && texts.field.includes("SelectedChart._rate"), "attached, and the missing field told");
        assert.match(texts.fieldErr, lang === "ru" ? /Interlude обновился\? Сканер не нашёл/ : /Did Interlude update\? The scanner didn't find/);
        assert.match(texts.fieldErr, /SelectedChart\._rate/);
        assert.ok(texts.dac.includes(t("app.interlude.live.dacHint")));
        assert.ok(!texts.dacAllowed.includes(t("app.interlude.live.dacHint")));
        assert.match(texts.attach, lang === "ru" ? /администратор/ : /administrator/);
        assert.match(texts.crashed, /4/);
    }
    setLang("ru");
});

test("live: status lines → the state the window shows; a missing field keeps it attached with a warning", () => {
    const states_ = [];
    const live = createInterludeLive({ interlude: fakeClient(), card: {}, onState: (s) => states_.push({ ...s }), ...instantTimers });
    live.onReader({ state: "running" });
    assert.equal(live.state().status, "starting");
    live.onMessage(lines[0].msg);
    assert.equal(live.state().status, "attached");
    live.onMessage(JSON.parse(recorded.fieldError));
    assert.equal(live.state().status, "attached");
    assert.equal(live.state().warn, true);
    assert.match(live.text(), /SelectedChart\._rate/);
    live.onMessage({ v: 1, status: "error", code: "attach_failed", reason: "denied" });
    live.onMessage({ v: 1, status: "waiting", reason: "not running" });
    live.onMessage({ v: 1, status: "error", code: "attach_failed", reason: "denied" });
    assert.equal(live.state().status, "error");
    live.onReader({ state: "crashed", retryMs: 2000 });
    assert.equal(live.state().status, "crashed");
    live.off();
    assert.equal(live.state().status, "off");
    assert.ok(states_.length >= 6);
});

// ---- settings in interlude.json ----

test("settings: following is on by default while a folder is linked, can be turned off or on; downloading is off until allowed", async () => {
    assert.deepEqual(liveSettingsOf(null), { live: null, allowDownload: false });
    assert.deepEqual(liveSettingsOf({ live: "yes", allowDownload: 1 }), { live: null, allowDownload: false });
    const dir = await temp("il-live");
    const fx = await makeInterludeFolder({ charts: [{ osuText: makeChart({ seconds: 5 }) }] });
    const file = path.join(dir, "interlude.json");
    const c = createInterludeClient({ store: createJsonStore({ file, fallback: { folder: null } }), docsDir: dir, mapsDir: dir, cacheDir: path.join(dir, "cache") });
    assert.equal((await c.liveSettings()).follow, false, "no folder: not followed");
    await c.link(fx.root);
    assert.equal((await c.liveSettings()).follow, true, "a linked folder: followed by default");
    await c.setLiveSettings({ live: false });
    assert.equal((await c.liveSettings()).follow, false);
    await c.setLiveSettings({ allowDownload: true });
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(saved, { folder: fx.root, live: false, allowDownload: true }, "the folder is kept beside the settings");
    await c.unlink();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { folder: null, live: false, allowDownload: true });
    await c.setLiveSettings({ live: true });
    assert.equal((await c.liveSettings()).follow, true, "turned on: followed even without a folder");
    const h = createInterludeHandlers({ interlude: c, card: null, paths: { docsDir: dir }, live: () => ({ state: { status: "waiting" }, text: "w" }) });
    const info = await h.setLive({ live: false, allowDownload: false, junk: 1 });
    assert.deepEqual(info.settings, { live: false, allowDownload: false, follow: false });
    assert.equal(info.state.status, "waiting");
    assert.equal(info.text, "w");
});

// ---- the overlay windows: Interlude's play, and kept up when Windows takes them away ----

function overlayElectron() {
    const windows = [];
    class BrowserWindow {
        constructor(options) {
            this.options = options;
            this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
            this.calls = [];
            this.handlers = {};
            this.destroyed = false;
            this.visible = false;
            this.minimized = false;
            this.webContents = { send: () => {}, on: () => {}, reload: () => {} };
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; }
        loadFile(file, opts) { this.query = opts?.query; }
        on(name, fn) { (this.handlers[name] ??= []).push(fn); }
        emit(name) { for (const fn of this.handlers[name] ?? []) fn(); }
        setAlwaysOnTop(...a) { this.calls.push(["setAlwaysOnTop", ...a]); }
        setIgnoreMouseEvents() {}
        setFocusable() {}
        setMenu() {}
        showInactive() { this.visible = true; this.minimized = false; this.calls.push(["showInactive"]); }
        hide() { this.visible = false; this.calls.push(["hide"]); }
        minimize() { this.minimized = true; this.emit("minimize"); }
        restore() { this.minimized = false; this.calls.push(["restore"]); }
        isMinimized() { return this.minimized; }
        isVisible() { return this.visible && !this.minimized; }
        moveTop() { this.calls.push(["moveTop"]); }
        getPosition() { return [0, 0]; }
        setBounds() {}
    }
    const ipcMain = { handle: () => {}, on: () => {} };
    const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
    const screen = { getPrimaryDisplay: () => display, getAllDisplays: () => [display], on: () => {} };
    return { electron: { BrowserWindow, ipcMain, globalShortcut: { register: () => true, unregister: () => {} }, screen }, windows, BrowserWindow };
}

test("overlay: Interlude's play shows the widgets (no tosu needed); minimized or hidden by Windows they come back; the app's window minimizing never hides them", async () => {
    const { electron, windows, BrowserWindow } = overlayElectron();
    const main = new BrowserWindow({ width: 400, height: 600 });
    windows.length = 0;
    let clock = 0;
    const every = [];
    const overlay = createOverlay({
        electron, userData: await temp("ov-il"), port: 1, t, now: () => clock, mainWindow: () => main,
        WebSocketImpl: class { addEventListener() {} close() {} }, // no osu!: tosu never answers
        interludeNotes: async () => chartTimeNotes(parseManiaNotes(makeChart({ kind: "stream", bpm: 300, seconds: 100 }))),
        setInterval: (fn, ms) => { every.push({ fn, ms }); return every.length; }, clearInterval: () => {},
    });
    try {
        overlay.apply({ enabled: true });
        for (const l of plays.filter((p) => p.msg.play.playId === 1)) {
            clock = l.at;
            overlay.onInterlude(l.msg);
        }
        await tick();
        const shown = () => windows.filter((w) => overlay.isShown(w.query.w));
        assert.equal(shown().length, 4, "every widget is up during Interlude's play");
        const keepUps = every.filter((e) => e.ms === KEEP_UP_MS);
        assert.equal(keepUps.length, 1, "one watchdog while widgets are up");
        // Win+D / the game minimized: the widget's own minimize puts it back
        const kps = windows.find((w) => w.query.w === "kps");
        kps.minimize();
        await tick();
        assert.equal(kps.isMinimized(), false);
        assert.ok(kps.calls.some((c) => c[0] === "restore"));
        // hidden behind our back: the watchdog shows it again and over the game
        kps.visible = false;
        kps.calls.length = 0;
        keepUps[0].fn();
        assert.equal(kps.isVisible(), true);
        assert.deepEqual(kps.calls.map((c) => c[0]), ["showInactive", "setAlwaysOnTop", "moveTop"]);
        assert.equal(kps.calls[1][2], "screen-saver");
        // the app's own (pinned) window minimized and restored: the widgets stay up and go over it again
        main.minimize();
        main.emit("restore");
        await tick();
        assert.equal(shown().length, 4);
        assert.ok(windows.every((w) => w.visible && !w.minimized));
        assert.ok(windows.every((w) => !w.options.parent), "no parent: never tied to the main window");
        // Interlude gone: the play is over
        overlay.onInterlude(null);
        clock += 2000;
        overlay.onInterlude(null);
        await new Promise((r) => setTimeout(r, 20));
    } finally {
        overlay.dispose();
    }
});
