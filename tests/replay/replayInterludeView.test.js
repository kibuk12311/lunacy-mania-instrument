// The Replay tab with an Interlude play, through the fake DOM: replay-open's answer for a play (built here from a made-up
// osu! replay opened by main's real service, then given the fields of an Interlude analysis: a ruleset of six judgements,
// counts per judgement, points per note, the combo breaks the ruleset makes) is shown with its ruleset: one column of the
// ruleset's judgements, a select of the rulesets that opens the play again, the fallback said, no header column, no
// HitPosition; the reasons of a play that cannot be judged; the playback's totals, combo and judgement text; a play that
// just ended in Interlude; the profile's Interlude plays matched to theirs. Made-up plays only.
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
import { playbackData, keysAt, popupAt, totalAccuracy, judgementOfMs, comboAt, lastAtOrBefore, ilAccText, ilAccDigits } from "../../app/renderer/replayView.js";
import { exactTime } from "../../app/renderer/replayReport.js";
import { KINDS } from "../../src/replay/judge.js";
import { analyzeIlReplay } from "../../src/replay/analyzeInterlude.js";
import { judgeIlReplay, COMBO } from "../../src/interlude/judge.js";
import { ilPresses } from "../../src/interlude/replay.js";
import { SC_J4, parseRuleset } from "../../src/interlude/ruleset.js";
import { NOTE } from "../../src/interlude/chart.js";
import { osuRuleset, wife3Json, quaverJson, rulesetJson } from "../interlude/rulesets.js";
import { maniaConfig } from "../../src/skin/maniaFields.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => { setImmediate(r); }); };
const PLAY = `interlude:${"c".repeat(64)}:1790000000000`;
// SC J4 as the analysis gives it: names, colours, which judgements break the combo, its slot, windows in real ms
const SC = [
    { name: "Marvellous", color: "#00ffff", breaksCombo: false, slot: "max", early: -22.5, late: 22.5 },
    { name: "Perfect", color: "#ffff00", breaksCombo: false, slot: "n300", early: -45, late: 45 },
    { name: "Great", color: "#00ff64", breaksCombo: false, slot: "n200", early: -90, late: 90 },
    { name: "Good", color: "#0000ff", breaksCombo: true, slot: "n100", early: -135, late: 135 },
    { name: "Bad", color: "#ff00ff", breaksCombo: true, slot: "n50", early: -180, late: 180 },
    { name: "Miss", color: "#ff0000", breaksCombo: true, slot: "miss", early: null, late: null },
];
const POINTS = [1, 0.9, 0.5, -0.5, -1, -1];
const RULESETS = [{ id: "sc-j4", name: "SC J4" }, { id: "osu-od8", name: "osu!mania OD8" }];

async function oneReplay(t2, { count = 60 } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lm-replay-il-"));
    t2.after(() => rm(root, { recursive: true, force: true }));
    const game = path.join(root, "osu");
    const notes = rollNotes({ count, stepMs: 120 });
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
    return { file, service };
}

// replay-open's answer for an Interlude play, from an osu! one: each note judged by its osu! kind's place in SC J4, the
// 11th note a Good (which breaks the combo in SC though it is no miss); a step of the playback per note, at its judgement
function interludeOpen(r, { failed = false, fallback = false, ruleset = { id: "sc-j4", name: "SC J4" } } = {}) {
    const a = r.analysis;
    let combo = 0;
    let max = 0;
    const breaks = [];
    const steps = [];
    const results = a.results.map((x, i) => {
        const j = i === 10 ? 3 : KINDS.indexOf(x.kind);
        const broke = SC[j].breaksCombo;
        if (broke) breaks.push({ t: x.t, col: x.col, combo });
        combo = broke ? 0 : combo + 1;
        max = Math.max(max, combo);
        steps.push({ t: x.at, combo, j, points: POINTS[j] });
        return { ...x, kind: SC[j].slot, j, points: POINTS[j], weight: 1, breaks: broke, early: false };
    });
    const judgementCounts = SC.map((_, i) => results.filter((x) => x.j === i).length);
    const accuracy = (results.reduce((sum, x) => sum + x.points, 0) / results.length) * 100;
    const counts = Object.fromEntries(KINDS.map((k, i) => [k, judgementCounts[i]]));
    const analysis = {
        ...a, source: "interlude", exact: true, failed, od: null, scoreV2: false, holdHeavy: false, headerCounts: null, headerCombo: null, comparison: null,
        ruleset: { name: ruleset.name, judgements: SC }, judgementCounts, counts, accuracy, accuracyText: `${accuracy.toFixed(2)}%`, lamp: "SDCB", grade: "A",
        combo: { max, breaks }, steps, results, misses: [],
    };
    const replay = { at: Date.UTC(2026, 9, 1, 12), modNames: ["Mirror"], rate: 1, source: "interlude", play: PLAY, failed };
    return { ...r, replay, analysis, reason: null, rulesets: RULESETS, ruleset: { ...ruleset, fallback } };
}

function mount(api = {}) {
    setLang("en");
    const on = {};
    const asked = { open: [], bias: 0 };
    const full = {
        replayList: async () => ({ ok: true, folder: null, items: [] }), replaySkin: async () => ({ ok: true, skins: [], current: null, chosen: null, config: maniaConfig(new Map()), images: {}, mania4: false }),
        replayAudio: async () => ({ ok: false, stale: true }), replayDetails: async () => ({ ok: false }), replayEarlier: async () => ({ ok: false }),
        replayBias: async () => { asked.bias += 1; return { ok: true, plays: [], position: null }; },
        onReplayEnded: (cb) => { on.ended = cb; }, onReplayFolder: () => {}, onReplayProgress: () => {},
        ...api,
    };
    const open = full.replayOpen;
    full.replayOpen = async (request) => { asked.open.push(request); return open(request); };
    const dom = fakeDom(full);
    globalThis.Option = class { constructor(label, value, _d, selected) { this.textContent = label; this.value = value; this.selected = Boolean(selected); this.children = []; } };
    globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
    dom.$("rp-manip").querySelector = () => ({ open: false });
    globalThis.document.createTextNode = (value) => ({ textContent: value, children: [] });
    const make = globalThis.document.createElement;
    globalThis.document.createElementNS = (_ns, tag) => Object.assign(make(tag), { setAttribute() {}, appendChild() {} });
    const tab = initReplayTab({ $: dom.$, api: full });
    onReplayTabShown();
    return { ...dom, tab, on, asked };
}

