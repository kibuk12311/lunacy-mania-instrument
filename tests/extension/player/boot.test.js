import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "../../../extension/player/main.js";
import { memoryStorage, STORAGE_KEY } from "../../../extension/player/settings.js";
import { parseParams } from "../../../extension/player/source.js";
import { readZip } from "../../../extension/shared/osz.js";
import { md5Hex } from "../../../extension/shared/md5.js";
import { PLAYER_SOURCE, SITE_ORIGIN } from "../../../extension/shared/protocol.js";
import { buildOsz } from "../../../src/gen/osz.js";
import { makeChart } from "../../fixtures/makeChart.js";
import { fakeDocument, fakeWindow, fakeAudio, flush, byAction, findAll, textOf } from "./helpers/fakePlayer.js";

const chartText = (id = 4961226, version = "stream 180") => makeChart({ kind: "stream", seconds: 20 })
    .replace("Mode: 3", "PreviewTime: 3000\r\nMode: 3")
    .replace(/Version:.*/, `Version:${version}\r\nBeatmapID:${id}`);

function fakeClient({ osz = null, oszError = null } = {}) {
    const calls = { getOsu: 0, getPreview: 0, getOsz: 0 };
    return {
        calls,
        async getOsu({ beatmapId }) { calls.getOsu += 1; return { ok: true, beatmapId, text: chartText(beatmapId), md5: "x", meta: {} }; },
        async getPreview() { calls.getPreview += 1; return { ok: true, bytes: new Uint8Array([79, 103, 103, 83]), contentType: "audio/ogg" }; },
        async getOsz({ onProgress }) {
            calls.getOsz += 1;
            onProgress?.({ received: 10, total: 20 });
            if (oszError && calls.getOsz === 1) return { ok: false, error: { code: oszError } };
            return { ok: true, bytes: osz, contentType: "application/x-osu-beatmap-archive", fileName: "set.osz" };
        },
    };
}

async function setup(hash, { client = fakeClient(), storage = memoryStorage(), duration = 10 } = {}) {
    const win = fakeWindow();
    const doc = fakeDocument();
    const audio = fakeAudio(win, { duration });
    const handle = await boot({ params: parseParams(hash), client, readZip, md5Hex, storage, win, doc, audio });
    await flush();
    const html = doc.documentElement;
    const stats = () => JSON.parse(html.dataset.lmStats);
    // move the clock until chart time t is heard, then press (and release) a lane
    const stepTo = (t) => {
        const { clock } = handle.game;
        const x = clock.startAt + ((t - clock.startChartMs) / clock.rate - clock.offsetMs) / 1000;
        const delta = (x - audio.ctx.currentTime) * 1000;
        if (delta > 0) win.step(delta);
    };
    const KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK"];
    const autoplay = (notes) => {
        const events = [];
        for (const n of notes) {
            events.push({ t: n.t, type: "keydown", col: n.col });
            events.push({ t: n.end ?? n.t + 30, type: "keyup", col: n.col });
        }
        events.sort((a, b) => a.t - b.t || (a.type === "keyup" ? -1 : 1));
        for (const e of events) {
            stepTo(e.t);
            win.fire(e.type, { code: KEYS[e.col] });
        }
    };
    return { win, doc, html, audio, handle, client, storage, stats, stepTo, autoplay };
}

test("preview: loading → ready → countdown → playing → results, a clean run is all MAX", async () => {
    const s = await setup("#set=2316993&map=4961226&src=preview&rate=1&lang=ru&previewWarn=1&login=0");
    assert.equal(s.html.dataset.lmPlayer, "ready");
    assert.equal(s.html.getAttribute("lang"), "ru");
    assert.equal(s.client.calls.getOsu, 1);
    assert.equal(s.client.calls.getPreview, 1);
    assert.equal(s.client.calls.getOsz, 0);
    assert.match(textOf(s.doc.root), /Превью общее для набора/);
    const notes = s.handle.loaded.notes;
    assert.ok(notes.length > 50);
    assert.ok(notes.every((n) => n.t >= 3000 && n.t <= 12700));
    assert.equal(s.stats().notes, notes.length);

    s.win.fire("keydown", { code: "Space" });
    await flush();
    assert.equal(s.html.dataset.lmPlayer, "countdown");
    const play = s.audio.played.find((p) => p !== "stop");
    assert.equal(play.rate, 1);
    assert.equal(play.bufferOffset, 0); // the preview starts 1.5 s before its own audio
    assert.ok(Math.abs(play.when - (s.handle.game.clock.startAt + 1.5)) < 1e-9); // audio 0 = PreviewTime, 1.5 s in

    s.win.step(1000);
    assert.equal(s.html.dataset.lmPlayer, "countdown"); // the first note (at PreviewTime) is still 0.5 s away
    s.autoplay(notes);
    assert.equal(s.html.dataset.lmPlayer, "playing");
    for (let i = 0; i < 40 && s.html.dataset.lmPlayer === "playing"; i += 1) s.win.step(100);
    assert.equal(s.html.dataset.lmPlayer, "results");
    const st = s.stats();
    assert.equal(st.max, notes.length);
    assert.equal(st.miss, 0);
    assert.equal(st.acc, 100);
    assert.equal(st.maxCombo, notes.length);
    assert.match(textOf(s.doc.root), /Результат/);

    s.win.fire("keydown", { code: "KeyR" });
    await flush();
    assert.equal(s.html.dataset.lmPlayer, "countdown");
    assert.equal(s.stats().max, 0);
});

