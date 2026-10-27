// The session page's own helpers (app/renderer/recSession.js): saved settings, the request it sends, the texts it
// shows (the library line and its notes, an item's meta, the list copied as text, the Interlude playlist items).
import test from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../src/i18n/i18n.js";
import {
    parseSessionSettings, sessionRequest, sessionText, itemParts, libraryText, libraryNotes, phaseText, rateMark, sourceText, playlistItems,
    DEFAULT_SESSION,
} from "../app/renderer/recSession.js";

const item = (patch = {}) => ({
    part: "main", artist: "Alpha", title: "Song", version: "Hard", danLabel: "Gamma mid", dan: 13.04, estimated: false,
    patternId: "jumpstream", durationSec: 131, rate: 1.1, sources: { stable: { path: "C:\\x.osu", md5: "a".repeat(32) }, interlude: { hash: "B".repeat(64) } },
    ...patch,
});

test("saved settings: anything unknown falls back to the default", () => {
    assert.deepEqual(parseSessionSettings(null), DEFAULT_SESSION);
    assert.deepEqual(parseSessionSettings("{bad"), DEFAULT_SESSION);
    assert.deepEqual(parseSessionSettings(JSON.stringify({ minutes: 45, patternIds: ["stream", "nope", "stream", "jack", "tech", "tech", "handstream"], goalId: "challenge", allowRates: true, avoidRecent: false })),
        { minutes: 45, patternIds: ["stream", "jack", "tech", "handstream"], goalId: "challenge", allowRates: true, avoidRecent: false });
    assert.equal(parseSessionSettings(JSON.stringify({ minutes: 500 })).minutes, 30);
    assert.equal(parseSessionSettings(JSON.stringify({ goalId: "custom" })).goalId, "growth");
});

test("the request: the General mode asks for a kind's parent; the hand-set profile goes along in manual mode", () => {
    const s = { ...DEFAULT_SESSION, patternIds: ["quadstream", "stream"] };
    assert.deepEqual(sessionRequest(s, { detailed: false }), { minutes: 30, patternIds: ["chordjack", "stream"], goalId: "growth", allowRates: false, avoidRecent: true });
    const manual = sessionRequest(s, { detailed: true, manual: true, manualProfile: { speed: 13 }, avoidRecent: false });
    assert.deepEqual(manual.patternIds, ["quadstream", "stream"]);
    assert.deepEqual(manual.manualProfile, { speed: 13 });
    assert.equal(manual.avoidRecent, false);
});

test("texts: an item's meta, the list as text, the library line", () => {
    setLang("en");
    assert.equal(rateMark(1), "");
    assert.equal(rateMark(1.1), "×1.10");
    assert.equal(sourceText(item().sources), "osu! + Interlude");
    assert.deepEqual(itemParts(item()).map((p) => p.text), ["Gamma mid", "13.04", "Jumpstream", "2:11", "×1.10", "osu! + Interlude"]);
    assert.equal(itemParts(item({ estimated: true, rate: 1 }))[0].text, "≈ Gamma mid");
    const text = sessionText({ name: "Evening", totalSec: 1500, items: [item({ part: "warmup", rate: 1 }), item()] });
    assert.equal(text, "Evening — 25:00\n1. [Warm-up] Alpha - Song [Hard] · Gamma mid (13.04) · 2:11\n2. [Main] Alpha - Song [Hard] · Gamma mid (13.04) · ×1.10 · 2:11");
    const st = { phase: "analysing", songsDir: "C:\\osu!\\Songs", interlude: { linked: true, count: 12 }, counts: { stable: 40, both: 2, total: 54, analysed: 20, pending: 34, skipped: 3 } };
    assert.equal(libraryText(st), "osu! stable: 42 4K maps · Interlude: 12 · 20 of 54 analysed · not rice (LN etc.): 3");
    assert.match(phaseText(st), /34 to go/);
    assert.equal(libraryText({ ...st, songsDir: null, interlude: { linked: false } }).split(" · ")[0], "no Songs folder found");
    setLang("ru");
    assert.equal(libraryText({ ...st, interlude: { linked: false } }), "osu! stable: 42 карт 4K · проанализировано 20 из 54 · не райс (LN и т. п.): 3");
});

test("osu! lazer: its count in the library line when read, a note only when it could not be read", () => {
    setLang("en");
    const base = { phase: "done", songsDir: "C:\\osu!\\Songs", interlude: { linked: false }, counts: { stable: 40, both: 0, total: 47, analysed: 47 } };
    assert.equal(libraryText({ ...base, lazer: { found: true, count: 7 } }), "osu! stable: 40 4K maps · osu! lazer: 7 · 47 of 47 analysed");
    assert.equal(libraryText({ ...base, lazer: { found: false, count: 0 } }), "osu! stable: 40 4K maps · 47 of 47 analysed");
    assert.equal(libraryText({ ...base, lazer: { found: true, count: 0, error: "locked" } }), "osu! stable: 40 4K maps · 47 of 47 analysed");
    assert.deepEqual(libraryNotes({ ...base, lazer: { found: true, count: 7 } }), [], "lazer read: no note");
    assert.deepEqual(libraryNotes({ ...base, lazer: { found: false, count: 0 } }), [], "lazer not installed: no note");
    assert.deepEqual(libraryNotes({ ...base, lazer: { found: true, count: 0, error: "locked" } }), ["osu! lazer's maps were not read: locked"]);
    assert.equal(libraryNotes({ ...base, songsDir: null }).length, 1, "the Songs hint");
    setLang("ru");
    assert.equal(libraryText({ ...base, lazer: { found: true, count: 7 } }).split(" · ")[1], "osu! lazer: 7");
    assert.match(libraryNotes({ ...base, lazer: { found: true, error: "locked" } })[0], /^Карты osu! lazer не прочитаны: locked$/);
    setLang("en");
});

test("a lazer-only item: 'lazer' as its source, the Interlude playlist looks it up by the .osu's md5", () => {
    const lz = item({ sources: { lazer: { hash: "e".repeat(64), md5: "c".repeat(32) } } });
    assert.equal(sourceText(lz.sources), "lazer");
    assert.equal(sourceText({ stable: { path: "C:\\x.osu", md5: "a".repeat(32) }, lazer: { hash: "e".repeat(64) } }), "osu! + lazer");
    assert.equal(itemParts(lz).at(-1).text, "lazer");
    const [fromLazer, both] = playlistItems([lz, item()]);
    assert.deepEqual(fromLazer, { hash: undefined, md5: "c".repeat(32), path: undefined, rate: 1.1, label: "Alpha - Song [Hard]" });
    assert.deepEqual(both, { hash: "B".repeat(64), md5: "a".repeat(32), path: "C:\\x.osu", rate: 1.1, label: "Alpha - Song [Hard]" });
    assert.deepEqual(playlistItems(undefined), []);
});