const all = (node) => [node, ...node.children.flatMap(all)];
const fold = (m, id) => m.$("rp-details").children.find((s) => s.dataset?.sec === id);
const selectIn = (node) => all(node).find((n) => n.tagName === "SELECT");

test("an Interlude play opens with its ruleset: one column of the ruleset's judgements, its tiles, no header notes", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const opened = interludeOpen(await service.open({ file }));
    const m = mount({ replayOpen: async () => opened });
    assert.equal(await m.tab.openReplay({ play: PLAY }), true);
    await flush();
    assert.equal(m.$("rp-map").textContent, "Test - Fixture Roll [Rolls]");
    const head = textOf(m.$("rp-who"));
    assert.match(head, /^Interlude · /);
    assert.match(head, /Mirror/);
    assert.doesNotMatch(head, /failed/);
    assert.deepEqual(selectIn(m.$("rp-who")).children.map((o) => [o.value, o.selected]), [["sc-j4", true], ["osu-od8", false]]);
    assert.equal(m.$("rp-reason").hidden, true);
    assert.equal(m.$("rp-play").hidden, false);

    const judgements = fold(m, "judgements");
    const tableNode = all(judgements).find((n) => n.tagName === "TABLE");
    assert.deepEqual(tableNode.children[0].children.map((th) => th.textContent), [t("replay.judge.kind"), t("replay.judge.count")], "one column, no In the replay");
    const rows = tableNode.children.slice(1);
    assert.deepEqual(rows.map((tr) => tr.children[0].children[1].textContent), SC.map((j) => j.name));
    assert.deepEqual(rows.map((tr) => tr.children[0].children[0].style.background), SC.map((j) => j.color));
    assert.deepEqual(rows.map((tr) => tr.children[1].textContent), opened.analysis.judgementCounts.map(String));
    assert.equal(rows[3].children[1].textContent, "1", "the Good");
    const said = textOf(judgements);
    assert.match(said, /by the ruleset SC J4/);
    assert.match(said, /Lamp SDCB · Grade A/);
    for (const key of ["replay.judge.header", "replay.judge.ours", "replay.judge.same", "replay.judge.v2", "replay.judge.holds", "replay.judge.holdHeavy"]) {
        assert.doesNotMatch(textOf(m.$("rp-details")), new RegExp(t(key).slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), key);
    }

    const tiles = m.$("rp-stats").children;
    assert.deepEqual(tiles.map((tile) => tile.children[1].textContent), [opened.analysis.accuracyText, opened.analysis.ur.toFixed(1), "0", String(opened.analysis.combo.max)]);
    assert.equal(tiles[0].title, t("replay.stat.ilAccuracy", { name: "SC J4" }));
    assert.equal(tiles[1].title, t("replay.stat.urTitleIl"));
    assert.doesNotMatch(tiles[1].title, /osu!/);

    const fingerRows = all(fold(m, "fingers")).filter((n) => n.tagName === "TR").map((tr) => tr.children[0].textContent);
    assert.ok(["Marvellous", "Perfect", "Good"].every((name) => fingerRows.includes(name)), "the fingers' rows by the ruleset's names");
    assert.ok(!fingerRows.includes("MAX") && !fingerRows.includes("300"));

    const breaks = textOf(fold(m, "breaks"));
    assert.doesNotMatch(breaks, /No misses/, "a Good broke the combo with no miss");
    assert.match(breaks, /combo breaks: 1/);
    const row = all(fold(m, "breaks")).find((n) => n.className === "rp-break");
    assert.equal(row.children[3].textContent, "Good", "why it broke: the judgement");
    assert.equal(m.asked.bias, 0, "no lean asked: it speaks of osu!'s HitPosition");
});

test("the ruleset select opens the play again judged by the one picked; a fallback says so", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const base = await service.open({ file });
    let answer = interludeOpen(base, { fallback: true, ruleset: { id: "sc-j4-builtin", name: "SC J4" } });
    const m = mount({ replayOpen: async () => answer });
    await m.tab.openReplay({ play: PLAY });
    await flush();
    assert.match(textOf(m.$("rp-who")), new RegExp(t("replay.head.fallback", { name: "SC J4" }).slice(0, 40)));
    const select = selectIn(m.$("rp-who"));
    assert.deepEqual(select.children.map((o) => o.value), ["sc-j4-builtin", "sc-j4", "osu-od8"], "the fallback is offered too");
    answer = interludeOpen(base, { ruleset: { id: "osu-od8", name: "osu!mania OD8" } });
    select.value = "osu-od8";
    await fire(select, "change");
    await flush();
    assert.deepEqual(m.asked.open.at(-1), { play: PLAY, ruleset: "osu-od8" });
    assert.doesNotMatch(textOf(m.$("rp-who")), /cannot be read/);
    assert.match(textOf(fold(m, "judgements")), /by the ruleset osu!mania OD8/);
});

test("an Interlude play's share of misses is counted by its ruleset's points, in its own words", async (t2) => {
    const { file, service } = await oneReplay(t2, { count: 120 });
    const base = await service.open({ file });
    const counts = { max: 90, n300: 0, n200: 0, n100: 0, n50: 0, miss: 10, accuracy: 90 };
    const osu = mount({ replayOpen: async () => ({ ...base, replay: { ...base.replay, counts } }) });
    await osu.tab.openReplay({ file });
    await flush();
    assert.match(textOf(osu.$("rp-details")), /went on misses/, "osu!'s own counts tell it");
    // ten notes missed: SC takes a point away for each, so they cost 20 of the 120 notes' points; the header's counts
    // (osu!'s way, as a replay of osu! has them) are not read
    const opened = interludeOpen(base);
    opened.analysis.results = opened.analysis.results.map((r, i) => (i % 12 === 5 ? { ...r, j: 5, kind: "miss", points: -1, press: null, delta: null, breaks: true } : r));
    // the engine's totals of those results
    opened.analysis.judgementCounts = SC.map((_, j) => opened.analysis.results.filter((r) => r.j === j).length);
    opened.analysis.accuracy = (opened.analysis.results.reduce((sum, r) => sum + r.points, 0) / opened.analysis.results.length) * 100;
    const m = mount({ replayOpen: async () => ({ ...opened, replay: { ...opened.replay, counts } }) });
    await m.tab.openReplay({ play: PLAY });
    await flush();
    const said = textOf(m.$("rp-details"));
    const lost = opened.analysis.results.reduce((sum, r) => sum + 1 - r.points, 0) / 1.2;
    assert.ok(said.includes(`The accuracy is ${Math.round(lost * 10) / 10} % short of 100 %, and 16.7 % of that was lost on misses`), said);
    assert.doesNotMatch(said, /went on misses/);
    assert.doesNotMatch(said, /HitPosition/);
});

