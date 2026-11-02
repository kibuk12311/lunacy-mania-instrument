// The «Реплей» tab: a replay of osu!mania 4K dropped or picked, or from the recent ones of osu!'s folders, played back on
// the player's own skin with the song, and taken apart: the manip percent first, then everything replayReport.js folds out,
// per finger and per hand, with what stands out said in words (src/replay/hints.js). When a play ends main says so and the
// tab opens that play's replay by itself, or says why there is none; it never asks for the window's focus. The second source,
// the profile's plays, says plainly what a play without key data can and cannot show. Main does the reading
// (app/replayIpc.js); osu!'s folders are only read. Interlude's saved plays come in the same list, marked; one opens judged
// by the ruleset chosen in Interlude, and the header can judge it again by any other of Interlude's rulesets.
import { t } from "../../src/i18n/i18n.js";
import { createReplayPlayer } from "./replayPlayer.js";
import { createReplayView, playTime, ilAccText, ilAccDigits } from "./replayView.js";
import { reportSections, el, button, percent, acc2, num1, dateText } from "./replayReport.js";
import { manipStrip } from "./replayCharts.js";
import { MANIP } from "../../src/replay/manip.js";
import { buildReport } from "../../src/replay/report.js";
import { buildHints, biasTells } from "../../src/replay/hints.js";
import { validFingers, handsOf } from "../../src/replay/fingers.js";

const SOURCE_KEY = "replay-source";
const SKIN_KEY = "replay-skin";
const FINGERS_KEY = "replay-fingers";
const SOURCES = ["replay", "gameplay"];
const SOURCE_TEXT = { replay: "replay.source.replay", gameplay: "replay.source.gameplay" };
const GAME_DAYS = 30; // of which the profile hands over the newest 30 plays
const GAME_MATCH_MS = 10 * 60 * 1000; // a replay this close to a play's time, of the same map, is that play's
const REASON_TEXT = {
    random: "replay.reason.random", keys: "replay.reason.keys", empty: "replay.reason.empty",
    mods: "replay.reason.mods", nochart: "replay.reason.nochart", badReplay: "replay.reason.badReplay",
};
// why a play that just ended has no replay
const ENDED_TEXT = { pass: "replay.ended.pass", fail: "replay.ended.fail", quit: "replay.ended.quit", lazer: "replay.ended.lazer", noFolder: "replay.ended.noFolder" };
// the same of an Interlude play: it keeps failed plays too, only one cut short is not saved; with no folder to read
// nothing can be looked for
const IL_ENDED_TEXT = { quit: "replay.ended.ilQuit", other: "replay.ended.ilNone", noFolder: "replay.ended.ilNoFolder" };

