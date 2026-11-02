// The hints on the Replay tab, through the fake DOM with main's real service where a replay has to open: the block above the
// first fold and at the top of a fold, a hint with a place as a button, numbers the language's way, the tab asking for the lean
// of the latest plays, a late answer dropped, and what redraws them. Made-up plays only.
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
import { reportSections } from "../../app/renderer/replayReport.js";
import { buildReport } from "../../src/replay/report.js";
import { DEFAULT_FINGERS } from "../../src/replay/fingers.js";
import { HINTS } from "../../src/replay/hints.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => { setImmediate(r); }); };
const noSkins = { ok: true, skins: [], current: null, chosen: null, name: null, config: null, images: {}, mania4: false };

async function oneReplay(t2, { notes = rollNotes({ count: 60, stepMs: 120 }), presses = honestPresses(notes, { sdMs: 8 }) } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lm-replay-hints-"));
    t2.after(() => rm(root, { recursive: true, force: true }));
    const game = path.join(root, "osu");
    const chart = chartText(notes, { title: "Fixture Roll" });
    await mkdir(path.join(game, "Songs", "1 Roll"), { recursive: true });
    await writeFile(path.join(game, "Songs", "1 Roll", "x.osu"), chart);
    await mkdir(path.join(game, "Replays"), { recursive: true });
    const file = path.join(game, "Replays", "a.osr");
    await writeFile(file, makeOsr({ md5: createHash("md5").update(chart).digest("hex"), presses }));
    const userData = path.join(root, "user-data");
    const service = createReplayService({
        userData, env: {}, songsIndex: createSongsMd5Index({ indexFile: path.join(userData, "songs.json") }), tosu: async () => ({ game, songs: null, skin: null }),
    });
    return { file, service };
}

function mount(service, api = {}) {
    setLang("en");
    const full = {
        replayList: async () => ({ ok: true, folder: null, items: [] }), replaySkin: async () => noSkins, replayOpen: service.open, replayAudio: async () => ({ ok: false, stale: true }),
        replayDetails: async () => ({ ok: false }), replayEarlier: async () => ({ ok: false }), ...api,
    };
    const dom = fakeDom(full);
    globalThis.Option = class { constructor(label, value) { this.textContent = label; this.value = value; this.children = []; } };
    dom.$("rp-manip").querySelector = () => ({ open: false });
    globalThis.document.createTextNode = (value) => ({ textContent: value, children: [] });
    const make = globalThis.document.createElement;
    globalThis.document.createElementNS = (_ns, tag) => Object.assign(make(tag), { setAttribute() {}, appendChild() {} });
    const tab = initReplayTab({ $: dom.$, api: full });
    onReplayTabShown();
    return { ...dom, tab };
}

// a real analysis with hints made up here, so that what is drawn does not depend on the limits
async function ctxWith(t2, hints) {
    const { file, service } = await oneReplay(t2);
    mount(service);
    const r = await service.open({ file });
    const report = buildReport({ analysis: r.analysis, presses: r.presses, fingers: [...DEFAULT_FINGERS] });
    const seeks = [];
    return {
        seeks,
        ctx: {
            replay: r.replay, analysis: r.analysis, report, later: null, earlier: null, fingers: [...DEFAULT_FINGERS], hints, timeOf: (ms) => `${ms / 1000}s`, seek: (ms) => { seeks.push(ms); }, onFingers: () => {},
        },
    };
}
const plain = { id: "x.plain", section: "errors", key: "replay.hint.err.columnLate", params: { col: 3, ms: 8.5 }, weight: 2 };
const place = { id: "x.place", section: "hardest", key: "replay.hint.hard.part", params: { from: 89_000, to: 118_000, delta: 3.4 }, weight: 3, seek: 89_000 };
const named = { id: "x.named", section: "fingers", key: "replay.hint.finger.unevenBreaks", params: { finger: "R3", gap: 30, breaks: 6, of: 23 }, weight: 1 };
const fold = (sections, id) => sections.find((s) => s.dataset.sec === id);
const body = (section) => section.children[1];

