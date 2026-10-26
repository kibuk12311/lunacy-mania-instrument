// The local profile's main side (app/localProfileService.js) over a temp folder: live plays from tosu frames (each map
// analysed once per rate), the record switch, the osu! stable import (a synthetic scores.db and Songs folder; resumable,
// stoppable), the Interlude import, the status / history / played maps the window and the picks read, backup and reset.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalProfileStore } from "../../app/localProfileStore.js";
import { createLocalProfileService, pointsChange } from "../../app/localProfileService.js";
import { createSongsMd5Index } from "../../app/osuSongsScan.js";
import { createLocalProfileHandlers, recentPlays, TRACKER_SITE } from "../../app/localProfileIpc.js";
import { makeChart } from "../fixtures/makeChart.js";
import { makeScoresDb } from "../fixtures/makeScoresDb.js";
import { MOD_BITS } from "../../src/localProfile/scoresDb.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 26, 12);
const md5 = (text) => createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
const tempDir = () => mkdtemp(path.join(tmpdir(), "local-profile-svc-"));
// the analysis: a dan from the chart's bpm line (so each map has its own), always jumpstream
function fakeAnalyze() {
    const calls = [];
    const analyze = async (text, rate) => {
        calls.push([md5(text), rate]);
        const bpm = Number(/^Version:\S+ (\d+)/m.exec(text)?.[1] ?? 180);
        return { kind: "ok", numeric: Math.round((bpm / 15) * rate * 10) / 10, label: "x", top3: [{ name: "Jumpstream", share: 1 }], tech: false, durationSec: 90, calcs: { mixed: 12 } };
    };
    return { analyze, calls };
}

async function service({ dir, text = makeChart({ kind: "jumpstream", bpm: 195 }), extra = {} } = {}) {
    const root = dir ?? (await tempDir());
    const store = createLocalProfileStore({ dir: path.join(root, "profile") });
    const a = fakeAnalyze();
    const events = [];
    const s = createLocalProfileService({
        store, analyze: a.analyze, fetchMapText: async () => text, readFile: (f) => readFile(f),
        exists: async (f) => Boolean((await stat(f).catch(() => null))?.isFile()),
        songsIndex: createSongsMd5Index({ indexFile: path.join(root, "profile", "songs-md5.json") }),
        emit: (channel, payload) => events.push([channel, payload]), now: () => NOW, ...extra,
    });
    return { s, store, a, events, root, text };
}

const hitsJson = (geki, katu = 0, miss = 0) => ({ geki, 300: 0, katu, 100: 0, 50: 0, 0: miss });
const frame = (state, checksum, h) => ({
    client: "lazer", state: { number: state }, profile: { name: "TestPlayer" },
    beatmap: { checksum, id: 900, set: 90, artist: "Test", title: "Synthetic", version: "jumpstream 195", mode: { number: 3 } },
    play: { playerName: "TestPlayer", mode: { number: 3 }, mods: { name: "", array: [], rate: 1 }, hits: h, combo: { max: 100 } },
});
const settle = () => new Promise((r) => setTimeout(r, 30));

async function playLive(s, checksum, katu = 30, t0 = 0) {
    s.onTosuJson(frame(2, checksum, hitsJson(10)), t0 + 100);
    await settle(); // the .osu is fetched while the play goes on
    s.onTosuJson(frame(2, checksum, hitsJson(900, katu)), t0 + 200);
    s.onTosuJson(frame(7, checksum, hitsJson(900, katu)), t0 + 300);
    await settle();
}

test("live: a pass on the results screen is kept with its map analysed once per rate; the skill follows", async () => {
    const { s, a, events, text, store } = await service();
    const checksum = md5(text);
    await playLive(s, checksum, 30, 0);
    await playLive(s, checksum, 60, 1000);
    await playLive(s, checksum, 90, 2000);
    const plays = await store.plays();
    assert.equal(plays.length, 3);
    assert.equal(plays[0].client, "lazer");
    assert.equal(plays[0].beatmapId, 900);
    assert.equal(a.calls.length, 1, "the same map at the same rate is analysed once");
    assert.ok(events.some(([c]) => c === "local-profile-changed"));
    const st = await s.status();
    assert.equal(st.counts.live, 3);
    assert.equal(st.counts.lazer, 3);
    // three plays on one map are one map: not enough for a dan yet
    assert.equal(st.skill.axes.stamina.maps, 1);
    assert.equal(st.skill.ready, false);
    assert.equal(st.recent.length, 3);
    assert.equal(st.recent[0].mapDan, 13);
    // the picks' played maps
    const played = await s.playedBeatmaps();
    assert.deepEqual([...played.keys()], [900]);
    assert.equal(played.get(900).local, true);
});

