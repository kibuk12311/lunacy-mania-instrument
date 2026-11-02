// The Replay tab and the folder, through the fake DOM with main's real replay service where a replay has to open: the tab
// looks again when osu! starts after it was first shown, an answer with no skins is not kept for good, a pick or a reset
// made anywhere rereads the list and the skin select at once, keeping the skin chosen, a refused pick is said, a late answer
// does not win, and the line under the stage keeps the song's note and the skin's apart.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
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

// Interlude's saved plays in the list: with no osu! folder too, marked, opened by their id; a linked folder that is gone
// is said, in Settings' words
const PLAY = `interlude:${"c".repeat(64)}:1790000000000`;
// as app/replayInterlude.js lists one: the mods by Interlude's short names, the rate as the tab shows it
const ilItem = { kind: "interlude", play: PLAY, chart: "c".repeat(64), at: 1790000000000, rate: 1.1, modNames: ["MR", "NLN"], accuracy: 97.25, miss: 3, failed: false, artist: "Test", title: "Interlude Map", version: "Hard", found: true, reason: null };
const ilFailed = { ...ilItem, play: `${PLAY}1`, failed: true, accuracy: null, title: null, artist: null, version: null, found: false };

test("with no osu! folder but Interlude linked the list shows Interlude's plays, marked, and opens one by its id", async () => {
    const m = await hit(mount({ list: { ...noFolder, items: [ilItem, ilFailed], interlude: { linked: true, ok: true } } }));
    const [note, pick, row, failed] = m.$("rp-list").children;
    assert.equal(note.textContent, text("replay.list.onlyInterlude"));
    assert.equal(pick.textContent, text("replay.list.pick"), "the osu! pick stays beside Interlude's plays");
    assert.equal(row.dataset.play, PLAY);
    assert.equal(row.dataset.file, undefined);
    assert.equal(textOf(row.children[0]), "Test - Interlude Map [Hard] | Interlude | 97.25 %");
    assert.match(row.children[1].textContent, /MR, NLN · ×1\.1$/);
    assert.equal(textOf(failed.children[0]), `chart cccccccc… | Interlude | ${text("replay.list.failed")} | —`);
    assert.equal(failed.title, "chart cccccccc…: accuracy — %, 3 misses");
    const asked = [];
    m.api.replayOpen = async (request) => { asked.push(request); return { ok: false, cancelled: true }; };
    await fire(row);
    assert.deepEqual(asked, [{ play: PLAY }]);
    assert.equal(m.asked.list, 1, "no titles to wait for without osu!");
});

test("Interlude linked with its folder gone: said above osu!'s replays, or with the osu! pick when there is no osu! either", async () => {
    const gone = { linked: true, ok: false, reason: "missing" };
    const m = await hit(mount({ list: { ...inFolder, interlude: gone } }));
    const kids = m.$("rp-list").children;
    assert.equal(kids[0].textContent, text("replay.list.ilMissing"));
    assert.match(kids[0].textContent, /Settings → Interlude/);
    assert.equal(kids[1].dataset.file, item.file, "osu!'s replays as before");
    const none = await hit(mount({ list: { ...noFolder, interlude: gone } }));
    const said = textOf(none.$("rp-list"));
    assert.match(said, /Interlude's folder was not found/);
    assert.match(said, /The osu! folder was not found/);
    assert.ok(button(none.$("rp-list")), "the osu! pick stays");
    const empty = await hit(mount({ list: { ...inFolder, items: [], interlude: { linked: true, ok: true } } }));
    assert.equal(textOf(empty.$("rp-list")), text("replay.list.emptyBoth"));
    const emptyIl = await hit(mount({ list: { ...noFolder, interlude: { linked: true, ok: true } } }));
    assert.equal(textOf(emptyIl.$("rp-list")), `${text("replay.list.onlyInterlude")} | ${text("replay.list.pick")} | ${text("replay.list.emptyIl")}`);
});

test("the osu! pick stays with Interlude linked and readable, and works as it does with nothing linked", async () => {
    for (const items of [[ilItem], []]) {
        const m = await hit(mount({ list: { ...noFolder, items, interlude: { linked: true, ok: true } } }));
        const pick = button(m.$("rp-list"));
        assert.equal(pick?.textContent, text("replay.list.pick"), `${items.length} plays`);
        m.api.replayPickFolder = async () => ({ ok: false, message: text("replay.err.notOsuFolder") });
        await fire(pick);
        assert.equal(m.$("rp-status").textContent, text("replay.err.notOsuFolder"));
    }
    for (const lang of ["ru", "en"]) {
        setLang(lang);
        assert.match(text("replay.list.onlyInterlude"), lang === "ru" ? /выбери папку/ : /pick the folder/, "it says where to set it");
    }
    setLang("en");
});

test("osu!'s list with Interlude not linked is drawn as it always was", async () => {
    const m = await hit(mount({ list: { ...inFolder, interlude: { linked: false, ok: false } } }));
    const [row] = m.$("rp-list").children;
    assert.equal(m.$("rp-list").children.length, 1);
    assert.equal(textOf(row.children[0]), "Test - A Map [One] | 99.00 %");
    assert.equal(row.dataset.play, undefined);
});

// a real replay of a real fixture folder, through main's service
async function oneReplay(t, more = {}) {
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
        ...more,
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

test("opens answered out of order: the replay shown is the one main keeps open, so its song is asked of it", async (t) => {
    let pick = null;
    const dialog = { showOpenDialog: () => new Promise((resolve) => { pick = (file) => resolve({ canceled: false, filePaths: [file] }); }) };
    let hold = null; // the next read of the replay waits for this
    const fs = {
        ...nodeFs,
        readFile: async (p, ...rest) => {
            const wait = path.extname(String(p)) === ".osr" ? hold : null;
            if (wait) {
                hold = null;
                await wait;
            }
            return nodeFs.readFile(p, ...rest);
        },
    };
    const { file, service, quiet } = await oneReplay(t, { dialog, fs });
    const m = await hit(mount({ list: inFolder }));
    const songs = [];
    const until = async (done) => { for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => { setTimeout(r, 5); }); };
    Object.assign(m.api, quiet, { replayOpen: service.open, replayAudio: async (request) => { const r = await service.audio(request); songs.push(r); return r; } });
    // the first asked answers last: overtaken, it is not shown
    let release = null;
    hold = new Promise((resolve) => { release = resolve; });
    const first = m.tab.openReplay({ file });
    await until(() => hold === null); // its read is under way
    const second = m.tab.openReplay({ file });
    assert.equal(await second, true);
    release();
    assert.equal(await first, null);
    await until(() => songs.length >= 1);
    await flush();
    assert.deepEqual([songs.length, songs.some((r) => r.stale)], [1, false], "the song of the replay shown is asked of the replay open");
    // a file picked in the dialog after a play's replay was asked meanwhile: the pick is shown, the one main keeps
    const picked = m.tab.openReplay({});
    await until(() => pick);
    const ended = m.tab.openReplay({ file });
    assert.equal(await ended, true);
    pick(file);
    assert.equal(await picked, true);
    await until(() => songs.length >= 3);
    await flush();
    assert.deepEqual([songs.length, songs.some((r) => r.stale)], [3, false]);
    assert.equal(m.$("rp-status").textContent, "");
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
