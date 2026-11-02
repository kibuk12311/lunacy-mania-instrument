// Interlude's plays from the folder to what the player sees: a made-up Interlude folder (tests/fixtures/interludeFolder.js,
// made-up replays of tests/fixtures/makeIlReplay.js), main's real replay service reading it (app/replayIpc.js through
// app/replayInterlude.js) and the real Replay tab drawing its answers through the fake DOM: the list with its marks, a play
// opened by the ruleset chosen in Interlude (the head with its select, the tiles, the ruleset's judgements counted as the
// engine counts them, the playback's panel at the end), the same play by another ruleset, a failed play, one whose mods are
// not followed, one gone, and the earlier plays of the chart. Every number shown is checked against the engine run on the
// same replay (src/interlude/judge.js). Nothing here comes from a real play or chart.
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { makeInterludeFolder } from "../fixtures/interludeFolder.js";
import { makeIlReplay, framesOfPresses } from "../fixtures/makeIlReplay.js";
import { rollNotes, chartText, honestPresses } from "../fixtures/makeOsr.js";
import { osuJson, wife3Json } from "../interlude/rulesets.js";
import { createInterludeLibrary } from "../../app/interludeLibrary.js";
import { createReplayService } from "../../app/replayIpc.js";
import { playIdOf } from "../../app/replayInterlude.js";
import { initReplayTab, onReplayTabShown } from "../../app/renderer/replayTab.js";
import { dateText, acc2 } from "../../app/renderer/replayReport.js";
import { shortJudgement } from "../../src/overlay/interludeData.js";
import { judgeIlReplay } from "../../src/interlude/judge.js";
import { readIlReplay, applyIlMods } from "../../src/interlude/replay.js";
import { parseRuleset, rulesetSlots } from "../../src/interlude/ruleset.js";
import { maniaConfig } from "../../src/skin/maniaFields.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const DAY = Date.UTC(2026, 9, 5, 12);
// main reads Interlude's databases from copies, on real files: what the tab asked comes after a few turns of the loop
const until = async (done, said) => {
    for (let i = 0; i < 400 && !done(); i += 1) await new Promise((r) => { setTimeout(r, 5); });
    assert.ok(done(), said);
};
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => { setImmediate(r); }); };
// a play opened: main's answer drawn (the status line says "Opening…" until then), and what it asks for next
const opened = async (m) => {
    await until(() => m.$("rp-status").textContent !== t("replay.opening"), "the play opened");
    await flush();
};
const all = (node) => [node, ...node.children.flatMap(all)];

// the rulesets as Interlude ships them would name their judgements
const named = (json, names) => ({ ...json, Judgements: json.Judgements.map((j, i) => ({ ...j, Name: names[i] })) });
const RULESETS = {
    "osu-od8": named(osuJson(8), ["300g", "300", "200", "100", "50", "MISS"]),
    "wife3-j4": named(wife3Json(4), ["Marvelous", "Perfect", "Great", "Good", "Bad", "Miss"]),
};