test("live: a map tosu changed under the play is not analysed from the wrong .osu; record off keeps nothing", async () => {
    const { s, a, store } = await service({ text: makeChart({ bpm: 170 }) });
    await playLive(s, "c".repeat(32));
    const [p] = await store.plays();
    assert.equal(p.md5, "c".repeat(32));
    assert.equal(a.calls.length, 0, "the text's md5 is not the play's");
    assert.equal((await s.status()).recent[0].unrated, true);

    // a BOM in the file: the md5 is over the bytes, the analysis gets the text without it
    const bomText = makeChart({ kind: "jumpstream", bpm: 210 });
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(bomText, "utf8")]);
    const bom = await service({ extra: { fetchMapText: async () => bytes } });
    await playLive(bom.s, createHash("md5").update(bytes).digest("hex"));
    assert.equal(bom.a.calls.length, 1);
    assert.equal(bom.a.calls[0][0], md5(bomText));

    const off = await service();
    assert.equal(await off.s.recording(), true, "recording is on by default (the overlay's Dan widget asks)");
    await off.s.setRecord(false);
    assert.equal(await off.s.recording(), false);
    await playLive(off.s, md5(off.text));
    assert.equal((await off.store.plays()).length, 0);
    assert.equal((await off.s.status()).settings.record, false);
});

async function osuFolder(root, charts) {
    const osu = path.join(root, "osu!");
    const scores = [];
    for (const [i, c] of charts.entries()) {
        const dir = path.join(osu, "Songs", `${100 + i} Test - Song ${i}`);
        await mkdir(dir, { recursive: true });
        const text = makeChart({ kind: "jumpstream", bpm: c.bpm }).replace("Version:", `BeatmapID:${1000 + i}\r\nBeatmapSetID:${100 + i}\r\nVersion:`);
        if (!c.missing) await writeFile(path.join(dir, "map.osu"), text, "utf8");
        for (const [j, acc] of (c.plays ?? [0.965]).entries()) {
            // MAX/200 mix for that accuracy
            const katu = Math.round((1 - acc) * 3 * 1000);
            scores.push({ md5: md5(text), player: c.player ?? "TestPlayer", replayMd5: md5(`${i}:${j}:${c.player ?? ""}`), geki: 1000 - katu, katu, mods: c.mods ?? 0, at: NOW - (30 - i) * DAY + j });
        }
    }
    await writeFile(path.join(osu, "scores.db"), makeScoresDb(scores));
    return osu;
}

test("osu! stable import: the main player's mania scores matched to Songs by md5, analysed, resumable", async () => {
    const root = await tempDir();
    const osu = await osuFolder(root, [
        { bpm: 180, plays: [0.97, 0.95] }, { bpm: 195 }, { bpm: 210, mods: MOD_BITS.DT }, { bpm: 165 },
        { bpm: 200, missing: true }, { bpm: 150, player: "Friend" },
    ]);
    const { s, a, store, events } = await service({ dir: root });
    const r = await s.importStable({ folder: osu });
    assert.equal(r.ok, true);
    assert.equal(r.player, "TestPlayer");
    assert.equal(r.added, 5, "six of the player's scores, one map not in Songs");
    assert.equal(r.missing, 1);
    assert.equal(r.finished, true);
    assert.ok(events.some(([c, p]) => c === "local-profile-import" && p.phase === "scan"));
    assert.ok(events.some(([c, p]) => c === "local-profile-import" && p.phase === "analyse"));
    const plays = await store.plays();
    assert.ok(plays.every((p) => p.source === "stable-db" && p.client === "stable" && p.outcome === "pass"));
    assert.deepEqual(plays.find((p) => p.rate === 1.5)?.mods, ["DT"]);
    assert.ok(plays.every((p) => p.beatmapId >= 1000 && p.title.startsWith("Synthetic")));
    assert.equal(a.calls.length, 4, "four maps (one at DT), each once");
    const k = await s.skill();
    assert.equal(k.ready, true);
    assert.ok(Number.isFinite(k.tiles.stamina));
    assert.equal((await store.settings()).osuFolder, osu);
    assert.equal((await store.settings()).imports.stable.finished, true);
    // again: nothing new, nothing analysed
    const again = await s.importStable();
    assert.equal(again.added, 0);
    assert.equal(a.calls.length, 4);
    // the history: one point per day with plays, from the day a dan was possible
    const h = await s.history(90);
    assert.ok(h.points.length >= 1);
    assert.ok(h.best.length > 0);
    assert.equal(h.joinable.length, plays.length);
});

