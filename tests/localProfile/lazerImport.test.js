// The osu! lazer history import (app/localProfileService.js importLazer) over a fake app/lazerRealm.js and a temp
// profile folder: the main player's 4K plays at a fixed rate kept, everything else skipped, each map at its rate analysed
// once from lazer's files store, a second import and a play the live recording took are not added again, a stop goes on
// where it stopped; the IPC handler's "lazer" source and the Profile tab's button, refusal and last-import line.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalProfileStore } from "../../app/localProfileStore.js";
import { createLocalProfileService } from "../../app/localProfileService.js";
import { createLocalProfileHandlers } from "../../app/localProfileIpc.js";
import { AXES, PATTERNS, createSkillModel } from "../../src/localProfile/model.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { makeChart } from "../fixtures/makeChart.js";
import { fakeDom, fire } from "../helpers/fakeDom.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 26, 12);
const md5 = (text) => createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// the store keeps "lazer-db" and imports.lazer only once app/localProfileStore.js knows them (.lekhapion request C-profile)

// four synthetic 4K charts (each its own bpm, so its own dan) and one 7K, as lazer's library lists them
const CHARTS = [180, 190, 200, 210].map((bpm) => makeChart({ kind: "jumpstream", bpm }));
const SEVEN = makeChart({ kind: "stream", bpm: 170, keys: 7 });
const lazerMap = (text, i, keys = 4) => ({
    hash: sha256(text), md5: md5(text), keys, artist: "Test", title: `Synthetic ${i}`, version: `v${i}`, creator: "TestPlayer",
    tags: "", beatmapId: 2000 + i, setId: 200 + i, audio: null, background: null,
});
const MAPS = [...CHARTS.map((c, i) => lazerMap(c, i)), lazerMap(SEVEN, 9, 7)];

const hits = (great, good = 0, miss = 0) => ({ max: 900, n300: great, n200: good, n100: 0, n50: 0, miss });
let nextId = 1;
function score(text, { player = "TestPlayer", keys = 4, rate = 1, mods = [], failed = false, at = NOW - 5 * DAY, h = hits(40, 20), gone = false } = {}) {
    return {
        id: uuid(nextId++), hash: sha256(text), md5: gone ? null : md5(text), keys: gone ? null : keys, player, at, mods, rate,
        hits: h, maxCombo: 500, accuracy: 0.97, failed,
    };
}

// TestPlayer: 6 usable plays (one at DT 1.5, one at DT with speed_change 1.3, one failed); everything else is skipped
function lazerScores() {
    return [
        score(CHARTS[0], { at: NOW - 9 * DAY }),
        score(CHARTS[0], { at: NOW - 8 * DAY, h: hits(60, 30) }),
        score(CHARTS[1], { at: NOW - 7 * DAY, mods: ["DT"], rate: 1.5 }),
        score(CHARTS[1], { at: NOW - 6 * DAY, mods: ["DT"], rate: 1.3 }),
        score(CHARTS[2], { at: NOW - 5 * DAY, failed: true, h: hits(20, 10, 40) }),
        score(CHARTS[3], { at: NOW - 4 * DAY }),
        // other players (more plays than TestPlayer: the logged-in name picks the main one)
        ...Array.from({ length: 8 }, (_, i) => score(CHARTS[i % 4], { player: "Friend", at: NOW - 3 * DAY + i })),
        score(SEVEN, { keys: 7 }), // 7K
        score(CHARTS[3], { mods: ["WU"], rate: null }), // wind up: no fixed rate
        score(makeChart({ bpm: 230 }), { gone: true }), // its map is gone from lazer
    ];
}

function fakeLazer({ maps = MAPS, scores = lazerScores(), found = true, texts = new Map([...CHARTS, SEVEN].map((c) => [sha256(c), c])) } = {}) {
    const calls = { read: 0, text: [] };
    return {
        calls,
        status: async () => ({ found, dataDir: null }),
        read: async () => {
            calls.read += 1;
            return found ? { found: true, maps, scores } : { found: false, maps: [], scores: [] };
        },
        text: async (hash) => {
            calls.text.push(hash);
            return texts.get(hash) ?? null;
        },
    };
}