test("misses count when nothing is pressed; rate 1.5 from the page; Esc closes with the page's origin", async () => {
    const s = await setup("#set=1&map=2&src=preview&rate=1.5&lang=en");
    assert.equal(s.handle.settings.rate, 1.5);
    s.win.fire("keydown", { code: "Enter" });
    await flush();
    for (let i = 0; i < 120 && s.html.dataset.lmPlayer !== "results"; i += 1) s.win.step(100);
    assert.equal(s.html.dataset.lmPlayer, "results");
    const st = s.stats();
    assert.equal(st.miss, st.notes);
    assert.equal(st.acc, 0);
    s.win.fire("keydown", { code: "Escape" });
    assert.deepEqual(s.win.posted, [{ message: { source: PLAYER_SOURCE, type: "close" }, origin: SITE_ORIGIN }]);
});

test("blur pauses (audio suspended, chart stops), Space resumes; offset keys nudge and are saved", async () => {
    const s = await setup("#set=1&map=2&src=preview&lang=en");
    s.win.fire("keydown", { code: "Space" });
    await flush();
    s.win.step(2000);
    assert.equal(s.html.dataset.lmPlayer, "playing");
    s.win.fire("keydown", { code: "Equal" });
    s.win.fire("keydown", { code: "Minus", shiftKey: true });
    assert.equal(s.handle.settings.offsetMs, 4);
    assert.equal(s.handle.game.clock.offsetMs, 4);
    await flush();
    assert.equal(s.storage.data[STORAGE_KEY].offsetMs, 4);
    s.win.fire("blur");
    await flush();
    assert.equal(s.html.dataset.lmPlayer, "paused");
    const frozen = s.audio.ctx.currentTime;
    s.win.step(5000);
    assert.equal(s.audio.ctx.currentTime, frozen);
    s.win.fire("keydown", { code: "Space" });
    await flush();
    assert.equal(s.html.dataset.lmPlayer, "playing");
});

test("full map: nothing is downloaded before «Скачать с osu!»; login error offers the file fallback", async () => {
    const osz = buildOsz([{ name: "a [x].osu", data: Buffer.from(chartText(2, "Hard").replace("audio.mp3", "Audio.MP3")) }, { name: "audio.mp3", data: Buffer.from("ID3") }]);
    const client = fakeClient({ osz: new Uint8Array(osz), oszError: "login" });
    const s = await setup("#set=1&map=2&src=full&lang=ru&login=0", { client });
    assert.equal(s.html.dataset.lmPlayer, "loading");
    assert.equal(s.html.dataset.lmWait, "download");
    assert.equal(client.calls.getOsz, 0);
    assert.match(textOf(s.doc.root), /лимит загрузок osu!/);
    assert.match(textOf(s.doc.root), /не вошёл/);
    byAction(s.doc.root, "download").click();
    await flush();
    assert.equal(client.calls.getOsz, 1);
    assert.equal(s.html.dataset.lmPlayer, "error");
    assert.equal(s.html.dataset.lmError, "login");
    assert.match(textOf(s.doc.root), /Войди на osu\.ppy\.sh в этом браузере — или перетащи \.osz сюда/);
    assert.ok(byAction(s.doc.root, "pick-file"));
    byAction(s.doc.root, "to-full").click();
    await flush();
    assert.equal(client.calls.getOsz, 1); // back to the offer, still no download
    byAction(s.doc.root, "download").click();
    await flush(12);
    assert.equal(client.calls.getOsz, 2);
    assert.equal(s.html.dataset.lmPlayer, "ready");
    assert.equal(s.handle.loaded.chart.version, "Hard");
    assert.equal(s.handle.loaded.audioZeroChartMs, 0);
});