test("a failed play: counted to its last press, the accuracy is the recount's, Interlude's own over the whole chart in its title", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const opened = interludeOpen(await service.open({ file }), { failed: true });
    opened.analysis.wholeAccuracyText = "-79.02%";
    const m = mount({ replayOpen: async () => opened });
    await m.tab.openReplay({ play: PLAY });
    await flush();
    assert.match(textOf(m.$("rp-who")), /failed/);
    const [accuracy] = m.$("rp-stats").children;
    assert.equal(accuracy.children[1].textContent, `${opened.analysis.accuracy.toFixed(2)} %`);
    assert.equal(accuracy.title, t("replay.stat.ilFailed", { whole: "-79.02%" }));
    assert.match(accuracy.title, /whole chart.*-79\.02%/);
    assert.match(textOf(fold(m, "judgements")), new RegExp(t("replay.judge.failed")));
    for (const lang of ["ru", "en"]) {
        setLang(lang);
        assert.doesNotMatch(t("replay.stat.ilFailed", { whole: "1%" }), /no accuracy|не показывает/, "Interlude does show one");
    }
    setLang("en");
});

test("a failed play is not set against earlier whole plays: no line that it beat them, its row said failed", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const base = await service.open({ file });
    const earlier = (failed, accuracy) => ({ ok: true, plays: [{ at: Date.UTC(2026, 8, 1), rate: 1, modNames: [], failed, accuracy, misses: 0, maxCombo: 9, ur: 50, manip: 1, pairs: 4, whole: true, exact: true }], total: 1 });
    for (const failed of [true, false]) {
        const opened = interludeOpen(base, { failed });
        const m = mount({ replayOpen: async () => opened, replayEarlier: async () => earlier(false, opened.analysis.accuracy - 3) });
        await m.tab.openReplay({ play: PLAY });
        await flush();
        const said = textOf(fold(m, "earlier"));
        const now = all(fold(m, "earlier")).find((n) => n.className === "rp-now");
        if (failed) {
            assert.doesNotMatch(said, /above the earlier|under the best/, said);
            assert.equal(now.children[0].textContent, `${t("replay.earlier.now")} · ${t("replay.list.failed")}`);
        } else {
            assert.ok(said.includes(t("replay.earlier.best", { delta: "3.00" })), "a whole play is compared as before");
            assert.equal(now.children[0].textContent, t("replay.earlier.now"));
        }
    }
});

test("a press that met no note and broke the combo (a ruleset's GhostTapJudgement) is listed with its judgement", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const opened = interludeOpen(await service.open({ file }));
    opened.analysis.combo.breaks = [...opened.analysis.combo.breaks, { t: opened.analysis.results.at(-1).t + 50, col: 2, combo: 7, ghost: true, j: 5 }];
    const m = mount({ replayOpen: async () => opened });
    await m.tab.openReplay({ play: PLAY });
    await flush();
    const rows = all(fold(m, "breaks")).filter((n) => n.className === "rp-break");
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[1].children[3].textContent, rows[1].children[4].textContent], ["Miss", t("replay.break.combo", { n: 7 })]);
    assert.notEqual(rows[1].children[3].textContent, t("replay.break.none"));
});

test("a hold that breaks the combo at its head and again later: each row at its own time, its end told as the hold's end", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const opened = interludeOpen(await service.open({ file }));
    const r = opened.analysis.results[3];
    opened.analysis.combo.breaks = [{ t: r.t, col: r.col, combo: 5 }, { t: r.t, col: r.col, combo: 2, at: r.t + 400 }, { t: r.t, col: r.col, combo: 1, at: r.t + 900, end: true }];
    const m = mount({ replayOpen: async () => opened });
    await m.tab.openReplay({ play: PLAY });
    await flush();
    const rows = all(fold(m, "breaks")).filter((n) => n.className === "rp-break");
    assert.deepEqual(rows.map((row) => row.children[0].textContent), [exactTime(r.t), exactTime(r.t + 400), exactTime(r.t + 900)]);
    assert.equal(rows[2].children[2].textContent, t("replay.shape.holdEnd"));
    assert.notEqual(rows[1].children[2].textContent, t("replay.shape.holdEnd"), "let go in its body: not its end");
    for (const lang of ["ru", "en"]) {
        setLang(lang);
        assert.match(t("replay.shape.holdEnd"), lang === "ru" ? /конец холда/ : /hold end/);
    }
    setLang("en");
});

test("ruleset picks answered out of order: the last one picked is shown and its session kept", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const base = await service.open({ file });
    const waits = {};
    let n = 0;
    const asked = []; // the ids the earlier plays are asked for: the session the tab works with
    const m = mount({
        replayEarlier: async (request) => { asked.push(request.id); return { ok: false }; },
        replayOpen: (request) => {
            const ruleset = request.ruleset ?? "sc-j4";
            const answer = { ...interludeOpen(base, { ruleset: RULESETS.find((r) => r.id === ruleset) }), id: (n += 1) };
            if (!request.ruleset) return Promise.resolve(answer);
            // as main answers: an open overtaken by one asked after it comes back stale
            return new Promise((resolve) => { waits[ruleset] = () => resolve(answer.id === n ? answer : { ok: false, stale: true }); });
        },
    });
    await m.tab.openReplay({ play: PLAY });
    await flush();
    const select = selectIn(m.$("rp-who"));
    select.value = "osu-od8";
    void fire(select, "change");
    select.value = "sc-j4";
    void fire(select, "change");
    await flush();
    waits["sc-j4"]();
    await flush();
    waits["osu-od8"](); // the older pick answers last
    await flush();
    assert.equal(selectIn(m.$("rp-who")).value, "sc-j4");
    assert.match(textOf(fold(m, "judgements")), /by the ruleset SC J4/);
    assert.deepEqual([asked.at(-1), asked.includes(2)], [3, false], "the last pick's session, the older answer never shown");
});