// the analysis: a dan from the chart's bpm (so each map has its own), always jumpstream
function fakeAnalyze() {
    const calls = [];
    const analyze = async (text, rate) => {
        calls.push([md5(text), rate]);
        const bpm = Number(/^Version:\S+ (\d+)/m.exec(text)?.[1] ?? 180);
        return { kind: "ok", numeric: Math.round((bpm / 15) * rate * 10) / 10, label: "x", top3: [{ name: "Jumpstream", share: 1 }], tech: false, durationSec: 90, calcs: { mixed: 12 } };
    };
    return { analyze, calls };
}

async function service({ lazer = fakeLazer(), extra = {} } = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "local-profile-lazer-"));
    const store = createLocalProfileStore({ dir: path.join(root, "profile") });
    const a = fakeAnalyze();
    const events = [];
    const s = createLocalProfileService({
        store, analyze: a.analyze, readFile: async () => Buffer.alloc(0), lazer,
        preferredPlayer: async () => "testplayer", emit: (channel, payload) => events.push([channel, payload]), now: () => NOW, ...extra,
    });
    return { s, store, a, events, lazer };
}

test("lazer import: the main player's 4K plays at a fixed rate, each map at its rate analysed once", async () => {
    const { s, store, a, events, lazer } = await service();
    const r = await s.importLazer();
    assert.equal(r.ok, true);
    assert.equal(r.source, "lazer");
    assert.equal(r.player, "TestPlayer", "the logged-in name wins over the player with most plays");
    assert.equal(r.added, 6);
    assert.equal(r.total, 6, "other players, 7K, wind up and the gone map are not counted");
    assert.equal(r.finished, true);
    assert.ok(events.some(([c, p]) => c === "local-profile-import" && p.source === "lazer" && p.phase === "read"));
    assert.ok(events.some(([c, p]) => c === "local-profile-import" && p.phase === "analyse"));
    const plays = await store.plays();
    assert.equal(plays.length, 6);
    assert.ok(plays.every((p) => p.client === "lazer" && p.id.startsWith("lazer:") && p.hits));
    assert.ok(plays.every((p) => p.title.startsWith("Synthetic") && p.beatmapId >= 2000 && p.beatmapsetId >= 200));
    // the rate from DT (lazerRealm works it out from the mods): its own map key, analysed at it
    const dt = plays.find((p) => p.rate === 1.5);
    assert.deepEqual(dt.mods, ["DT"]);
    assert.equal(dt.mapKey, `${md5(CHARTS[1])}@1.50`);
    assert.ok(plays.some((p) => p.rate === 1.3 && p.mods[0] === "DT"));
    // a failed play is kept as a fail
    const failed = plays.filter((p) => p.outcome === "fail");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].md5, md5(CHARTS[2]));
    // five maps at their rates (chart 0 twice at 1.0): each analysed once, from lazer's files store
    assert.equal(a.calls.length, 5);
    assert.deepEqual(new Set(a.calls.map(([m, rate]) => `${m}@${rate}`)).size, 5);
    assert.equal(lazer.calls.text.length, 5);
    const st = await s.status();
    assert.equal(st.lazerFound, true);
    assert.equal(st.counts.lazer, 6);
    assert.ok((await s.playedBeatmaps()).has(2003));

    // again: nothing new, nothing analysed
    const again = await s.importLazer();
    assert.equal(again.added, 0);
    assert.equal(again.total, 6);
    assert.equal(a.calls.length, 5);
    assert.equal((await store.plays()).length, 6);
});