// A chart of 80 notes rolled over the four columns, every tenth a hold, and five plays of it, newest first: A played
// honestly but for a few notes left, B mirrored at ×1.1, C failed half way, D with Shuffle (not followed), E an older
// honest one. Interlude has osu! OD8 chosen and Wife3 J4 beside it.
async function fixture(t2) {
    const notes = rollNotes({ count: 80, stepMs: 150 }).map((n, i) => (i % 10 === 3 ? { ...n, end: n.t + 300 } : n));
    const text = chartText(notes, { title: "Roll Of Plays", artist: "Synth", version: "4K Roll" });
    const first = notes[0].t;
    const blob = (presses) => makeIlReplay(framesOfPresses(presses.map((p) => ({ ...p, t: p.t - first, up: p.up - first }))));
    const honest = honestPresses(notes, { sdMs: 14, seed: 4 });
    const plays = {
        A: { at: DAY + 5000, presses: honest.filter((_, i) => i % 23 !== 7) },
        B: { at: DAY + 4000, presses: honestPresses(notes, { sdMs: 12, seed: 5 }).map((p) => ({ ...p, col: 3 - p.col })), mods: { mirror: 0 }, rate: Math.fround(1.1) },
        C: { at: DAY + 3000, presses: honestPresses(notes.slice(0, 40), { sdMs: 10, seed: 6 }), failed: true },
        D: { at: DAY + 2000, presses: honest, mods: { shuffle: 0 } },
        E: { at: DAY + 1000, presses: honestPresses(notes, { sdMs: 20, seed: 7 }) },
    };
    const f = await makeInterludeFolder({
        charts: [{ osuText: text, title: "Roll Of Plays", artist: "Synth", version: "4K Roll" }],
        plays: Object.values(plays).map((p) => ({ index: 0, at: p.at, replay: blob(p.presses), mods: p.mods ?? {}, rate: p.rate ?? 1, failed: p.failed ?? false })),
        options: { SelectedRuleset: "osu-od8" }, rulesets: RULESETS,
    });
    const cacheDir = path.join(f.root, "..", `${path.basename(f.root)}-cache`);
    const userData = path.join(f.root, "..", `${path.basename(f.root)}-user`);
    t2.after(() => Promise.all([f.root, cacheDir, userData].map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))));
    const library = createInterludeLibrary({ folder: () => f.root, cacheDir });
    const service = createReplayService({
        userData, env: {}, interlude: { folder: () => f.root, library, ready: async () => {} },
        tosu: async () => ({ game: null, songs: null, skin: null }), association: async () => null,
    });
    const hash = f.charts[0].hash;
    // what Interlude's own judging makes of a play by a ruleset: the engine on the same chart and replay
    const engine = (id, rulesetId = "osu-od8") => {
        const p = plays[id];
        const chart = applyIlMods(f.charts[0].chart, p.mods ?? {});
        const frames = readIlReplay(blob(p.presses));
        const ruleset = parseRuleset(RULESETS[rulesetId]);
        const judged = judgeIlReplay({ ruleset, chart, frames, rate: p.rate ?? 1, untilLastFrame: p.failed ?? false });
        const slots = rulesetSlots(ruleset);
        const misses = judged.counts.reduce((sum, n, j) => sum + (slots[j] === "miss" ? n : 0), 0);
        let combo = 0;
        for (const e of judged.events) combo = e.combo === "INCREASE" ? combo + 1 : e.combo === "NO_CHANGE" ? combo : 0;
        // what Interlude shows for the play: judged over the whole chart, failed or not
        const whole = judgeIlReplay({ ruleset, chart, frames, rate: p.rate ?? 1, untilLastFrame: false }).formattedAccuracy;
        return { ...judged, ruleset, misses, combo, percent: judged.accuracy * 100, whole };
    };
    return { service, plays, engine, play: (id) => playIdOf(hash, plays[id].at), hash };
}

// the tab mounted on the fake DOM, its calls answered by main's service (the song and the skin left out)
function mount(service) {
    setLang("en");
    const asked = { open: [], earlier: 0, bias: 0 };
    const api = {
        replayList: (request) => service.list(request),
        replayOpen: async (request) => { asked.open.push(request); return service.open(request); },
        replayEarlier: async (request) => { asked.earlier += 1; return service.earlier(request); },
        replayDetails: (request) => service.details(request),
        replayBias: async (request) => { asked.bias += 1; return service.bias(request); },
        replayAudio: async () => ({ ok: false, stale: true }),
        replaySkin: async () => ({ ok: true, skins: [], current: null, chosen: null, config: maniaConfig(new Map()), images: {}, mania4: false }),
        onReplayEnded: () => {}, onReplayFolder: () => {}, onReplayProgress: () => {},
    };
    const dom = fakeDom(api);
    globalThis.Option = class { constructor(label, value, _d, selected) { this.textContent = label; this.value = value; this.selected = Boolean(selected); this.children = []; } };
    globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
    dom.$("rp-manip").querySelector = () => ({ open: false });
    globalThis.document.createTextNode = (value) => ({ textContent: value, children: [] });
    const make = globalThis.document.createElement;
    globalThis.document.createElementNS = (_ns, tag) => Object.assign(make(tag), { setAttribute() {}, appendChild() {} });
    const tab = initReplayTab({ $: dom.$, api });
    onReplayTabShown();
    return { ...dom, tab, asked };
}

const fold = (m, id) => m.$("rp-details").children.find((s) => s.dataset?.sec === id);
const selectIn = (node) => all(node).find((n) => n.tagName === "SELECT");
const tiles = (m) => m.$("rp-stats").children.map((tile) => tile.children[1].textContent);
// the judgements' table: [[name, colour, count]] as drawn
function tableOf(m) {
    const node = all(fold(m, "judgements")).find((n) => n.tagName === "TABLE");
    return node.children.slice(1).map((tr) => [tr.children[0].children[1].textContent, tr.children[0].children[0].style.background, Number(tr.children[1].textContent)]);
}
const colourOf = (rgba) => `#${rgba.slice(1).map((x) => x.toString(16).padStart(2, "0")).join("")}`;

// The playback's panel beside the stage once the clock is at the end: [combo, accuracy, [[label, count]]], as drawn
async function panelAtEnd(m) {
    const seek = m.$("rp-controls").children.find((n) => n.className === "rp-seek");
    seek.value = seek.max;
    await fire(seek, "input");
    const calls = m.$("rp-stage").getContext("2d").calls.filter(([name]) => name === "fillText").map(([, text]) => String(text));
    const at = calls.lastIndexOf(t("replay.hud.combo"));
    const rows = [];
    for (let i = at + 6; i + 1 < calls.length && rows.length < 6; i += 2) rows.push([calls[i], Number(calls[i + 1])]);
    return { combo: Number(calls[at + 1]), accuracy: calls[at + 3], rows };
}