function readStored(key, fallback) {
    try {
        return globalThis.localStorage?.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}
function store(key, value) {
    try {
        globalThis.localStorage?.setItem(key, value);
    } catch {
        // not remembered
    }
}
function readFingers() {
    try {
        return validFingers(JSON.parse(readStored(FINGERS_KEY, "null")));
    } catch {
        return validFingers(null);
    }
}

export const modsText = (names, rate) => [...names, rate !== 1 ? t("replay.head.rate", { rate }) : ""].filter(Boolean).join(" ");
export const mapName = (m) => [m.artist, m.title].filter(Boolean).join(" - ") + (m.version ? ` [${m.version}]` : "");
// Interlude's mods by the short names it shows them by ("MR", "NLN"), its rate to two decimals
export const ilModsText = (names, rate) => [
    (names ?? []).join(", "), Math.abs(rate - 1) > 1e-6 ? t("replay.head.rate", { rate: Math.round(rate * 100) / 100 }) : "",
].filter(Boolean).join(" · ");
const fromInterlude = (replay) => replay?.source === "interlude";
// the start of the chart's hash, for a chart with no name: of { chart } (a listed play, one open, one that just ended),
// else of its play's id interlude:<chart>:<at>
const chartName = ({ chart = null, play = null }) => t("replay.list.unknownChart", { hash: String(chart ?? String(play ?? "").split(":")[1] ?? "").slice(0, 8) });

// The skin to ask for: "" is the plain playfield, a name that skin, nothing yet the one set in osu!.
const skinRequest = (saved) => (saved === "" ? { plain: true } : { folder: saved });

// The manip block: the headline number (muted when it is plain scatter or stands on too few pairs), how much of it loose
// timing would make, the hands, how it is counted.
export function manipBlock(manip, { timeOf, onSeek }) {
    const box = el("div", "rp-manip");
    const head = el("div", "rp-manip-head");
    head.append(el("span", "rp-manip-word", t("replay.manip.title")), el("span", manip.loose || manip.thin ? "rp-manip-num calm" : "rp-manip-num", percent(manip.percent)));
    box.append(head);
    if (!manip.pairs) box.append(el("div", "muted", t("replay.manip.none", { min: MANIP.minGapMs, max: MANIP.maxGapMs })));
    else {
        box.append(el("div", "rp-manip-of", t("replay.manip.of", { glued: manip.glued, pairs: manip.pairs })));
        if (manip.loose) box.append(el("div", "rp-manip-loose", t("replay.manip.loose", { chance: manip.chance.toFixed(1) })));
        else if (manip.chance !== null && manip.chance >= 1) box.append(el("div", "muted", t("replay.manip.chance", { chance: manip.chance.toFixed(1) })));
        box.append(el("div", "muted", t("replay.manip.hands", { left: percent(manip.hands.left.percent), right: percent(manip.hands.right.percent) })));
        if (manip.glued) box.append(el("div", "flabel rp-sub", t("replay.html.where")), manipStrip(manip.bins, { timeOf, onSeek }));
    }
    const how = el("details", "sk-group rp-how");
    how.append(
        el("summary", "", t("replay.html.manipHow")),
        el("div", "muted", t("replay.manip.how", { min: MANIP.minGapMs, max: MANIP.maxGapMs, share: Math.round(MANIP.maxShare * 100), margin: MANIP.marginMs })),
    );
    box.append(how);
    return box;
}

// Accuracy, misses and combo are osu!'s own, as on its result screen (the recount stands beside them in the judgements'
// table; it counts a hold as one for the combo); only UR is not in a replay. An Interlude play keeps no result: all four
// are the recount's by the ruleset, the accuracy as Interlude writes it on its score screen. A failed play's is counted
// up to its last press; Interlude's own, over the whole chart with every note after the fail a miss, is in its title.
// With no recount there is nothing to show.
function statTiles(replay, analysis) {
    const tile = (label, value, title = "") => {
        const box = el("div", "rp-tile");
        if (title) box.title = title;
        box.append(el("div", "muted", label), el("b", "", value));
        return box;
    };
    if (fromInterlude(replay)) {
        if (!analysis) return [];
        const own = !replay.failed && analysis.accuracyText;
        const accTitle = own
            ? t("replay.stat.ilAccuracy", { name: analysis.ruleset.name })
            : replay.failed ? t("replay.stat.ilFailed", { whole: analysis.wholeAccuracyText ?? "—" }) : "";
        return [
            tile(t("replay.stat.accuracy"), own || ilAccText(analysis.accuracy), accTitle),
            tile(t("replay.stat.ur"), num1(analysis.ur), t("replay.stat.urTitleIl")),
            tile(t("replay.stat.misses"), String(analysis.counts.miss)),
            tile(t("replay.stat.combo"), String(analysis.combo.max)),
        ];
    }
    return [
        tile(t("replay.stat.accuracy"), acc2(replay.counts.accuracy)),
        tile(t("replay.stat.ur"), num1(analysis?.ur ?? null), t("replay.stat.urTitle")),
        tile(t("replay.stat.misses"), String(replay.counts.miss)),
        tile(t("replay.stat.combo"), String(replay.maxCombo)),
    ];
}

function createReplayTab({ $ = (id) => document.getElementById(id), api = window.danApi } = {}) {
    const player = createReplayPlayer();
    const view = createReplayView({ canvas: $("rp-stage"), controls: $("rp-controls"), player });
    let opened = null;
    let shown = false;
    let source = SOURCES.includes(readStored(SOURCE_KEY, "replay")) ? readStored(SOURCE_KEY, "replay") : "replay";
    let items = [];
    let listed = false; // the list was read from a folder: with none, the tab looks again each time it is shown
    let listAsked = 0; // the folder can change while a list or a skin is on its way: only the last answer counts
    let skinAsked = 0;
    let openAsked = 0; // the opens asked for: which replay counts is main's to say (an overtaken open comes back stale)
    let skinLoaded = false; // the skins were read: an answer without any is not kept
    let skinNote = ""; // the line under the stage: what the skin says, unless the song has something to say
    let audioNote = "";
    let fingers = readFingers();
    let later = null; // the map's dans and pattern families, once they come
    let earlier = null; // the earlier plays of the map, once they come
    let earlierAsked = 0; // the fingers can change while they are on their way: only the last answer counts
    let bias = null; // how the player's latest plays lean, once it comes and tells anything
    const status = (text = "", cls = "") => {
        const box = $("rp-status");
        box.textContent = text;
        box.className = `muted sk-status ${cls}`;
    };
    const drawNote = () => { $("rp-skin-note").textContent = audioNote || skinNote; };

    function showPanes() {
        $("rp-start").hidden = source !== "replay" || Boolean(opened);
        $("rp-game").hidden = source !== "gameplay";
        const session = source === "replay" && Boolean(opened);
        $("rp-session").hidden = !session;
        view.setVisible(shown && session);
    }

    // ---- where it comes from ----
    const sourceSpans = SOURCES.map((id) => {
        const span = el("span", id === source ? "sel" : "", t(SOURCE_TEXT[id]));
        span.addEventListener("click", () => {
            source = id;
            store(SOURCE_KEY, id);
            for (const other of sourceSpans) other.className = other === span ? "sel" : "";
            showPanes();
            if (id === "gameplay") void drawGame();
        });
        return span;
    });
    $("rp-source").replaceChildren(...sourceSpans);

    // ---- the recent replays ----
    // one replay of the list: an .osr by its file, an Interlude play by its id, marked, and marked again when failed
    function listRow(item) {
        const il = item.kind === "interlude";
        const name = item.title ? mapName(item) : il ? chartName(item) : t("replay.list.unknownMap", { md5: item.md5.slice(0, 8) });
        const row = el("button", "rp-row");
        row.type = "button";
        if (il) row.dataset.play = item.play;
        else row.dataset.file = item.file;
        const acc = il ? ilAccDigits(item.accuracy) : item.accuracy?.toFixed(2) ?? "—";
        row.title = t("replay.list.title", { map: name, acc, miss: item.miss ?? "—" });
        const line = el("div", "rp-row-line");
        line.append(el("span", "rp-row-name", name));
        if (il) line.append(el("span", "rp-mark", t("replay.list.interlude")));
        if (il && item.failed) line.append(el("span", "rp-mark rp-mark-fail", t("replay.list.failed")));
        line.append(el("span", "rp-num", il ? ilAccText(item.accuracy) : acc2(item.accuracy)));
        const sub = el("div", "muted rp-row-sub");
        sub.textContent = [dateText(item.at), il ? ilModsText(item.modNames, item.rate) : modsText(item.modNames, item.rate)].filter(Boolean).join(" · ");
        row.append(line, sub);
        row.addEventListener("click", () => void openReplay(il ? { play: item.play } : { file: item.file }));
        return row;
    }

    // place: replay-list's answer; its interlude: { linked, ok } of Interlude's folder
    function drawList(place) {
        const box = $("rp-list");
        const folder = $("rp-folder");
        const il = place?.interlude ?? null;
        folder.textContent = place?.folder ? `${t("replay.list.from", { folder: place.folder })} ${t("replay.list.readOnly")}` : "";
        const ilMissing = il?.linked && !il.ok ? [el("div", "muted rp-list-note", t("replay.list.ilMissing"))] : [];
        const pick = () => button(t("replay.list.pick"), "small", async () => {
            const r = await api.replayPickFolder?.();
            if (r?.message) status(r.message, "bad"); // a folder taken comes back as onReplayFolder
        });
        if (!place?.folder && !il?.ok) {
            box.replaceChildren(...ilMissing, el("div", "muted", t("replay.list.noFolder")), pick());
            return;
        }
        // above the plays: what one of the two places could not give; with no osu! folder its pick stays
        const notes = place.folder ? ilMissing : [el("div", "muted rp-list-note", t("replay.list.onlyInterlude")), pick()];
        if (!items.length) {
            const empty = !place.folder ? "replay.list.emptyIl" : il?.ok ? "replay.list.emptyBoth" : "replay.list.empty";
            box.replaceChildren(...notes, el("div", "muted", t(empty)));
            return;
        }
        box.replaceChildren(...notes, ...items.map(listRow));
    }

    async function refresh() {
        listAsked += 1;
        const asked = listAsked;
        if (!items.length) $("rp-list").replaceChildren(el("div", "muted", t("replay.list.loading")));
        const quick = await api.replayList?.({ titles: false });
        if (asked !== listAsked) return null;
        if (!quick?.ok) {
            status(t("replay.err.failed", { message: quick?.message ?? "" }), "bad");
            return null;
        }
        items = quick.items;
        drawList(quick);
        listed = Boolean(quick.folder);
        if (!quick.folder) {
            status();
            return quick;
        }
        const named = await api.replayList?.({ titles: true });
        if (asked !== listAsked) return null;
        status();
        if (named?.ok) {
            items = named.items;
            drawList(named);
        }
        return named;
    }
    $("rp-refresh").addEventListener("click", () => void refresh());
    api.onReplayProgress?.((p) => {
        if (p.total && p.done < p.total && !opened) status(t("replay.list.scan", { done: p.done, total: p.total }));
    });

    const drop = $("rp-drop");
    drop.addEventListener("dragover", (e) => { e.preventDefault?.(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
        e.preventDefault?.();
        drop.classList.remove("over");
        const file = e.dataTransfer?.files?.[0];
        const where = file ? api.pathForFile?.(file) : null;
        if (where) void openReplay({ file: where });
    });
    $("rp-file").addEventListener("click", () => void openReplay({}));
    $("rp-close").addEventListener("click", () => {
        opened = null;
        endedNote("");
        view.clear();
        showPanes();
        void refresh();
    });

    // ---- the skin ----
    async function loadSkin(request) {
        skinAsked += 1;
        const asked = skinAsked;
        const r = await api.replaySkin?.(request);
        if (asked !== skinAsked || !r?.ok) return;
        skinLoaded = r.skins.length > 0;
        const box = $("rp-skin");
        const options = [new Option(t("replay.play.skinPlain"), "", false, !r.chosen)];
        for (const name of r.skins) {
            const label = name === r.current ? t("replay.play.skinCurrent", { name }) : name;
            options.push(new Option(label, name, false, name === r.chosen));
        }
        box.replaceChildren(...options);
        const pictures = {};
        await Promise.all(Object.entries(r.images ?? {}).map(([value, info]) => new Promise((resolve) => {
            if (!info?.url || typeof Image === "undefined") {
                pictures[value] = null;
                resolve();
                return;
            }
            const img = new Image();
            img.onload = () => { pictures[value] = { img, hd: info.hd }; resolve(); };
            img.onerror = () => { pictures[value] = null; resolve(); };
            img.src = info.url;
        })));
        if (asked !== skinAsked) return;
        view.setSkin(r.config, pictures);
        skinNote = !r.chosen ? t("replay.play.plainSkin") : r.mania4 ? "" : t("replay.play.no4k");
        drawNote();
    }
    $("rp-skin").addEventListener("change", (e) => {
        const value = e.target.value;
        store(SKIN_KEY, value);
        void loadSkin(skinRequest(value));
    });

    // the folder was picked or reset, here or in Settings: all that came from it is read again, with a replay open too
    api.onReplayFolder?.(() => {
        void refresh();
        void loadSkin(skinRequest(readStored(SKIN_KEY, null)));
        if (source === "gameplay") void drawGame();
    });

    // ---- one replay open ----
    // An Interlude play's hints: from the recount, which is its result (src/replay/hints.js counts it by the ruleset's
    // points), none about HitPosition; with no recount none at all.
    function hintsOf({ report, analysis, replay }) {
        if (!fromInterlude(replay)) return buildHints({ report, analysis, replay, later, earlier, bias });
        if (!analysis) return { top: [], bySection: {} };
        return buildHints({ report, analysis, replay, later, earlier, bias: null });
    }

    // the header of an Interlude play: when, its mods and rate, failed; the ruleset it is judged by, any other of Interlude's
    // to judge it by again, and a word when the one chosen in Interlude could not be read
    function interludeHead(result) {
        const { replay, analysis } = result;
        const kids = [el("div", "", [t("replay.head.interlude", { date: dateText(replay.at) }), ilModsText(replay.modNames, replay.rate), replay.failed ? t("replay.head.failed") : ""].filter(Boolean).join(" · "))];
        if (!analysis || !result.ruleset) return kids;
        const row = el("label", "rp-ruleset");
        row.title = t("replay.head.rulesetTitle");
        const select = el("select", "sk-select");
        const offered = result.rulesets ?? [];
        const all = offered.some((r) => r.id === result.ruleset.id) ? offered : [{ id: result.ruleset.id, name: result.ruleset.name }, ...offered];
        select.replaceChildren(...all.map((r) => new Option(r.name, r.id, false, r.id === result.ruleset.id)));
        select.value = result.ruleset.id;
        select.addEventListener("change", () => void openReplay({ play: replay.play, ruleset: select.value }));
        row.append(el("span", "", t("replay.head.ruleset")), select);
        kids.push(row);
        if (result.ruleset.fallback) kids.push(el("div", "rp-fallback", t("replay.head.fallback", { name: result.ruleset.name })));
        return kids;
    }

    function drawReport() {
        const result = opened;
        if (!result) return;
        const { replay, analysis } = result;
        const timeOf = (ms) => playTime(ms, replay.rate);
        const seek = (ms) => view.seek(ms);
        const report = analysis ? buildReport({ analysis, presses: result.presses, fingers, later }) : null;
        const manipBox = $("rp-manip");
        if (report) {
            const binStart = (i) => analysis.fromMs + ((analysis.toMs - analysis.fromMs) * i) / report.manip.bins.length;
            const wasOpen = manipBox.querySelector(".rp-how")?.open ?? false;
            manipBox.replaceChildren(manipBlock(report.manip, { timeOf: (i) => timeOf(binStart(i)), onSeek: (i) => seek(binStart(i)) }));
            manipBox.querySelector(".rp-how").open = wasOpen;
        } else manipBox.replaceChildren();
        $("rp-details").replaceChildren(...reportSections({
            replay, analysis, report, later, earlier, fingers, timeOf, seek, hints: hintsOf({ report, analysis, replay }),
            onFingers: (next) => {
                const handsBefore = JSON.stringify(handsOf(fingers));
                fingers = validFingers(next);
                store(FINGERS_KEY, JSON.stringify(fingers));
                view.setHands(handsOf(fingers));
                drawReport();
                if (earlier && JSON.stringify(handsOf(fingers)) !== handsBefore) void loadEarlier(result);
            },
        }));
    }

    async function showResult(result) {
        opened = result;
        later = null;
        earlier = null;
        bias = null;
        player.unload();
        const { replay, map, analysis, reason } = result;
        const il = fromInterlude(replay);
        $("rp-map").textContent = map ? mapName(map) : il ? chartName(replay) : t("replay.list.unknownMap", { md5: replay.md5.slice(0, 8) });
        const who = $("rp-who");
        who.replaceChildren();
        who.textContent = il ? "" : [t("replay.head.by", { player: replay.player, date: dateText(replay.at) }), modsText(replay.modNames, replay.rate)].filter(Boolean).join(" · ");
        if (il) who.replaceChildren(...interludeHead(result));
        const why = reason === "nomap" ? (result.folder ? "replay.reason.nomap" : "replay.reason.nomapFolder") : REASON_TEXT[reason];
        $("rp-reason").hidden = !why;
        $("rp-reason").textContent = why ? t(why, { mods: (result.mods ?? []).join(", ") }) : "";
        // no analysis: nothing true to draw (Random shuffled the notes, the stage would show the wrong ones and empty totals)
        $("rp-play").hidden = !map || !analysis;
        $("rp-stats").replaceChildren(...statTiles(replay, analysis));
        showPanes();
        drawReport();
        if (!map || !analysis) {
            view.clear();
            return;
        }
        view.setReplay(result, handsOf(fingers));
        if (!skinLoaded) await loadSkin(skinRequest(readStored(SKIN_KEY, null)));
        else view.redraw();
        void loadAudio(result);
        void loadDetails(result);
        void loadEarlier(result);
        if (!il) void loadBias(result); // the lean of the latest plays speaks of osu!'s HitPosition
    }

    async function loadAudio(result) {
        const say = (text) => {
            audioNote = text;
            drawNote();
        };
        say(result.map.audio ? t("replay.play.audioLoading") : "");
        if (!result.map.audio) return;
        const r = await api.replayAudio?.({ id: result.id });
        if (opened?.id !== result.id) return;
        if (!r?.ok) {
            say(r?.stale ? "" : t("replay.play.noAudio", { message: r?.message ?? "" }));
            return;
        }
        try {
            await player.loadAudio(r.data);
            say("");
        } catch {
            say(t("replay.play.noAudio", { message: t("replay.err.noAudio") }));
        }
    }

    async function loadDetails(result) {
        const r = await api.replayDetails?.({ id: result.id });
        if (opened?.id !== result.id || !r?.ok) return;
        later = r;
        drawReport();
    }

    async function loadEarlier(result) {
        earlierAsked += 1;
        const asked = earlierAsked;
        const r = await api.replayEarlier?.({ id: result.id, fingers });
        if (asked !== earlierAsked || opened?.id !== result.id || !r?.ok || !r.plays.length) return;
        earlier = r;
        drawReport();
    }

    async function loadBias(result) {
        const r = await api.replayBias?.({ id: result.id });
        if (opened?.id !== result.id || !biasTells(r)) return;
        bias = r;
        drawReport();
    }

    // ---- a play just ended ----
    function endedNote(text, kind = "", action = null) {
        const box = $("rp-ended");
        box.hidden = !text;
        box.className = `rp-ended ${kind}`.trim();
        box.replaceChildren();
        if (!text) return;
        box.append(el("span", "", text));
        if (action) box.append(action);
        box.append(button("×", "small rp-ended-close", () => { box.hidden = true; }));
    }

    function goToTab() {
        window.dispatchEvent(new CustomEvent("open-tab", { detail: { tab: "replay" } }));
    }

    async function openEnded(play) {
        const ok = await openReplay(play.play ? { play: play.play } : { file: play.file });
        if (ok) endedNote(t("replay.ended.opened", { map: endedName(play) }), "good");
        return ok;
    }
    // an Interlude chart that has no names says the start of its hash (main gives the chart's even when no play came)
    const endedName = (play) => (play.source === "interlude" && !mapName(play) ? chartName(play) : mapName(play));

    // main found the play's replay, or says why not: { outcome, artist, title, version, accuracy, file, reason, moved }, or
    // that it is still on its way: waiting. A retry mid-map (a quit) leaves the tab where it is, and so does a next play
    // already going on: the note waits there for whoever comes to look. So does a replay that comes while another plays.
    // An Interlude play comes with source "interlude", its chart, and its play's id in place of the file (null when no row
    // of Interlude's scores came: reason "none", or "noFolder" when Interlude's folder could not be read).
    async function playEnded(play) {
        const name = endedName(play);
        const il = play.source === "interlude";
        if (play.waiting) {
            endedNote(t(il ? "replay.ended.ilWaiting" : "replay.ended.waiting", { map: name }));
            return;
        }
        const found = play.file || play.play;
        if (found && player.playing) {
            endedNote(t("replay.ended.ready", { map: name }), "", button(t("replay.ended.open"), "small", () => void openEnded(play)));
            return;
        }
        if (found) {
            const opened = await openEnded(play);
            if (opened) {
                goToTab();
                return;
            }
            if (opened === null) return; // another replay was asked for meanwhile: the tab is its
        }
        if (il && play.reason === "noFolder") endedNote(t(IL_ENDED_TEXT.noFolder, { map: name }));
        else if (il) endedNote(t(play.outcome === "quit" ? IL_ENDED_TEXT.quit : IL_ENDED_TEXT.other, { map: name }));
        else {
            const key = play.reason === "lazer" || play.reason === "noFolder" ? play.reason : play.outcome;
            endedNote(t(ENDED_TEXT[key] ?? ENDED_TEXT.quit, { map: name, acc: play.accuracy === null ? "—" : play.accuracy.toFixed(2) }));
        }
        if (play.outcome !== "quit" && !play.moved) goToTab();
    }
    api.onReplayEnded?.((play) => void playEnded(play));

    async function openReplay(request) {
        openAsked += 1;
        const asked = openAsked;
        endedNote("");
        status(t("replay.opening"));
        const r = await api.replayOpen?.(request);
        // main answers stale an open overtaken by one asked after it (a ruleset picked again, a play that ended, a quicker
        // map): the replay shown is always the one main keeps open, so its song, details and earlier plays come
        if (r?.stale) return null;
        if (!r || r.cancelled) {
            if (asked === openAsked) status(); // the dialog closed while another replay is on its way leaves its word up
            return false;
        }
        if (!r.ok) {
            status(r.message, "bad");
            return false;
        }
        status();
        if (source !== "replay") sourceSpans[0].click();
        await showResult(r);
        return true;
    }

    // ---- the profile's plays ----
    // the replay of a profile's play: an Interlude play is its saved play itself (the same id, interlude:<chart>:<at>); an
    // osu! one is the .osr of the same map this close in time
    const matchOf = (p, replays) => (String(p.id ?? "").startsWith("interlude:")
        ? replays.find((r) => r.play === p.id)
        : replays.find((r) => r.file && r.md5 === p.md5 && Math.abs(r.at - p.at) < GAME_MATCH_MS));

    async function drawGame() {
        const box = $("rp-game");
        const has = el("div", "group rp-block");
        has.append(el("div", "flabel", t("replay.game.has")), el("div", "muted", t("replay.game.hasList")));
        const needs = el("div", "group rp-block");
        needs.append(el("div", "flabel", t("replay.game.needs")), el("div", "muted", t("replay.game.needsList")));
        const rows = el("div", "rp-game-rows");
        const howIl = el("div", "muted", t("replay.game.howIl"));
        howIl.hidden = true;
        box.replaceChildren(el("div", "rp-intro", t("replay.game.intro")), has, needs, el("div", "muted", t("replay.game.how")), howIl, el("div", "flabel", t("replay.game.recent")), rows);
        rows.replaceChildren(el("div", "muted", t("replay.game.loading")));
        const [history, list] = await Promise.all([api.localProfileHistory?.(GAME_DAYS), api.replayList?.({ titles: false, limit: 120 })]);
        howIl.hidden = !list?.interlude?.linked;
        const plays = history?.ok ? history.plays ?? [] : [];
        if (!plays.length) {
            rows.replaceChildren(el("div", "muted", t("replay.game.none")));
            return;
        }
        const replays = list?.ok ? list.items : [];
        rows.replaceChildren(...plays.map((p) => {
            const row = el("div", "rp-game-row");
            const main = el("div", "rp-row-name", mapName(p));
            const sub = el("div", "muted rp-row-sub", [dateText(p.at), acc2(p.accuracy), p.rate !== 1 ? t("replay.head.rate", { rate: p.rate }) : ""].filter(Boolean).join(" · "));
            const text = el("div", "rp-game-text");
            text.append(main, sub);
            const match = matchOf(p, replays);
            row.append(text, match ? button(t("replay.game.open"), "small", () => void openReplay(match.play ? { play: match.play } : { file: match.file })) : el("span", "muted", t("replay.game.noReplay")));
            return row;
        }));
    }

    showPanes();
    return {
        shown() {
            shown = true;
            showPanes();
            if (source === "gameplay") void drawGame();
            if (!listed) void refresh();
        },
        hidden() {
            shown = false;
            showPanes();
        },
        openReplay,
    };
}

let tab = null;
export function initReplayTab(options) {
    tab = createReplayTab(options);
    window.addEventListener("tab-shown", (e) => { if (e.detail !== "replay") tab.hidden(); });
    return tab;
}
export function onReplayTabShown() { tab?.shown(); }
