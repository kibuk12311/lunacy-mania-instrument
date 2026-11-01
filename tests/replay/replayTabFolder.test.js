// The Replay tab and the folder, through the fake DOM with main's real replay service where a replay has to open: the tab
// looks again when osu! starts after it was first shown, an answer with no skins is not kept for good, a pick or a reset
// made anywhere rereads the list and the skin select at once, keeping the skin chosen, a refused pick is said, a late answer
// does not win, and the line under the stage keeps the song's note and the skin's apart.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { makeOsr, honestPresses, rollNotes, chartText } from "../fixtures/makeOsr.js";
import { createReplayService } from "../../app/replayIpc.js";
import { createSongsMd5Index } from "../../app/osuSongsScan.js";
import { initReplayTab, onReplayTabShown } from "../../app/renderer/replayTab.js";
import { setLang, t as text } from "../../src/i18n/i18n.js";

const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => { setImmediate(r); }); };
const FOLDER = "D:\\Games\\osu!";
const item = { file: `${FOLDER}\\Replays\\a.osr`, md5: "a".repeat(32), kind: "exported", at: 1, modNames: [], rate: 1, accuracy: 99, miss: 0, score: 1, title: "A Map", artist: "Test", version: "One" };
const noFolder = { ok: true, folder: null, source: null, picked: null, items: [] };
const inFolder = { ok: true, folder: FOLDER, source: "tosu", picked: null, items: [item] };
const noSkins = { ok: true, skins: [], current: null, chosen: null, name: null, config: null, images: {}, mania4: false };
const someSkins = { ...noSkins, skins: ["One", "Two"], current: "One", chosen: "One", name: "One", mania4: true };

function mount({ list = noFolder, skin = noSkins, storage = {} } = {}) {
    setLang("en");
    const on = {};
    const asked = { list: 0, skin: 0, skins: [] };
    const state = { list, skin };
    const api = {
        replayList: async () => { asked.list += 1; return state.list; },
        replaySkin: async (request) => { asked.skin += 1; asked.skins.push(request); return state.skin; },
        onReplayProgress: (cb) => { on.progress = cb; }, onReplayEnded: () => {}, onReplayFolder: (cb) => { on.folder = cb; },
    };
    const dom = fakeDom(api, { storage });
    globalThis.Option = class { constructor(label, value) { this.textContent = label; this.value = value; this.children = []; } };
    dom.$("rp-manip").querySelector = () => ({ open: false });
    globalThis.document.createTextNode = (value) => ({ textContent: value, children: [] });
    const make = globalThis.document.createElement;
    globalThis.document.createElementNS = (_ns, tag) => Object.assign(make(tag), { setAttribute() {}, appendChild() {} });
    const tab = initReplayTab({ $: dom.$, api });
    return { ...dom, api, on, asked, state, tab };
}
const hit = async (m) => { onReplayTabShown(); await flush(); return m; };
const button = (node) => node.children.find((c) => c.tagName === "BUTTON");

test("shown again after an answer with no folder the tab asks again, and finds osu! started since", async () => {
    const m = await hit(mount());
    assert.equal(m.asked.list, 1);
    assert.match(textOf(m.$("rp-list")), /not found/);
    await hit(m);
    assert.equal(m.asked.list, 2, "still nothing: it keeps asking");
    m.state.list = inFolder;
    await hit(m);
    assert.equal(m.asked.list, 4, "found: the quick list, then the one with titles");
    assert.match(textOf(m.$("rp-list")), /A Map/);
    assert.match(m.$("rp-folder").textContent, /Games/);
    await hit(m);
    assert.equal(m.asked.list, 4, "with a folder it does not ask every time");
});

test("the tab's own button: a refused pick is said, a good one leaves the rest to the folder event", async () => {
    const m = await hit(mount());
    m.api.replayPickFolder = async () => ({ ok: false, message: text("replay.err.notOsuFolder") });
    await fire(button(m.$("rp-list")));
    assert.equal(m.$("rp-status").textContent, text("replay.err.notOsuFolder"));
    assert.match(m.$("rp-status").className, /bad/);
    assert.equal(m.asked.list, 1);
    m.api.replayPickFolder = async () => ({ ok: false, cancelled: true });
    m.$("rp-status").textContent = "";
    await fire(button(m.$("rp-list")));
    assert.equal(m.$("rp-status").textContent, "", "a cancel says nothing");
    m.api.replayPickFolder = async () => ({ ok: true, folder: FOLDER, picked: FOLDER, source: "picked" });
    await fire(button(m.$("rp-list")));
    assert.equal(m.asked.list, 1, "no second read of its own");
});