test("the block above the first fold and the hints at the top of the folds", async (t2) => {
    const { ctx } = await ctxWith(t2, { top: [place, plain], bySection: { errors: [plain], fingers: [named] } });
    const sections = reportSections(ctx);
    const [main] = sections;
    assert.equal(main.className, "rp-main");
    assert.equal(main.children[0].textContent, t("replay.hint.main"));
    assert.equal(main.children.length, 3);
    assert.equal(sections[1].dataset.sec, "judgements", "the folds follow");
    const hints = body(fold(sections, "errors")).children[0];
    assert.equal(hints.className, "rp-hints");
    assert.equal(hints.children[0].className, "rp-hint");
    assert.equal(hints.children[0].textContent, "Column 3 is 8.5 ms later than the others.");
    assert.equal(hints.children[0].tagName, "DIV", "with no place it is plain text");
    assert.notEqual(body(fold(sections, "judgements")).children[0].className, "rp-hints", "a fold with none has no box");
    assert.equal(textOf(body(fold(sections, "fingers")).children[0]), "The right middle finger is the least even: UR 30 above the others, with 6 of 23 combo breaks on it.");
});

test("a hint with a place is a button that seeks there, read in the player's time", async (t2) => {
    const { ctx, seeks } = await ctxWith(t2, { top: [place], bySection: { hardest: [place] } });
    const [main] = reportSections(ctx);
    const row = main.children[1];
    assert.equal(row.tagName, "BUTTON");
    assert.match(row.className, /rp-hint-seek/);
    assert.equal(row.textContent, "89s–118s went 3.4 % under the rest of the map, start practising with this stretch.");
    assert.equal(row.title, t("replay.hint.seek"));
    await fire(row);
    assert.deepEqual(seeks, [89_000]);
});

test("words of a hint in Russian, with a Russian decimal comma", async (t2) => {
    const family = { id: "x", section: "families", key: "replay.hint.family.weak", params: { family: "jumpstream", ur: 180, on: "stream", otherUr: 130 }, weight: 1 };
    const glued = { id: "y", section: "manip", key: "replay.hint.manip.family", params: { families: "jumpstream", percent: 62 }, weight: 1 };
    const shape = { id: "z", section: "breaks", key: "replay.hint.break.none", params: { n: 6, of: 8, shape: "stream" }, weight: 1 };
    const dan = { id: "w", section: "parts", key: "replay.hint.part.dan", params: { easy: 13, hold: 97.5, hard: 14, fall: 91 }, weight: 1 };
    const { ctx } = await ctxWith(t2, { top: [plain, family, glued, shape, dan], bySection: {} });
    setLang("ru");
    try {
        const [main] = reportSections(ctx);
        assert.equal(main.children[0].textContent, "Главное");
        assert.deepEqual(main.children.slice(1).map((row) => row.textContent), [
            "3-я колонка на 8,5 мс позже остальных.",
            "Слабее всего джампстрим: UR 180 против 130 на стриме.",
            "Сильнее всего склеены джампстримы, 62 %.",
            "6 из 8 срывов на стримах, ноты не нажаты: похоже, это отставание, а не мимо.",
            "До Gamma mid держишь 97,5 %, с Delta mid падаешь до 91 %.",
        ]);
    } finally {
        setLang("en");
    }
});

test("the pace fold's line with no stretch to tell says just that, so a hint about lost notes beside it holds", async (t2) => {
    const ceiling = { id: "pace.ceiling", section: "pace", key: "replay.hint.pace.ceiling", params: { keep: 21 }, weight: 1 };
    const { ctx } = await ctxWith(t2, { top: [], bySection: {} });
    assert.equal(ctx.report.pace.stretches.length, 0, "a play with no stretch to tell");
    assert.equal(t("replay.pace.even"), "No sustained falling behind and no spam.");
    const said = textOf(fold(reportSections({ ...ctx, hints: { top: [], bySection: { pace: [ceiling] } } }), "pace"));
    assert.match(said, /You hold up to 21 presses a second/);
    assert.match(said, /No sustained falling behind/, "the line stays under a hint");
    assert.doesNotMatch(said, /kept level/);
    setLang("ru");
    try {
        assert.equal(t("replay.pace.even"), "Затяжных отставаний и спама не было.");
    } finally {
        setLang("en");
    }
});