test("osu! stable import: stopped half way it goes on where it stopped; refusals say why", async () => {
    const root = await tempDir();
    const osu = await osuFolder(root, [{ bpm: 180 }, { bpm: 190 }, { bpm: 200 }, { bpm: 210 }]);
    let analysed = 0;
    let svc = null;
    const { s, store } = await service({
        dir: root,
        extra: {
            analyze: async (text, rate) => {
                analysed += 1;
                if (analysed === 2) svc.cancelImport();
                return { kind: "ok", numeric: 13, top3: [{ name: "Stream", share: 1 }], durationSec: 60 };
            },
        },
    });
    svc = s;
    const first = await s.importStable({ folder: osu });
    assert.equal(first.finished, false);
    assert.equal(first.cancelled, true);
    const kept = (await store.plays()).length;
    assert.ok(kept >= 1 && kept < 4, String(kept));
    assert.equal((await store.settings()).imports.stable.finished, false);
    const second = await s.importStable();
    assert.equal(second.finished, true);
    assert.equal((await store.plays()).length, 4);

    const none = await service({ extra: { defaultOsuFolder: null } });
    assert.deepEqual(await none.s.importStable(), { ok: false, reason: "no-folder" });
    const empty = await tempDir();
    assert.equal((await none.s.importStable({ folder: empty })).reason, "no-scores");
});

test("Interlude import: passes count without accuracy (weaker), fails are kept but are no evidence", async () => {
    const charts = [180, 190, 200, 210].map((bpm) => makeChart({ kind: "jumpstream", bpm }));
    const rows = charts.flatMap((_, i) => [{ hash: `H${i}`, at: NOW - (10 - i) * DAY, rate: 1, failed: false }, { hash: `H${i}`, at: NOW - (10 - i) * DAY + 5, rate: 1.1, failed: true }]);
    const interlude = {
        linked: async () => true,
        scores: async () => rows,
        osuFor: async (hash) => {
            const i = Number(hash.slice(1));
            return { text: charts[i], meta: { artist: "Test", title: `Chart ${i}`, version: "x", origins: [{ md5: md5(charts[i]), beatmapId: 500 + i, beatmapsetId: 50, rate: 1 }] } };
        },
    };
    const { s, store } = await service({ extra: { interlude } });
    const r = await s.importInterlude();
    assert.equal(r.added, 8);
    const plays = await store.plays();
    assert.ok(plays.every((p) => p.client === "interlude" && p.hits === null));
    assert.equal(plays.filter((p) => p.outcome === "fail").length, 4);
    const k = await s.skill();
    assert.equal(k.analyzedPlays, 4);
    // four passes at quality 0.5 are support 2: just enough, with the "passed it" credit
    assert.equal(k.tiles.stamina !== null, true);
    assert.equal((await s.importInterlude()).added, 0);
    assert.equal((await (await service()).s.importInterlude()).reason, "no-interlude");
    assert.ok((await s.playedBeatmaps()).has(503));
});

test("backup and reset through the service; the handlers' file dialogs; the tracker's recent plays and site link", async () => {
    const { s, text } = await service();
    await playLive(s, md5(text));
    const bundle = await s.exportBundle();
    await s.reset();
    assert.equal((await s.status()).counts.plays, 0);
    assert.deepEqual(await s.importBundle(bundle), { ok: true, added: 1, skipped: 0 });
    assert.equal((await s.status()).counts.plays, 1);

    const dir = await tempDir();
    const file = path.join(dir, "backup.json");
    const opened = [];
    const h = createLocalProfileHandlers({
        localProfile: s,
        dialog: { showSaveDialog: async () => ({ filePath: file }), showOpenDialog: async () => ({ filePaths: [file] }) },
        shell: { openExternal: async (url) => opened.push(url) },
        recommender: { currentPlayer: () => ({ id: 1234567, username: "TestPlayer" }) },
        trackerApi: { recent: async () => JSON.parse(await readFile(new URL("../fixtures/mt/recent.json", import.meta.url), "utf8")) },
    });
    assert.equal((await h.exportFile()).plays, 1);
    assert.equal(JSON.parse(await readFile(file, "utf8")).plays.length, 1);
    assert.deepEqual(await h.importFile(), { ok: true, added: 0, skipped: 1 });
    await writeFile(file, "not json");
    assert.equal((await h.importFile()).ok, false);
    assert.equal((await h.history({ days: 3 })).ok, false);
    assert.equal((await h.history({ days: 30 })).ok, true);
    const recent = await h.trackerRecent();
    assert.equal(recent.ok, true);
    assert.ok(recent.plays.length > 0);
    assert.ok(recent.plays[0].title && recent.plays[0].at >= recent.plays.at(-1).at);
    await h.openTracker();
    assert.deepEqual(opened, [`${TRACKER_SITE}1234567`]);
    assert.deepEqual(recentPlays({ payload: [] }), []);
});

test("pointsChange: first → last, biggest gain first", () => {
    const c = pointsChange([{ dan: 13, ratings: { speed: 13, "p:stream": 12 } }, { dan: 13.4, ratings: { speed: 13.2, "p:stream": 12.6 } }]);
    assert.equal(c.danDelta, 0.4);
    assert.deepEqual(c.axes.map((a) => a.axis), ["p:stream", "speed"]);
    assert.equal(pointsChange([]), null);
});