test("dropped .osz without this map: a list to choose from; a broken file → not-zip", async () => {
    const osz = buildOsz([
        { name: "a.osu", data: Buffer.from(chartText(31, "Easy")) },
        { name: "b.osu", data: Buffer.from(chartText(32, "Insane")) },
        { name: "audio.mp3", data: Buffer.from("ID3") },
    ]);
    const s = await setup("#set=1&map=2&src=file&lang=en");
    assert.equal(s.html.dataset.lmWait, "file");
    const file = (bytes, name = "x.osz") => ({ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    await s.handle.handleFile(file(new Uint8Array(osz)));
    await flush();
    assert.equal(s.html.dataset.lmWait, "choose");
    const choices = findAll(s.doc.root, (n) => n.dataset?.lmChoice !== undefined);
    assert.deepEqual(choices.map((c) => c.textContent), ["Easy", "Insane"]);
    choices[1].click();
    await flush(12);
    assert.equal(s.html.dataset.lmPlayer, "ready");
    assert.equal(s.handle.loaded.chart.version, "Insane");
    await s.handle.handleFile(file(new Uint8Array([1, 2, 3])));
    await flush();
    assert.equal(s.html.dataset.lmError, "not-zip");
});

test("errors by code: 7K map → keys, no preview time → no-preview, bad audio → decode", async () => {
    const seven = { async getOsu() { return { ok: true, text: makeChart({ keys: 7, seconds: 5 }).replace("Mode: 3", "PreviewTime: 1\r\nMode: 3") }; }, async getPreview() { return { ok: true, bytes: new Uint8Array(1) }; } };
    let s = await setup("#set=1&map=2", { client: seven });
    assert.equal(s.html.dataset.lmError, "keys");
    const noPreview = { async getOsu() { return { ok: true, text: makeChart({ seconds: 5 }) }; }, async getPreview() { throw new Error("must not be called"); } };
    s = await setup("#set=1&map=2", { client: noPreview });
    assert.equal(s.html.dataset.lmError, "no-preview");
    const offline = { async getOsu() { return { ok: false, error: { code: "network" } }; } };
    s = await setup("#set=1&map=2", { client: offline });
    assert.equal(s.html.dataset.lmError, "network");
    assert.ok(byAction(s.doc.root, "retry"));
    s = await setup("#src=preview");
    assert.equal(s.html.dataset.lmError, "bad-request");
});

test("rebinding from the settings panel saves the keys and plays with them", async () => {
    const s = await setup("#set=1&map=2&src=preview&lang=en");
    s.handle; // ready
    byAction(s.doc.root, "settings").click();
    assert.doesNotMatch(textOf(s.doc.root), /null|undefined/);
    byAction(s.doc.root, "rebind").click();
    for (const code of ["Space", "KeyS", "KeyS", "KeyD", "KeyK", "KeyL"]) s.win.fire("keydown", { code });
    await flush();
    assert.deepEqual(s.handle.settings.keys, ["KeyS", "KeyD", "KeyK", "KeyL"]);
    assert.deepEqual(s.storage.data[STORAGE_KEY].keys, ["KeyS", "KeyD", "KeyK", "KeyL"]);
    assert.equal(s.html.dataset.lmPlayer, "ready"); // Space while rebinding did not start
    s.win.fire("keydown", { code: "Space" });
    await flush();
    const first = s.handle.loaded.notes[0];
    s.stepTo(first.t);
    s.win.fire("keydown", { code: ["KeyS", "KeyD", "KeyK", "KeyL"][first.col] });
    assert.equal(s.stats().max, 1);
});

test("an unfinished rebind ends with the panel: lanes judge, Space pauses, one Esc closes", async () => {
    const s = await setup("#set=1&map=2&src=preview&lang=en");
    byAction(s.doc.root, "settings").click();
    byAction(s.doc.root, "rebind").click();
    s.win.fire("keydown", { code: "KeyS" }); // one key of four, then the panel is closed
    byAction(s.doc.root, "settings-close").click();
    byAction(s.doc.root, "start").click();
    await flush();
    assert.equal(s.html.dataset.lmPlayer, "countdown");
    const first = s.handle.loaded.notes[0];
    s.stepTo(first.t);
    s.win.fire("keydown", { code: ["KeyD", "KeyF", "KeyJ", "KeyK"][first.col] });
    assert.equal(s.stats().max, 1);
    s.win.fire("keydown", { code: "Space" });
    await flush();
    assert.equal(s.html.dataset.lmPlayer, "paused");
    s.win.fire("keydown", { code: "Escape" });
    assert.equal(s.win.posted.length, 1);
    assert.deepEqual(s.handle.settings.keys, ["KeyD", "KeyF", "KeyJ", "KeyK"]);
});

test("a rebind left open is also cancelled when the game starts with the panel open", async () => {
    const s = await setup("#set=1&map=2&src=preview&lang=en");
    byAction(s.doc.root, "settings").click();
    byAction(s.doc.root, "rebind").click();
    byAction(s.doc.root, "start").click(); // the ready screen behind the panel
    await flush();
    assert.equal(s.html.dataset.lmPlayer, "countdown");
    const first = s.handle.loaded.notes[0];
    s.stepTo(first.t);
    s.win.fire("keydown", { code: ["KeyD", "KeyF", "KeyJ", "KeyK"][first.col] });
    assert.equal(s.stats().max, 1);
});

test("blur while the audio unlock is still pending: back to ready, and the next start plays", async () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const audio = fakeAudio(win, { duration: 10 });
    const orig = audio.unlock.bind(audio);
    let release = null;
    audio.unlock = () => (release ? orig() : new Promise((r) => { release = async () => { await orig(); r(); }; }));
    const handle = await boot({ params: parseParams("#set=1&map=2&src=preview&lang=en"), client: fakeClient(), readZip, md5Hex, storage: memoryStorage(), win, doc, audio });
    await flush();
    const html = doc.documentElement;
    win.fire("keydown", { code: "Space" });
    await flush();
    assert.equal(html.dataset.lmPlayer, "countdown");
    win.fire("blur");
    await flush();
    assert.equal(html.dataset.lmPlayer, "ready");
    await release();
    await flush();
    assert.equal(html.dataset.lmPlayer, "ready");
    assert.equal(handle.game, null);
    win.fire("keydown", { code: "Space" });
    await flush();
    assert.equal(html.dataset.lmPlayer, "countdown");
    assert.ok(handle.game);
    win.step(3000);
    assert.equal(html.dataset.lmPlayer, "playing");
});

test("blur during the unlock, then a second start before the first unlock settles: one game, one audio start", async () => {
    const win = fakeWindow();
    const doc = fakeDocument();
    const audio = fakeAudio(win, { duration: 10 });
    const orig = audio.unlock.bind(audio);
    const releases = [];
    audio.unlock = () => new Promise((r) => { releases.push(async () => { await orig(); r(); }); });
    const handle = await boot({ params: parseParams("#set=1&map=2&src=preview&lang=en"), client: fakeClient(), readZip, md5Hex, storage: memoryStorage(), win, doc, audio });
    await flush();
    const html = doc.documentElement;
    win.fire("keydown", { code: "Space" });
    await flush();
    win.fire("blur");
    await flush();
    assert.equal(html.dataset.lmPlayer, "ready");
    win.fire("keydown", { code: "Space" }); // the second start: its unlock is pending too
    await flush();
    assert.equal(html.dataset.lmPlayer, "countdown");
    assert.equal(releases.length, 2);
    await releases[0](); // the stale first start wakes up while the second one is in countdown
    await flush();
    assert.equal(handle.game, null, "the stale start built nothing");
    assert.equal(audio.played.filter((p) => p !== "stop").length, 0);
    await releases[1]();
    await flush();
    const game = handle.game;
    assert.ok(game);
    assert.equal(audio.played.filter((p) => p !== "stop").length, 1, "the audio started once");
    win.step(3000);
    assert.equal(html.dataset.lmPlayer, "playing");
    assert.equal(handle.game, game);
});

test("a dropped .osz during the download aborts the download", async () => {
    const osz = buildOsz([{ name: "a.osu", data: Buffer.from(chartText(2)) }, { name: "audio.mp3", data: Buffer.from("ID3") }]);
    let signal = null;
    const client = {
        ...fakeClient(),
        getOsz(args) {
            signal = args.signal;
            return new Promise((r) => args.signal.addEventListener("abort", () => r({ ok: false, error: { code: "cancelled" } })));
        },
    };
    const s = await setup("#set=1&map=2&src=full&lang=en", { client });
    byAction(s.doc.root, "download").click();
    await flush();
    assert.equal(signal.aborted, false);
    s.doc.fire("drop", { dataTransfer: { types: ["Files"], files: [{ name: "set.osz", size: osz.length, arrayBuffer: async () => new Uint8Array(osz).buffer }] } });
    await flush(12);
    assert.equal(signal.aborted, true);
    assert.equal(s.html.dataset.lmPlayer, "ready");
});