test("an Interlude accuracy short of 100 % never reads 100.00 %: the list row, the earlier plays, the playback", async (t2) => {
    assert.deepEqual([99.998, 99.99999, 100, 99.5, -12.5, null].map(ilAccText), ["99.998 %", "100.0000 %", "100.00 %", "99.50 %", "-12.50 %", "—"]);
    assert.equal(ilAccDigits(99.98), "99.98");
    assert.equal(ilAccDigits(99.985), "99.985");
    const { file, service } = await oneReplay(t2);
    const opened = interludeOpen(await service.open({ file }));
    // every judgement a hair short of full points: 99.998 % all along
    opened.analysis.steps = opened.analysis.steps.map((x) => ({ ...x, j: 0, points: 0.99998, combo: x.combo }));
    const item = { kind: "interlude", play: PLAY, chart: "c".repeat(64), at: 1790000000000, rate: 1, modNames: [], accuracy: 99.998, miss: 0, failed: false, title: "Fixture Roll" };
    const m = mount({
        replayOpen: async () => opened,
        replayList: async () => ({ ok: true, folder: null, items: [item], interlude: { linked: true, ok: true } }),
        replayEarlier: async () => ({ ok: true, plays: [{ at: Date.UTC(2026, 8, 1), rate: 1, modNames: [], failed: false, accuracy: 99.998, misses: 0, maxCombo: 9, ur: 50, manip: 1, pairs: 4, whole: true, exact: true }], total: 1 }),
    });
    await flush();
    const row = all(m.$("rp-list")).find((n) => n.className === "rp-row");
    assert.match(textOf(row.children[0]), /\| 99\.998 %$/, "the list row");
    assert.match(row.title, /accuracy 99\.998 %/);
    await m.tab.openReplay({ play: PLAY });
    await flush();
    const rows = all(fold(m, "earlier")).filter((n) => n.tagName === "TR");
    assert.equal(rows.at(-1).children[1].textContent, "99.998 %", "an earlier play");
    // the playback's accuracy, drawn on the stage's panel
    const written = [];
    const real = m.$("rp-stage").getContext("2d");
    m.$("rp-stage").getContext = () => new Proxy(real, {
        get: (target, key) => (key === "fillText" ? (text, ...rest) => { written.push(text); target.fillText(text, ...rest); } : target[key]),
        set: (target, key, value) => { target[key] = value; return true; },
    });
    await fire(all(fold(m, "breaks")).find((n) => n.className === "rp-break"));
    assert.ok(written.includes("99.998 %"), `the playback (${written.join(", ")})`);
    assert.ok(!written.includes("100.00 %"));
});

test("an Interlude play that cannot be judged says why, and shows no numbers it does not have", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const base = await service.open({ file });
    const replay = { at: 1, modNames: ["Shuffle"], rate: 1, source: "interlude", play: PLAY, failed: false };
    for (const [reason, map] of [["mods", base.map], ["nochart", null], ["badReplay", base.map], ["keys", base.map], ["empty", base.map]]) {
        const m = mount({ replayOpen: async () => ({ ok: true, id: 9, replay, map, presses: [], analysis: null, reason, mods: ["Shuffle"], rulesets: RULESETS, ruleset: { id: "sc-j4", name: "SC J4", fallback: false } }) });
        assert.equal(await m.tab.openReplay({ play: PLAY }), true);
        await flush();
        assert.equal(m.$("rp-reason").hidden, false, reason);
        assert.equal(m.$("rp-reason").textContent, t(`replay.reason.${reason}`, { mods: "Shuffle" }));
        assert.equal(m.$("rp-stats").children.length, 0, `${reason}: no tiles`);
        assert.equal(m.$("rp-details").children.length, 0, `${reason}: no table of counts it does not have`);
        assert.equal(m.$("rp-play").hidden, true);
        assert.equal(selectIn(m.$("rp-who")), undefined, "nothing judged: no ruleset to switch");
        if (reason === "nochart") assert.equal(m.$("rp-map").textContent, "chart cccccccc…");
        if (reason === "mods") assert.match(m.$("rp-reason").textContent, /mods are not supported yet: Shuffle\./, "the mods named");
    }
});

test("a play that just ended in Interlude opens by its id, or says why there is none", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const opened = interludeOpen(await service.open({ file }));
    const m = mount({ replayOpen: async () => opened });
    const play = { source: "interlude", outcome: "pass", artist: "Test", title: "Fixture Roll", version: "Rolls", accuracy: null, file: null, reason: null };
    await m.on.ended({ ...play, waiting: true });
    assert.equal(m.$("rp-ended").children[0].textContent, t("replay.ended.ilWaiting", { map: "Test - Fixture Roll [Rolls]" }));
    await m.on.ended({ ...play, play: PLAY });
    await flush();
    assert.deepEqual(m.asked.open, [{ play: PLAY }]);
    assert.equal(m.$("rp-ended").children[0].textContent, t("replay.ended.opened", { map: "Test - Fixture Roll [Rolls]" }));
    await m.on.ended({ ...play, play: null, reason: "none" });
    assert.equal(m.$("rp-ended").children[0].textContent, t("replay.ended.ilNone", { map: "Test - Fixture Roll [Rolls]" }));
    await m.on.ended({ ...play, outcome: "quit", play: null, reason: "none", artist: null, title: null, version: null });
    assert.equal(m.$("rp-ended").children[0].textContent, t("replay.ended.ilQuit", { map: "chart …" }));
    // Interlude's folder could not be read: no score could be looked for, whatever the play's end
    for (const outcome of ["finished", "quit"]) {
        await m.on.ended({ ...play, outcome, play: null, reason: "noFolder" });
        assert.equal(m.$("rp-ended").children[0].textContent, t("replay.ended.ilNoFolder", { map: "Test - Fixture Roll [Rolls]" }), outcome);
    }
    // Interlude turned off in ⚙ Settings while its row was waited for: the waiting note goes, nothing else is said
    await m.on.ended({ ...play, waiting: true });
    await m.on.ended({ ...play, outcome: "finished", play: null, reason: "off" });
    assert.equal(m.$("rp-ended").hidden, true);
    assert.equal(m.$("rp-ended").children.length, 0);
    assert.equal(m.asked.open.length, 1);
});