test("a pick or a reset, here or in Settings, rereads the list and the skin select at once", async () => {
    const m = await hit(mount());
    assert.equal(m.asked.skin, 0);
    m.state.list = inFolder;
    m.state.skin = someSkins;
    m.on.folder({ ok: true, folder: FOLDER, picked: FOLDER, source: "picked" });
    await flush();
    assert.match(textOf(m.$("rp-list")), /A Map/);
    assert.deepEqual(m.$("rp-skin").children.map((o) => o.value), ["", "One", "Two"]);
    m.state.list = noFolder;
    m.state.skin = noSkins;
    m.on.folder({ ok: true, folder: null, picked: null, source: null });
    await flush();
    assert.match(textOf(m.$("rp-list")), /not found/);
    assert.deepEqual(m.$("rp-skin").children.map((o) => o.value), [""]);
    m.state.list = inFolder;
    await hit(m);
    assert.match(textOf(m.$("rp-list")), /A Map/, "after a reset to nothing it looks again when shown");
});

test("an old answer that comes late does not win over the folder picked meanwhile", async () => {
    const m = await hit(mount());
    let finishOld = null;
    const oldList = new Promise((resolve) => { finishOld = () => resolve({ ...inFolder, items: [{ ...item, title: "Old Folder" }] }); });
    let finishOldSkin = null;
    const oldSkin = new Promise((resolve) => { finishOldSkin = () => resolve({ ...someSkins, skins: ["Old Skin"] }); });
    m.api.replayList = () => oldList;
    m.api.replaySkin = () => oldSkin;
    m.on.folder({ ok: true, folder: "D:\\Old", picked: "D:\\Old", source: "picked" });
    await flush();
    m.api.replayList = async () => inFolder;
    m.api.replaySkin = async () => someSkins;
    m.on.folder({ ok: true, folder: FOLDER, picked: FOLDER, source: "picked" });
    await flush();
    finishOld();
    finishOldSkin();
    await flush();
    assert.match(textOf(m.$("rp-list")), /A Map/);
    assert.doesNotMatch(textOf(m.$("rp-list")), /Old Folder/);
    assert.deepEqual(m.$("rp-skin").children.map((o) => o.value), ["", "One", "Two"]);
});

test("the same when the first half came in time and the titles come late", async () => {
    const m = await hit(mount());
    let finishOld = null;
    const oldTitles = new Promise((resolve) => { finishOld = () => resolve({ ...inFolder, items: [{ ...item, title: "Old Folder" }] }); });
    m.api.replayList = async ({ titles }) => (titles ? oldTitles : inFolder);
    m.on.folder({ ok: true, folder: "D:\\Old", picked: "D:\\Old", source: "picked" });
    await flush();
    m.api.replayList = async () => inFolder;
    m.on.folder({ ok: true, folder: FOLDER, picked: FOLDER, source: "picked" });
    await flush();
    finishOld();
    await flush();
    assert.doesNotMatch(textOf(m.$("rp-list")), /Old Folder/);
});

test("the pictures of an old skin coming late are not drawn over the new one", async (t) => {
    const waiting = [];
    globalThis.Image = class { set src(_url) { waiting.push(this); } };
    t.after(() => { delete globalThis.Image; });
    const m = await hit(mount());
    m.state.skin = { ...someSkins, mania4: false, images: { note: { url: "data:old", hd: false } } };
    m.on.folder({ ok: true, folder: "D:\\Old", picked: "D:\\Old", source: "picked" });
    await flush();
    assert.equal(waiting.length, 1);
    m.state.skin = someSkins;
    m.on.folder({ ok: true, folder: FOLDER, picked: FOLDER, source: "picked" });
    await flush();
    waiting[0].onload();
    await flush();
    assert.equal(m.$("rp-skin-note").textContent, "", "the old skin's no-4K note stays out");
});

test("a reread keeps the skin the player chose, or the plain field", async () => {
    for (const [saved, request] of [["Mine", { folder: "Mine" }], ["", { plain: true }]]) {
        const m = await hit(mount({ storage: { "replay-skin": saved } }));
        m.on.folder({ ok: true, folder: FOLDER, picked: FOLDER, source: "picked" });
        await flush();
        assert.deepEqual(m.asked.skins, [request]);
    }
});