test("on an Interlude play a hint about the window names the ruleset's judgement, not osu!'s OD", async (t2) => {
    const forgiven = { id: "manip.family", section: "manip", key: "replay.hint.manip.familyForgiven", params: { families: "jumpstream", percent: 62 }, weight: 1 };
    const { ctx } = await ctxWith(t2, { top: [forgiven], bySection: {} });
    const [osu] = reportSections(ctx);
    assert.match(osu.children[1].textContent, /stricter OD/);
    // src/replay/hints.js gives an Interlude play its own key, with the worst judgement the forgiven notes got
    const own = { ...forgiven, key: "replay.hint.manip.familyForgivenIl", params: { ...forgiven.params, judgement: "Perfect" } };
    const judgements = ["max", "n300", "n200", "n100", "n50", "miss"].map((slot, i) => ({ name: `J${i + 1}`, color: "#ffffff", breaksCombo: i > 2, slot, early: i < 5 ? -20 * (i + 1) : null, late: i < 5 ? 20 * (i + 1) : null }));
    const analysis = { ...ctx.analysis, source: "interlude", ruleset: { name: "SC J4", judgements }, judgementCounts: Object.values(ctx.analysis.counts), accuracyText: "99.00%" };
    const il = { ...ctx, analysis, replay: { ...ctx.replay, source: "interlude" }, hints: { top: [own], bySection: {} } };
    assert.equal(reportSections(il)[0].children[1].textContent, "Glued the most: jumpstreams, 62 %. The window lets it through here: most of those notes still get Perfect or better. A stricter ruleset would judge them lower.");
    setLang("ru");
    try {
        const said = reportSections(il)[0].children[1].textContent;
        assert.doesNotMatch(said, /OD|100-ки/);
        assert.match(said, /получает Perfect или лучше/);
    } finally {
        setLang("en");
    }
});

test("nothing stands out: no block, no box", async (t2) => {
    const { ctx } = await ctxWith(t2, { top: [], bySection: {} });
    const sections = reportSections(ctx);
    assert.equal(sections[0].dataset.sec, "judgements");
    assert.ok(sections.every((s) => body(s).children.every((kid) => kid.className !== "rp-hints")));
});

test("a replay with no analysis keeps its one fold, with what the header can say", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const m = mount(service, {
        replayOpen: async (request) => {
            const r = await service.open(request);
            return { ...r, map: null, analysis: null, reason: "nomap", folder: "x", replay: { ...r.replay, counts: { max: 90, n300: 0, n200: 0, n100: 0, n50: 0, miss: 10, accuracy: 90 } } };
        },
    });
    await m.tab.openReplay({ file });
    await flush();
    const kids = m.$("rp-details").children;
    assert.equal(kids[0].className, "rp-main");
    assert.equal(kids[1].dataset.sec, "judgements");
    assert.equal(kids.length, 2);
    assert.match(textOf(kids[0]), /10 % of accuracy lost, 10 % went on misses/);
});

// a lean of the latest plays that stands out
const leaning = (id, ms = 9) => ({
    ok: true, id, plays: Array.from({ length: HINTS.position.plays }, (_, i) => ({ md5: `map${i}`, at: i, mean: ms, hits: 1000 })),
    position: { hitPosition: 415, maniaSpeed: 24, speedPerMap: false, speedByBpm: false },
});
const details = (m) => textOf(m.$("rp-details"));

test("the tab asks for the lean without waiting for it, and the hint comes when it does", async (t2) => {
    const { file, service } = await oneReplay(t2);
    let answer = null;
    const asked = [];
    const m = mount(service, { replayBias: (request) => { asked.push(request); return new Promise((resolve) => { answer = resolve; }); } });
    assert.equal(await m.tab.openReplay({ file }), true, "the tab does not wait");
    await flush();
    assert.equal(asked.length, 1);
    assert.doesNotMatch(details(m), /HitPosition/);
    answer(leaning(asked[0].id));
    await flush();
    assert.match(details(m), /In your recent plays you press 9 ms late on average/);
    assert.match(details(m), /larger HitPosition \(now 415\)/);
    const errors = fold(m.$("rp-details").children.filter((n) => n.dataset?.sec), "errors");
    assert.match(textOf(body(errors).children[0]), /HitPosition/, "in its fold");
    assert.equal(m.$("rp-details").children[0].className, "rp-main", "and it can reach the top");
});

test("a lean that tells nothing leaves the report as it was drawn", async (t2) => {
    const { file, service } = await oneReplay(t2);
    let answer = null;
    let asked = null;
    const m = mount(service, { replayBias: (request) => { asked = request; return new Promise((resolve) => { answer = resolve; }); } });
    await m.tab.openReplay({ file });
    await flush();
    const drawn = m.$("rp-details").children;
    answer(leaning(asked.id, HINTS.position.minMs / 2));
    await flush();
    assert.equal(m.$("rp-details").children, drawn, "not drawn again for nothing");
    assert.doesNotMatch(details(m), /HitPosition/);
});