test("Interlude's folder unlinked while a play's row is waited for says so where it is, and leaves ⚙ Settings open", async () => {
    const m = mount({ replayOpen: async () => ({ ok: false, message: "x" }) });
    const tabs = [];
    const onTab = (e) => tabs.push(e.detail);
    window.addEventListener("open-tab", onTab);
    try {
        const play = { source: "interlude", outcome: "finished", artist: "Test", title: "Fixture Roll", version: "Rolls", accuracy: null, file: null, play: null, reason: null };
        await m.on.ended({ ...play, waiting: true });
        await m.on.ended({ ...play, reason: "noFolder" });
        assert.equal(m.$("rp-ended").children[0].textContent, t("replay.ended.ilNoFolder", { map: "Test - Fixture Roll [Rolls]" }));
        assert.deepEqual(tabs, [], "unlinking is done in ⚙ Settings: the tab does not switch and close it");
        // a folder that cannot be read when the play ends, with no wait before, still brings the Replay tab up
        await m.on.ended({ ...play, reason: "noFolder" });
        assert.deepEqual(tabs, [{ tab: "replay" }]);
    } finally {
        window.removeEventListener("open-tab", onTab);
    }
});

test("the profile's Interlude plays find their saved play by id, and an osu! play never takes an Interlude one", async () => {
    const item = { kind: "interlude", play: PLAY, chart: "c".repeat(64), at: 1790000000000, rate: 1, modNames: [], accuracy: 97.5, miss: 1, failed: false, title: "Fixture Roll" };
    const m = mount({
        replayOpen: async () => ({ ok: false, message: "x" }),
        replayList: async () => ({ ok: true, folder: null, items: [item], interlude: { linked: true, ok: true } }),
        localProfileHistory: async () => ({
            ok: true, plays: [
                { id: PLAY, client: "interlude", md5: null, title: "Fixture Roll", at: 1790000000000, accuracy: 97.5, rate: 1 },
                { id: "stable:1", client: "stable", md5: null, title: "Other", at: 1790000000000, accuracy: 90, rate: 1 },
            ],
        }),
    });
    const spans = m.$("rp-source").children;
    await fire(spans[1]);
    await flush();
    const game = m.$("rp-game");
    assert.equal(all(game).find((n) => n.textContent === t("replay.game.howIl")).hidden, false, "the word on Interlude's own replays");
    const rows = all(game).filter((n) => n.className === "rp-game-row");
    const open = rows[0].children.find((n) => n.tagName === "BUTTON");
    assert.ok(open, "the Interlude play has its replay");
    assert.equal(rows[1].children.find((n) => n.tagName === "BUTTON"), undefined, "an osu! play with no md5 does not take it");
    await fire(open);
    assert.deepEqual(m.asked.open, [{ play: PLAY }]);
});

// the playback's lists for an Interlude play: notes as played (no mirror again), totals per ruleset judgement and the
// combo as the analysis's steps give them, the accuracy from points, the judgement as text in its colour
test("playback of an Interlude play: totals by the ruleset, breaks where they are, accuracy from points, text judgements", () => {
    const results = [
        { t: 1000, col: 0, end: null, kind: "max", at: 1000, press: 1002, up: 1030, early: false, delta: 2, j: 0, points: 1, weight: 1, breaks: false },
        { t: 1100, col: 1, end: null, kind: "n100", at: 1180, press: 1180, up: 1200, early: false, delta: 80, j: 3, points: -0.5, weight: 1, breaks: true },
        { t: 1200, col: 2, end: null, kind: "n300", at: 1230, press: 1230, up: 1260, early: false, delta: 30, j: 1, points: 0.9, weight: 1, breaks: false },
        { t: 1300, col: 3, end: 1500, kind: "max", at: 1500, press: 1300, up: 1500, early: false, delta: 0, j: 0, points: 1, weight: 1, breaks: false },
    ];
    // SC judges a hold once, at its release; its head adds one to the combo with no judgement
    const steps = [
        { t: 1002, combo: 1, j: 0, points: 1 }, { t: 1180, combo: 0, j: 3, points: -0.5 }, { t: 1230, combo: 1, j: 1, points: 0.9 },
        { t: 1300, combo: 2, j: null, points: null }, { t: 1500, combo: 3, j: 0, points: 1 },
    ];
    const presses = [[{ t: 1002, up: 1030 }], [{ t: 1180, up: 1200 }], [{ t: 1230, up: 1260 }], [{ t: 1300, up: 1500 }, { t: 1600, up: 1620 }]];
    const analysis = { source: "interlude", rate: 1, results, steps, ruleset: { name: "SC J4", judgements: SC } };
    const data = playbackData({ map: { notes: results }, presses, analysis, modNames: [] });
    assert.deepEqual(data.notes.map((n) => n.col), [0, 1, 2, 3], "as played");
    assert.deepEqual(data.totals.map((x) => x.combo), [1, 0, 1, 3], "the Good breaks, an SC hold judged once still adds two");
    assert.deepEqual([comboAt(data, 1299), comboAt(data, 1300), comboAt(data, 1499)], [1, 2, 2], "the head's one when it is hit");
    assert.deepEqual(data.totals.at(-1).counts, [2, 1, 0, 1, 0, 0]);
    assert.equal(totalAccuracy(data, data.totals[1]), 25);
    assert.equal(totalAccuracy(data, data.totals.at(-1)), (2.4 / 4) * 100);
    assert.equal(data.ofPress[1].get(1180), "#0000ff", "a press's tick in its judgement's colour");
    assert.equal(data.ofPress[3].get(1600), undefined, "a stray press is grey");
    assert.equal(keysAt(data, 1190).judgement, null, "no skin picture for a ruleset's judgement");
    assert.deepEqual(popupAt(data, 1190), { text: "Good", colour: "#0000ff", since: 10 });
    assert.equal(popupAt(data, 900), null);

    const osu = playbackData({ map: { notes: results }, presses, analysis: { rate: 1, results: results.map((r, i) => ({ ...r, kind: ["max", "miss", "n300", "max"][i] })) } });
    assert.deepEqual(osu.totals.map((x) => x.combo), [1, 0, 1, 2], "osu!: a combo breaks on a miss");
    assert.equal(keysAt(osu, 1190).judgement.key, "Hit0");
    assert.equal(popupAt(osu, 1190), null);
    assert.equal(osu.ofPress[0].get(1002), "#8fd3ff");
});