test("lazer import: a play the live recording took with the same judgements is not added again", async () => {
    const h = hits(40, 20);
    const lazer = fakeLazer({ scores: [score(CHARTS[0], { h, at: NOW - DAY }), score(CHARTS[1], { at: NOW - DAY + 1 })] });
    const { s, store, a } = await service({ lazer, extra: { fetchMapText: async () => CHARTS[0] } });
    // what the live recording kept from tosu while lazer saved the score
    const live = await s.recordLive({
        client: "lazer", md5: md5(CHARTS[0]), beatmapId: 2000, beatmapsetId: 200, artist: "Test", title: "Synthetic 0", version: "v0",
        rate: 1, mods: [], hits: { ...h }, accuracy: 0.97, maxCombo: 500, outcome: "pass", startedAt: NOW - DAY - 90_000, at: NOW - DAY - 1000,
    });
    assert.ok(live, "the live play is kept");
    const r = await s.importLazer();
    assert.equal(r.total, 2);
    assert.equal(r.added, 1, "only the play the recording did not see");
    const plays = await store.plays();
    assert.equal(plays.length, 2);
    assert.equal(plays.filter((p) => p.md5 === md5(CHARTS[0])).length, 1);
    assert.equal(plays.find((p) => p.md5 === md5(CHARTS[0])).source, "live");
    assert.equal(a.calls.length, 2, "the live play's map was analysed then, the other one now");
});

test("lazer import: a map lazer no longer lists or whose .osu is gone is missing; refusals and an unreadable database", async () => {
    const hidden = makeChart({ bpm: 240 });
    const texts = new Map([[sha256(CHARTS[0]), CHARTS[0]]]); // chart 1's .osu is not in the files store
    const lazer = fakeLazer({ texts, scores: [score(CHARTS[0]), score(CHARTS[1]), score(hidden)] });
    const { s, store } = await service({ lazer });
    const r = await s.importLazer();
    assert.equal(r.added, 1);
    assert.equal(r.missing, 2);
    assert.equal((await store.plays()).length, 1);

    assert.deepEqual(await (await service({ lazer: fakeLazer({ found: false }) })).s.importLazer(), { ok: false, reason: "no-lazer" });
    const none = await service({ lazer: null });
    assert.deepEqual(await none.s.importLazer(), { ok: false, reason: "no-lazer" });
    assert.equal((await none.s.status()).lazerFound, false);
    assert.equal((await (await service({ lazer: fakeLazer({ found: false }) })).s.status()).lazerFound, false);

    const broken = { ...fakeLazer(), read: async () => { throw new Error("cannot read"); } };
    const b = await service({ lazer: broken });
    const failed = await b.s.importLazer();
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "failed");
    assert.equal(failed.message, "cannot read");
    assert.equal(b.s.importing(), null, "the import is over");
});

test("lazer import: stopped half way it goes on where it stopped", async () => {
    let analysed = 0;
    let svc = null;
    const { s, store } = await service({
        extra: {
            analyze: async () => {
                analysed += 1;
                if (analysed === 2) svc.cancelImport();
                return { kind: "ok", numeric: 13, top3: [{ name: "Stream", share: 1 }], durationSec: 60 };
            },
        },
    });
    svc = s;
    const first = await s.importLazer();
    assert.equal(first.finished, false);
    assert.equal(first.cancelled, true);
    const kept = (await store.plays()).length;
    assert.ok(kept >= 1 && kept < 6, String(kept));
    const second = await s.importLazer();
    assert.equal(second.finished, true);
    assert.equal((await store.plays()).length, 6);
});

test("the store keeps the lazer source and the last lazer import", async () => {
    const { s, store } = await service();
    await s.importLazer();
    assert.ok((await store.plays()).every((p) => p.source === "lazer-db"));
    const last = (await store.settings()).imports.lazer;
    assert.equal(last.finished, true);
    assert.equal(last.added, 6);
    assert.equal(last.player, "TestPlayer");
    assert.equal((await s.status()).counts.lazerDb, 6);
});

test("the handlers: source lazer runs the lazer import", async () => {
    const asked = [];
    const localProfile = {
        importLazer: async () => { asked.push("lazer"); return { ok: true }; },
        importInterlude: async () => { asked.push("interlude"); return { ok: true }; },
        importStable: async () => { asked.push("stable"); return { ok: true }; },
    };
    const h = createLocalProfileHandlers({ localProfile });
    for (const source of ["lazer", "interlude", "stable", undefined]) await h.importHistory({ source });
    assert.deepEqual(asked, ["lazer", "interlude", "stable", "stable"]);
});