test("Interlude's plays from the folder to the tab: the list, a play by the ruleset chosen in Interlude and by another", async (t2) => {
    const f = await fixture(t2);
    const m = mount(f.service);
    await until(() => m.$("rp-list").children.length > 1, "the list");

    // the list: no osu! folder, so only Interlude's plays, newest first, each marked, the failed one marked again
    const [note, pick, ...rows] = m.$("rp-list").children;
    assert.equal(note.textContent, t("replay.list.onlyInterlude"));
    assert.equal(pick.textContent, t("replay.list.pick"), "with no osu! folder its pick stays");
    assert.deepEqual(rows.map((r) => r.dataset.play), ["A", "B", "C", "D", "E"].map(f.play));
    const line = (row) => row.children[0].children.map((n) => n.textContent);
    const name = "Synth - Roll Of Plays [4K Roll]";
    assert.deepEqual(line(rows[0]), [name, t("replay.list.interlude"), acc2(f.engine("A").percent)], "accuracy by osu! OD8, chosen in Interlude");
    assert.deepEqual(line(rows[1]), [name, t("replay.list.interlude"), acc2(f.engine("B").percent)]);
    assert.deepEqual(line(rows[2]), [name, t("replay.list.interlude"), t("replay.list.failed"), acc2(f.engine("C").percent)], "a failed play: as far as it went");
    assert.deepEqual(line(rows[3]), [name, t("replay.list.interlude"), "—"], "Shuffle is not followed: no accuracy");
    assert.equal(rows[1].children[1].textContent, `${dateText(f.plays.B.at)} · MR · ×1.1`, "Interlude's short name of the mod, the rate as a decimal");
    assert.equal(rows[3].children[1].textContent, `${dateText(f.plays.D.at)} · SHF`);
    assert.equal(rows[0].title, t("replay.list.title", { map: name, acc: f.engine("A").percent.toFixed(2), miss: f.engine("A").misses }));

    // A opened from its row: judged by osu! OD8, as the select says
    await fire(rows[0]);
    await opened(m);
    assert.deepEqual(m.asked.open, [{ play: f.play("A") }]);
    assert.equal(m.$("rp-map").textContent, name);
    const head = m.$("rp-who");
    assert.equal(head.children[0].textContent, t("replay.head.interlude", { date: dateText(f.plays.A.at) }));
    const select = selectIn(head);
    assert.deepEqual(select.children.map((o) => [o.value, o.textContent, o.selected]), [["osu-od8", "osu! OD8", true], ["wife3-j4", "Wife3 J4", false]]);
    assert.doesNotMatch(textOf(head), /cannot be read/, "the chosen ruleset was read: no fallback");
    const a = f.engine("A");
    assert.ok(a.misses > 0 && a.combo !== a.maxCombo, "the play has misses and breaks to show");
    assert.deepEqual(tiles(m), [a.formattedAccuracy, tiles(m)[1], String(a.misses), String(a.maxCombo)], "Interlude's accuracy as it writes it, the misses, the best combo");
    assert.equal(m.$("rp-stats").children[0].title, t("replay.stat.ilAccuracy", { name: "osu! OD8" }));
    assert.deepEqual(tableOf(m), a.ruleset.judgements.map((j, i) => [j.name, j.color, a.counts[i]]), "the ruleset's names and colours, the engine's counts");
    assert.deepEqual(tableOf(m).map(([n]) => n), RULESETS["osu-od8"].Judgements.map((j) => j.Name));
    assert.equal(tableOf(m)[1][1], colourOf(RULESETS["osu-od8"].Judgements[1].Color));
    assert.match(textOf(fold(m, "judgements")), /by the ruleset osu! OD8/);
    assert.equal(m.$("rp-reason").hidden, true);
    assert.equal(m.$("rp-play").hidden, false);
    // the playback's panel at the end: the engine's last combo, its accuracy and counts under the ruleset's short names
    const panel = await panelAtEnd(m);
    assert.equal(panel.combo, a.combo);
    assert.equal(panel.accuracy, `${a.percent.toFixed(2)} %`);
    assert.deepEqual(panel.rows, a.ruleset.judgements.map((j, i) => [shortJudgement(j.name), a.counts[i]]));

    // the earlier plays of the chart, judged by the same ruleset: B, C and E (D's Shuffle is not followed)
    await until(() => fold(m, "earlier"), "the earlier plays");
    assert.equal(m.asked.earlier, 1);
    const earlier = all(fold(m, "earlier")).filter((n) => n.tagName === "TR").slice(2).map((tr) => tr.children.map((td) => td.textContent));
    assert.deepEqual(earlier.map((cells) => cells.slice(0, 3)), [
        [`${dateText(f.plays.B.at)} ×1.1`, acc2(f.engine("B").percent), String(f.engine("B").misses)],
        [`${dateText(f.plays.C.at)} · ${t("replay.list.failed")}`, acc2(f.engine("C").percent), String(f.engine("C").misses)],
        [dateText(f.plays.E.at), acc2(f.engine("E").percent), String(f.engine("E").misses)],
    ]);
    assert.equal(m.asked.bias, 0, "no lean asked: HitPosition is osu!'s");

    // the same play by Wife3 J4, picked in the select: judged again, every number the engine's by Wife3
    select.value = "wife3-j4";
    await fire(select, "change");
    await opened(m);
    assert.deepEqual(m.asked.open.at(-1), { play: f.play("A"), ruleset: "wife3-j4" });
    const w = f.engine("A", "wife3-j4");
    assert.deepEqual(selectIn(m.$("rp-who")).children.map((o) => [o.value, o.selected]), [["osu-od8", false], ["wife3-j4", true]]);
    assert.deepEqual(tiles(m), [w.formattedAccuracy, tiles(m)[1], String(w.misses), String(w.maxCombo)]);
    assert.equal(m.$("rp-stats").children[0].title, t("replay.stat.ilAccuracy", { name: "Wife3 J4" }));
    assert.deepEqual(tableOf(m), w.ruleset.judgements.map((j, i) => [j.name, j.color, w.counts[i]]));
    assert.match(textOf(fold(m, "judgements")), /by the ruleset Wife3 J4/);
    const byWife = await panelAtEnd(m);
    assert.deepEqual([byWife.combo, byWife.accuracy, byWife.rows], [w.combo, `${w.percent.toFixed(2)} %`, w.ruleset.judgements.map((j, i) => [shortJudgement(j.name), w.counts[i]])]);
    // its earlier plays judged again by Wife3 too
    await until(() => m.asked.earlier === 2 && fold(m, "earlier"), "the earlier plays by Wife3");
    const byWifeEarlier = all(fold(m, "earlier")).filter((n) => n.tagName === "TR").slice(2).map((tr) => tr.children[1].textContent);
    assert.deepEqual(byWifeEarlier, ["B", "C", "E"].map((id) => acc2(f.engine(id, "wife3-j4").percent)));
});