// the HUD against the engine, event by event: rows [[chart ms, column, kind]], key events [[chart ms, column, down]], a
// failed play cut off at lastFrame (the keys as they are then) → each moment the engine changes the combo or gives a
// judgement, [time, the HUD's combo, the engine's], the same of the counts per judgement and of the accuracy (exactly),
// the playback's data and the analysis
function hudAgainstEngine(ruleset, rows, keyEvents, { failed = false, lastFrame = null } = {}) {
    const notes = [];
    for (const [time, col, kind] of rows) {
        const row = notes.find((n) => n.time === time);
        if (row) row.data[col] = kind;
        else notes.push({ time, data: [0, 0, 0, 0].map((x, c) => (c === col ? kind : x)) });
    }
    notes.sort((a, b) => a.time - b.time);
    const chart = { keys: 4, notes, bpm: [{ time: 0, data: { msPerBeat: 500, meter: 4 } }], sv: [] };
    const first = Math.fround(notes[0].time);
    const times = [-500];
    const masks = [0];
    let mask = 0;
    for (const [at, col, down] of [...keyEvents].sort((a, b) => a[0] - b[0])) {
        mask = down ? mask | (1 << col) : mask & ~(1 << col);
        times.push(at - first);
        masks.push(mask);
    }
    times.push((lastFrame ?? notes.at(-1).time + 3000) - first);
    masks.push(failed ? mask : 0);
    const frames = { times: Float32Array.from(times), masks: Uint16Array.from(masks) };
    const analysis = analyzeIlReplay({ ruleset, chart, frames, rate: 1, failed });
    const data = playbackData({ map: { notes: [] }, presses: ilPresses(frames, 4, first), analysis, modNames: [] });
    const engine = new Map();
    let combo = 0;
    let points = 0;
    let judged = 0;
    const counts = ruleset.judgements.map(() => 0);
    for (const e of judgeIlReplay({ ruleset, chart, frames, rate: 1, untilLastFrame: failed }).events) {
        if (e.combo === COMBO.BREAK || e.combo === COMBO.BREAK_INSTEAD) combo = 0;
        else if (e.combo === COMBO.INCREASE) combo += 1;
        if (e.judgement !== null && e.judgement !== undefined) {
            counts[e.judgement] += 1;
            points += e.points;
            judged += 1;
        }
        engine.set(first + e.time, { combo, counts: [...counts], accuracy: judged ? (points / judged) * 100 : null });
    }
    const totalAt = (at) => data.totals[lastAtOrBefore(data.totals, at, (x) => x.at)] ?? null;
    return {
        moments: [...engine].map(([at, x]) => [at, comboAt(data, at), x.combo]),
        totals: [...engine].map(([at, x]) => [at, [totalAt(at)?.counts ?? counts.map(() => 0), totalAccuracy(data, totalAt(at))], [x.counts, x.accuracy]]),
        data, analysis,
    };
}

const N = NOTE.NORMAL;
const H = NOTE.HOLDHEAD;
const T = NOTE.HOLDTAIL;
// the combo, the counts and the accuracy the HUD shows are the engine's at every moment it changes them
const sameMoments = ({ moments, totals }, said) => {
    assert.deepEqual(moments.map(([at, hud]) => [at, hud]), moments.map(([at, , engine]) => [at, engine]), `${said}: the combo`);
    assert.deepEqual(totals.map(([at, hud]) => [at, hud]), totals.map(([at, , engine]) => [at, engine]), `${said}: the counts and the accuracy`);
};

test("playback combo of an Interlude play: a press at the very ms a missed note's window ends comes before the miss", () => {
    // SC J4: the tap at 1000 is missed, its window ends at 1180, the very ms the tap at 1180 of another column is hit; the
    // engine handles the press first, then the miss, whatever their columns
    const tie = hudAgainstEngine(SC_J4,
        [[900, 2, N], [1000, 0, N], [1180, 1, N], [1500, 3, N]],
        [[900, 2, true], [940, 2, false], [1180, 1, true], [1220, 1, false], [1500, 3, true], [1540, 3, false]]);
    sameMoments(tie, "a tie");
    assert.deepEqual([comboAt(tie.data, 1179), comboAt(tie.data, 1180), comboAt(tie.data, 1500)], [1, 0, 1], "the miss is the last word at 1180");
    assert.deepEqual(popupAt(tie.data, 1180), { text: "Miss", colour: "#ff0000", since: 0 });
});

test("playback combo of an Interlude play: a hold let go breaks the combo only where the engine drops it", () => {
    // SC J4, column 0: the head of the hold at 1000 is missed while the hold at 1100 is hit at 1100; when the first one's
    // head runs out (1180) Prelude's column follows it again, and once its tail has run out (1230) the column holds
    // nothing: the second hold's key going up at 1250 drops nothing, and the tap at 1500 does not cut it off either
    const reset = hudAgainstEngine(SC_J4,
        [[1000, 0, H], [1050, 0, T], [1100, 0, H], [1400, 0, T], [1500, 0, N], [2000, 3, N]],
        [[1100, 0, true], [1250, 0, false], [1500, 0, true], [1530, 0, false], [2000, 3, true], [2040, 3, false]]);
    sameMoments(reset, "a column's hold state reset");
    assert.equal(reset.analysis.steps.some((s) => s.t === 1250 || s.t === 1530), false, "no drop at either key going up");
    // osu! OD8: a hold let go twice and grabbed again, released on time: each drop breaks the combo when it happens
    const twice = hudAgainstEngine(osuRuleset(8),
        [[1000, 0, N], [2000, 1, H], [3000, 1, T], [3500, 2, N]],
        [[1000, 0, true], [1040, 0, false], [2000, 1, true], [2200, 1, false], [2300, 1, true], [2500, 1, false], [2600, 1, true], [3000, 1, false], [3500, 2, true], [3540, 2, false]]);
    sameMoments(twice, "let go twice");
    assert.deepEqual([2199, 2200, 2400, 2500, 2999, 3000].map((ms) => comboAt(twice.data, ms)), [2, 0, 0, 0, 0, 1]);
});