test("another replay opened starts with no lean of its own, whatever the last one had", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const answers = [];
    const m = mount(service, { replayBias: ({ id }) => new Promise((resolve) => { answers.push(() => resolve(leaning(id))); }) });
    await m.tab.openReplay({ file });
    await flush();
    answers[0]();
    await flush();
    assert.match(details(m), /HitPosition/);
    await m.tab.openReplay({ file });
    await flush();
    assert.doesNotMatch(details(m), /HitPosition/, "the first one's is gone");
    answers[1]();
    await flush();
    assert.match(details(m), /HitPosition/, "and its own comes in its time");
});

test("a stale answer about the lean is dropped, and another replay starts from none", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const answers = [];
    const m = mount(service, { replayBias: () => new Promise((resolve) => { answers.push(resolve); }) });
    await m.tab.openReplay({ file });
    await flush();
    const first = m.$("rp-details");
    await m.tab.openReplay({ file });
    await flush();
    assert.equal(answers.length, 2);
    answers[0]({ ...leaning(1), id: 1 });
    await flush();
    assert.doesNotMatch(details(m), /HitPosition/, "the first replay's answer came too late");
    assert.equal(first, m.$("rp-details"));
    answers[1]({ ok: false, stale: true });
    await flush();
    assert.doesNotMatch(details(m), /HitPosition/);
    await m.tab.openReplay({ file });
    await flush();
    answers[2]({ ok: true, id: 3, plays: [], position: null });
    await flush();
    assert.doesNotMatch(details(m), /HitPosition/, "no plays: nothing to say");
});

test("the hints redraw when the fingers change and when the details and the earlier plays arrive", async (t2) => {
    const { file, service } = await oneReplay(t2);
    const m = mount(service, {
        replayBias: async ({ id }) => leaning(id),
        replayDetails: async ({ id }) => ({ ok: true, id, families: [], spanMs: 0, dans: [] }),
        replayEarlier: async ({ id }) => ({ ok: true, id, plays: [{ at: 1, rate: 1, modNames: [], accuracy: 90, misses: 0, maxCombo: 1, ur: 100, manip: 0, pairs: 0, whole: true }], total: 1 }),
    });
    await m.tab.openReplay({ file });
    await flush();
    assert.match(details(m), /HitPosition/);
    const before = m.$("rp-details").children;
    const select = (node) => (node.tagName === "SELECT" ? node : node.children.map(select).find(Boolean));
    const picker = select(m.$("rp-details"));
    picker.value = "L4";
    await fire(picker, "change");
    await flush();
    assert.notEqual(m.$("rp-details").children, before, "the fingers changed: drawn anew");
    assert.match(details(m), /HitPosition/, "and the hint is still there");
});

test("a hint that needs the map's patterns comes with them", async (t2) => {
    const notes = rollNotes({ count: 400, stepMs: 120 });
    const half = notes.length / 2;
    const presses = [...honestPresses(notes.slice(0, half), { sdMs: 3 }), ...honestPresses(notes.slice(half), { sdMs: 30, seed: 2 })];
    const { file, service } = await oneReplay(t2, { notes, presses });
    let answer = null;
    const m = mount(service, { replayDetails: () => new Promise((resolve) => { answer = resolve; }) });
    await m.tab.openReplay({ file });
    await flush();
    assert.doesNotMatch(details(m), /Weakest is/);
    answer({ ok: true, families: ["stream", "jumpstream"], spanMs: notes.at(-1).t - notes[0].t, dans: [] });
    await flush();
    assert.match(details(m), /Weakest is jumpstream: UR \d+ against \d+ on stream/);
});

test("a hint that needs the earlier plays comes with them", async (t2) => {
    const { file, service } = await oneReplay(t2);
    let answer = null;
    const m = mount(service, { replayEarlier: () => new Promise((resolve) => { answer = resolve; }) });
    await m.tab.openReplay({ file });
    await flush();
    const { analysis } = await service.open({ file });
    assert.doesNotMatch(details(m), /that is progress/);
    const old = { at: 1, rate: 1, modNames: [], accuracy: analysis.accuracy, misses: 0, maxCombo: 1, ur: analysis.ur + HINTS.earlier.minUr, manip: 0, pairs: 0, whole: true };
    answer({ ok: true, plays: new Array(HINTS.earlier.minPlays).fill(old), total: HINTS.earlier.minPlays });
    await flush();
    assert.match(details(m), /that is progress/);
});