test("Interlude's plays from the folder to the tab: a failed play, mods not followed, a play gone", async (t2) => {
    const f = await fixture(t2);
    const m = mount(f.service);
    await until(() => m.$("rp-list").children.length > 1, "the list");
    const row = (id) => m.$("rp-list").children.find((r) => r.dataset.play === f.play(id));

    // C failed half way: judged as far as it went, said so in the head, the tile and the table
    await fire(row("C"));
    await opened(m);
    const c = f.engine("C");
    assert.match(textOf(m.$("rp-who")), new RegExp(`· ${t("replay.head.failed")}`));
    assert.deepEqual(tiles(m), [acc2(c.percent), tiles(m)[1], String(c.misses), String(c.maxCombo)], "the recount's, up to the last press");
    assert.equal(m.$("rp-stats").children[0].title, t("replay.stat.ilFailed", { whole: c.whole }), "Interlude's own, over the whole chart, in its title");
    assert.ok(c.whole !== c.formattedAccuracy && c.whole.startsWith("50.00"), `every note after the fail a miss: ${c.whole}`);
    assert.deepEqual(tableOf(m).map(([, , n]) => n), c.counts);
    assert.match(textOf(fold(m, "judgements")), new RegExp(t("replay.judge.failed")));
    const panel = await panelAtEnd(m);
    assert.deepEqual([panel.combo, panel.rows.map(([, n]) => n)], [c.combo, c.counts], "the playback ends where the play did");

    // D with Shuffle: why it is not analysed, with Interlude's name of the mod; nothing judged, nothing to switch
    await fire(row("D"));
    await opened(m);
    assert.equal(m.$("rp-reason").hidden, false);
    assert.equal(m.$("rp-reason").textContent, t("replay.reason.mods", { mods: "SHF" }));
    assert.deepEqual(m.$("rp-stats").children, []);
    assert.deepEqual(m.$("rp-details").children, []);
    assert.equal(m.$("rp-play").hidden, true);
    assert.equal(selectIn(m.$("rp-who")), undefined);
    assert.equal(m.$("rp-map").textContent, "Synth - Roll Of Plays [4K Roll]");

    // a play that is not in scores.db (deleted in Interlude since the list was read)
    assert.equal(await m.tab.openReplay({ play: playIdOf(f.hash, DAY + 1) }), false);
    assert.equal(m.$("rp-status").textContent, t("replay.err.noPlay"));
    assert.match(m.$("rp-status").className, /bad/);
});