test("on the source of the profile's plays a folder change draws them again", async () => {
    const m = await hit(mount({ storage: { "replay-source": "gameplay" } }));
    let drawn = 0;
    m.api.localProfileHistory = async () => { drawn += 1; return { ok: true, plays: [] }; };
    m.on.folder({ ok: true, folder: FOLDER, picked: FOLDER, source: "picked" });
    await flush();
    assert.equal(drawn, 1);
});

test("a reset to nothing takes a scan's words off the tab", async () => {
    const m = await hit(mount({ list: inFolder }));
    m.on.progress({ done: 5, total: 10 });
    assert.match(m.$("rp-status").textContent, /5/);
    m.state.list = noFolder;
    m.on.folder({ ok: true, folder: null, picked: null, source: null });
    await flush();
    assert.equal(m.$("rp-status").textContent, "");
});

// a real replay of a real fixture folder, through main's service
async function oneReplay(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lm-replay-tab-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const game = path.join(root, "osu");
    const notes = rollNotes({ count: 60, stepMs: 120 });
    const chart = chartText(notes, { title: "Fixture Roll" });
    await mkdir(path.join(game, "Songs", "1 Roll"), { recursive: true });
    await writeFile(path.join(game, "Songs", "1 Roll", "x.osu"), chart);
    await mkdir(path.join(game, "Replays"), { recursive: true });
    const file = path.join(game, "Replays", "a.osr");
    await writeFile(file, makeOsr({ md5: createHash("md5").update(chart).digest("hex"), presses: honestPresses(notes, { sdMs: 8 }) }));
    const userData = path.join(root, "user-data");
    const service = createReplayService({
        userData, env: {}, songsIndex: createSongsMd5Index({ indexFile: path.join(userData, "songs.json") }), tosu: async () => ({ game, songs: null, skin: null }),
    });
    const quiet = { replayDetails: async () => ({ ok: false }), replayEarlier: async () => ({ ok: false }) };
    return { file, service, quiet };
}

test("the song's note and the skin's share a line: a reread does not wipe the song's, nor the song's end bring back an old skin's", async (t) => {
    const { file, service, quiet } = await oneReplay(t);
    const m = await hit(mount({ list: inFolder }));
    let finishAudio = null;
    Object.assign(m.api, quiet, { replayOpen: service.open, replayAudio: () => new Promise((resolve) => { finishAudio = resolve; }) });
    const note = m.$("rp-skin-note");
    await m.tab.openReplay({ file });
    await flush();
    assert.equal(note.textContent, text("replay.play.audioLoading"));
    m.state.skin = { ...someSkins, mania4: false };
    m.on.folder({ ok: true, folder: FOLDER, picked: FOLDER, source: "picked" });
    await flush();
    assert.equal(note.textContent, text("replay.play.audioLoading"), "the song is still on its way");
    finishAudio({ ok: false, stale: true });
    await flush();
    assert.equal(note.textContent, text("replay.play.no4k"), "what the new skin says, not what the old one said");

    m.api.replayAudio = async () => ({ ok: false, message: "It is gone" });
    await m.tab.openReplay({ file });
    await flush();
    assert.match(note.textContent, /It is gone/);
    m.on.folder({ ok: true, folder: FOLDER, picked: FOLDER, source: "picked" });
    await flush();
    assert.match(note.textContent, /It is gone/, "a reread leaves the no-audio note");
    m.api.replayOpen = async (request) => { const r = await service.open(request); r.map.audio = false; return r; };
    await m.tab.openReplay({ file });
    await flush();
    assert.equal(note.textContent, text("replay.play.no4k"), "the next replay does not inherit it");
});

test("an answer with no skins is not kept: the next replay asks again, an answer with skins is kept", async (t) => {
    const { file, service, quiet } = await oneReplay(t);
    const m = await hit(mount({ list: inFolder }));
    Object.assign(m.api, quiet, { replayOpen: service.open, replayAudio: async () => ({ ok: false, stale: true }) });
    assert.equal(await m.tab.openReplay({ file }), true);
    await flush();
    assert.equal(m.asked.skin, 1);
    await m.tab.openReplay({ file });
    await flush();
    assert.equal(m.asked.skin, 2, "no skins came: asked again");
    m.state.skin = someSkins;
    await m.tab.openReplay({ file });
    await flush();
    assert.equal(m.asked.skin, 3);
    await m.tab.openReplay({ file });
    await flush();
    assert.equal(m.asked.skin, 3, "skins came: kept");
});