test("playback combo of a failed Interlude play: a hold's head hit before the last frame adds its one", () => {
    // SC J4, cut off at 1500 with the hold of 1200 still held: its end never came, so it has no result, but its head did
    const failed = hudAgainstEngine(SC_J4,
        [[1000, 0, N], [1200, 1, H], [3000, 1, T], [4000, 2, N]],
        [[1000, 0, true], [1040, 0, false], [1200, 1, true]], { failed: true, lastFrame: 1500 });
    sameMoments(failed, "failed");
    assert.equal(failed.analysis.results.some((r) => r.t === 1200), false);
    assert.deepEqual([comboAt(failed.data, 1199), comboAt(failed.data, 1200), comboAt(failed.data, 9000)], [1, 2, 2]);
    // the stage agrees with the HUD: it draws the hold, its press in the colour of the window the head's error falls in
    // (SC judges a hold only at its end), and the hold held
    assert.deepEqual(failed.analysis.unfinished.map((r) => [r.t, r.col, r.end, r.press, r.j, r.delta]), [[1200, 1, 3000, 1200, null, 0]]);
    assert.deepEqual(failed.data.notes.map((n) => [n.t, n.col, n.end, n.gone]), [[1000, 0, null, 1000], [1200, 1, 3000, Infinity]]);
    assert.equal(failed.data.ofPress[1].get(1200), "#00ffff");
    assert.deepEqual(failed.data.holds[1], [{ t: 1200, end: 3000 }]);
    assert.deepEqual(failed.data.hits[1], [1200]);
    const keys = keysAt(failed.data, 1300);
    assert.deepEqual([keys.pressed[1], keys.hold[1]], [true, true]);
    // a head missed, grabbed later and still held: drawn, its press in the miss's colour
    const late = hudAgainstEngine(SC_J4,
        [[1000, 0, N], [1200, 1, H], [3000, 1, T], [4000, 2, N]],
        [[1000, 0, true], [1040, 0, false], [1500, 1, true]], { failed: true, lastFrame: 1700 });
    sameMoments(late, "failed, head missed");
    assert.deepEqual(late.data.notes.map((n) => [n.t, n.col]), [[1000, 0], [1200, 1]]);
    assert.equal(late.data.ofPress[1].get(1500), "#ff0000");
    assert.deepEqual(late.data.holds[1], [{ t: 1500, end: 3000 }]);
    // a head missed and never grabbed: drawn too (the HUD breaks the combo for it), with no press, under each ruleset
    for (const [ruleset, said] of [[SC_J4, "SC J4"], [osuRuleset(8), "osu! OD8"], [parseRuleset(wife3Json(4)), "Wife3 J4"]]) {
        const never = hudAgainstEngine(ruleset,
            [[1000, 0, N], [1200, 1, H], [3000, 1, T], [4000, 2, N]],
            [[1000, 0, true], [1040, 0, false]], { failed: true, lastFrame: 1700 });
        sameMoments(never, `failed, head never grabbed, ${said}`);
        assert.ok(never.analysis.steps.some((x) => x.t > 1200 && x.combo === 0), `${said}: the head's miss breaks the combo`);
        assert.deepEqual(never.analysis.unfinished.map((r) => [r.t, r.col, r.end, r.press]), [[1200, 1, 3000, null]], said);
        assert.deepEqual(never.data.notes.map((n) => [n.t, n.col, n.end]), [[1000, 0, null], [1200, 1, 3000]], said);
        assert.deepEqual([never.data.ofPress[1].size, never.data.holds[1], never.data.hits[1]], [0, [], []], said);
    }
    // a hold let go before the last frame, its end never come: a result with no judgement (SC judges a hold at its end),
    // its press in the colour of the window the head's error falls in, as the HUD counted its head
    const letGo = hudAgainstEngine(SC_J4,
        [[1000, 0, N], [1200, 1, H], [3000, 1, T]],
        [[1000, 0, true], [1040, 0, false], [1230, 1, true], [1400, 1, false]], { failed: true, lastFrame: 1700 });
    sameMoments(letGo, "failed, let go");
    assert.deepEqual(letGo.analysis.results.filter((r) => r.t === 1200).map((r) => [r.press, r.j, r.dropped, r.delta]), [[1230, null, true, 30]]);
    assert.deepEqual([comboAt(letGo.data, 1230), comboAt(letGo.data, 1400)], [2, 0]);
    assert.equal(letGo.data.ofPress[1].get(1230), "#ffff00");
    // a whole play has none
    const whole = hudAgainstEngine(SC_J4, [[1000, 0, N], [1200, 1, H], [3000, 1, T]],
        [[1000, 0, true], [1040, 0, false], [1200, 1, true], [3000, 1, false]]);
    assert.deepEqual(whole.analysis.unfinished, []);
});

test("playback combo of an Interlude play: a hold's head judgement that breaks the combo breaks it at the head", () => {
    // Wife3 J4: the head 100 ms late (a Good, which breaks the combo), held to its end
    const wife3 = hudAgainstEngine(parseRuleset(wife3Json(4)),
        [[1000, 0, N], [2000, 1, H], [2500, 1, T], [3000, 2, N]],
        [[1000, 0, true], [1040, 0, false], [2100, 1, true], [2500, 1, false], [3000, 2, true], [3040, 2, false]]);
    sameMoments(wife3, "Wife3");
    assert.deepEqual(wife3.data.totals.map((x) => [x.at, x.combo, x.j]), [[1000, 1, 0], [2100, 0, 3], [3000, 2, 0]], "Wife3 judges the head, when it is hit");
    assert.deepEqual([comboAt(wife3.data, 2100), comboAt(wife3.data, 2500)], [0, 1], "the hold's release adds one after the Good broke it");
    assert.equal(Math.max(...wife3.data.combos.map((c) => c.combo)), wife3.analysis.combo.max);
    // releases judged apart (Quaver's way) with a head judgement that breaks the combo and a release on time
    const apart = parseRuleset(rulesetJson({
        name: "Apart", judgements: [18, 43, 76, 106, 127, 164].map((x, i) => [[-x, x], i >= 3]),
        hold: { JudgeReleasesSeparately: [[[-27, 27], [-64.5, 64.5], [-114, 114], [-190.5, 190.5], null, null], 4] },
        accuracy: { PointsPerJudgement: [1, 0.9825, 0.65, 0.25, -1.0, -0.5] },
    }));
    const separately = hudAgainstEngine(apart,
        [[1000, 0, N], [2000, 1, H], [2500, 1, T], [3000, 2, N]],
        [[1000, 0, true], [1040, 0, false], [2090, 1, true], [2500, 1, false], [3000, 2, true], [3040, 2, false]]);
    sameMoments(separately, "releases judged apart");
    assert.deepEqual(separately.data.totals.map((x) => x.combo), [1, 0, 1, 2], "the head and the release each judged, each when it happens");
    assert.deepEqual(separately.data.totals.at(-1).counts, separately.analysis.judgementCounts, "a hold judged twice counts twice");
});