// ---- the Profile tab's button ----

function statusAnswer({ lazerFound, imports = {} }) {
    return {
        ok: true, skill: createSkillModel().skill(Date.now()),
        settings: { record: true, imports }, counts: { plays: 3, rated: 0, live: 0, stable: 0, interlude: 0, lazer: 3, lazerDb: 3 },
        top: Object.fromEntries([...AXES, ...PATTERNS.map((p) => `p:${p}`)].map((k) => [k, []])),
        recent: [], importing: null, interludeLinked: false, lazerFound,
    };
}

async function profileTab({ lang = "ru", lazerFound = true, imports = {}, answer = { ok: true, source: "lazer", added: 3, total: 4, finished: true, missing: 1 } } = {}) {
    setLang(lang);
    const calls = [];
    const api = {
        localProfileStatus: async () => statusAnswer({ lazerFound, imports }),
        localProfileHistory: async (days) => ({ ok: true, since: Date.now() - days * DAY, now: Date.now(), points: [], change: null }),
        localProfileImport: async (src) => { calls.push(`import ${src}`); return answer; },
        onLocalProfileChanged: () => {}, onLocalProfileImport: () => {}, onProfileChanged: () => {},
        recProgress: async () => ({ ok: false, message: "x" }),
    };
    const dom = fakeDom(api, { storage: { "rec-settings": JSON.stringify({ source: "local" }), "profile-view": JSON.stringify({ page: "local" }) } });
    globalThis.document.createElementNS = (_ns, tag) => Object.assign(globalThis.document.createElement(tag), { setAttribute() {} });
    globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
    const mod = await import(`../../app/renderer/profileTab.js?lazer${lang}${lazerFound}${Math.random()}`);
    mod.initProfileTab();
    mod.onProfileTabShown();
    await new Promise((r) => setTimeout(r, 20));
    return { ...dom, calls, mod };
}

test("Profile tab: «Импорт из osu! lazer» runs the lazer import; off with a reason when lazer is not found", async () => {
    try {
        const on = await profileTab({ imports: { stable: { at: Date.now() - 3 * DAY, added: 5, finished: true }, lazer: { at: Date.now(), added: 2, finished: false } } });
        assert.equal(on.$("prof-import-lazer").disabled, false);
        assert.equal(on.$("prof-import-lazer").title, "");
        // the last-import line: every import, the latest first
        const line = on.$("prof-import-status").textContent;
        assert.ok(line.indexOf("osu! lazer") >= 0 && line.indexOf("osu! lazer") < line.indexOf("osu! stable"), line);
        assert.ok(line.includes("+2") && line.includes("+5"), line);
        assert.ok(on.$("prof-local-counts").textContent.includes(t("profile.local.fromLazer", { n: 3 })));
        await fire(on.$("prof-import-lazer"));
        assert.deepEqual(on.calls, ["import lazer"]);
        const done = on.$("prof-import-status").textContent;
        assert.ok(done.includes(t("profile.import.done", { added: 3, total: 4 })) && done.includes(t("profile.import.missingLazer", { n: 1 })), done);

        const off = await profileTab({ lazerFound: false, answer: { ok: false, reason: "no-lazer" } });
        assert.equal(off.$("prof-import-lazer").disabled, true);
        assert.equal(off.$("prof-import-lazer").title, t("profile.local.noLazer"));
        await fire(off.$("prof-import-lazer"));
        assert.equal(off.$("prof-import-status").textContent, t("profile.local.noLazer"));

        const en = await profileTab({ lang: "en", imports: { lazer: { at: Date.now(), added: 2, finished: true } } });
        const text = [en.$("prof-import-status").textContent, en.$("prof-local-counts").textContent].join(" ");
        assert.ok(!/[А-Яа-яЁё]/.test(text) && text.includes("Last osu! lazer import"), text);
    } finally {
        setLang("ru");
    }
});