test("playback combo of an Interlude play: notes inside a held hold change the combo when they are judged", () => {
    // a tap missed and one hit while a hold is held whole: the head's one is lost to the miss
    const missed = hudAgainstEngine(SC_J4,
        [[1000, 0, H], [2000, 0, T], [1500, 1, N], [1700, 2, N]],
        [[1000, 0, true], [2000, 0, false], [1700, 2, true], [1740, 2, false]]);
    sameMoments(missed, "a miss inside the hold");
    assert.equal(Math.max(...missed.data.combos.map((c) => c.combo)), missed.analysis.combo.max, "never above the combo tile");
    assert.deepEqual(missed.data.totals.map((x) => x.combo), [0, 1, 2]);
    // the hold let go and grabbed again, taps hit during its body: they count from the drop's 0
    const dropped = hudAgainstEngine(SC_J4,
        [[1000, 0, H], [2000, 0, T], [1400, 1, N], [1600, 2, N]],
        [[1000, 0, true], [1200, 0, false], [1300, 0, true], [2000, 0, false], [1400, 1, true], [1440, 1, false], [1600, 2, true], [1640, 2, false]]);
    sameMoments(dropped, "taps after a drop");
    // a hold missed whole, beside taps missed and hit
    const whole = hudAgainstEngine(SC_J4,
        [[1000, 0, N], [1200, 1, H], [1800, 1, T], [1300, 2, N], [1500, 3, N], [2400, 0, N]],
        [[1000, 0, true], [1040, 0, false], [1500, 3, true], [1540, 3, false], [2400, 0, true], [2440, 0, false]]);
    sameMoments(whole, "a hold missed whole");
});

// the HUD's combo against the engine's: a made-up chart of taps and holds judged by each kind of hold mechanics
test("playback combo of an Interlude play ends where the engine's does, for every hold mechanics", () => {
    const notes = [];
    const events = []; // [chart ms, column, down]
    const row = (time, col, kind) => {
        const data = [0, 0, 0, 0];
        data[col] = kind;
        notes.push({ time, data });
    };
    // the first hold: let go at 1200 and grabbed again at 1300, released at its end
    row(1000, 0, NOTE.HOLDHEAD);
    row(1500, 0, NOTE.HOLDTAIL);
    events.push([1000, 0, true], [1200, 0, false], [1300, 0, true], [1500, 0, false]);
    let t = 2000;
    for (let i = 0; i < 6; i += 1, t += 300) {
        row(t, i % 4, NOTE.NORMAL);
        events.push([t, i % 4, true], [t + 40, i % 4, false]);
    }
    for (let i = 0; i < 3; i += 1, t += 900) {
        row(t, i, NOTE.HOLDHEAD);
        row(t + 500, i, NOTE.HOLDTAIL);
        events.push([t, i, true], [t + 500, i, false]);
    }
    const chart = { keys: 4, notes, bpm: [{ time: 0, data: { msPerBeat: 500, meter: 4 } }], sv: [] };
    const first = notes[0].time;
    const frame = (dropFirst) => {
        const times = [-500];
        const masks = [0];
        let mask = 0;
        const list = dropFirst ? events : events.filter(([at]) => at !== 1200 && at !== 1300);
        for (const [at, col, down] of [...list].sort((a, b) => a[0] - b[0])) {
            mask = down ? mask | (1 << col) : mask & ~(1 << col);
            times.push(at - first);
            masks.push(mask);
        }
        times.push(t - first + 2000);
        masks.push(0);
        return { times: Float32Array.from(times), masks: Uint16Array.from(masks) };
    };
    const rulesets = [SC_J4, osuRuleset(8), parseRuleset(wife3Json(4)), parseRuleset(quaverJson())];
    for (const ruleset of rulesets) {
        for (const dropFirst of [false, true]) {
            const frames = frame(dropFirst);
            const analysis = analyzeIlReplay({ ruleset, chart, frames, rate: 1 });
            const data = playbackData({ map: { notes: [] }, presses: ilPresses(frames, 4, Math.fround(first)), analysis, modNames: [] });
            const said = `${ruleset.name}${dropFirst ? ", the first hold let go" : ""}`;
            if (!dropFirst) assert.equal(analysis.combo.max, 6 + 2 * 4, said);
            assert.equal(data.combos.at(-1).combo, analysis.combo.max, said);
            assert.equal(comboAt(data, t + 5000), analysis.combo.max, said);
            assert.equal(Math.max(...data.combos.map((c) => c.combo)), analysis.combo.max, said);
            assert.deepEqual(data.totals.at(-1).counts, analysis.judgementCounts, said);
            assert.equal(totalAccuracy(data, data.totals.at(-1)), analysis.accuracy, said);
        }
    }
});

test("hit errors are coloured by the ruleset's windows, early and late each by its own side", () => {
    const leaning = [{ name: "A", early: -10, late: 30 }, { name: "B", early: -50, late: 50 }, { name: "Miss", early: null, late: null }];
    assert.equal(judgementOfMs(leaning, 25), 0);
    assert.equal(judgementOfMs(leaning, -25), 1);
    assert.equal(judgementOfMs(leaning, 70), 1, "past every window: the widest");
    assert.equal(judgementOfMs(SC, -100), 3);
});

test("the stage draws an Interlude judgement as text in its colour", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const opened = interludeOpen(await service.open({ file }));
    const m = mount({ replayOpen: async () => opened });
    await m.tab.openReplay({ play: PLAY });
    await flush();
    // the text drawn and the colour it is drawn in
    const written = [];
    const real = m.$("rp-stage").getContext("2d");
    m.$("rp-stage").getContext = () => new Proxy(real, {
        get: (target, key) => (key === "fillText" ? (text, ...rest) => { written.push([text, target.fillStyle]); target.fillText(text, ...rest); } : target[key]),
        set: (target, key, value) => { target[key] = value; return true; },
    });
    // a second before the break: the note just judged before it has its judgement up
    await fire(all(fold(m, "breaks")).find((n) => n.className === "rp-break"));
    const popup = written.find(([text]) => SC.some((j) => j.name === text));
    assert.ok(popup, `a judgement's name drawn (${written.map(([text]) => text).join(", ")})`);
    assert.equal(popup[1], SC.find((j) => j.name === popup[0]).color, "in its colour");
    const panel = written.map(([text]) => text);
    assert.ok(panel.includes("MARV") && panel.includes("PERF") && panel.includes("Good"), "the panel's rows by the ruleset's short names");
    assert.ok(!panel.includes("MAX") && !panel.includes("300"));
});
