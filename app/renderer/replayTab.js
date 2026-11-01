// The «Реплей» tab: a replay of osu!mania 4K dropped or picked, or from the recent ones of osu!'s folders, played back on
// the player's own skin with the song, and taken apart: the manip percent first, then everything replayReport.js folds out,
// per finger and per hand. When a play ends main says so and the tab opens that play's replay by itself, or says why there
// is none; it never asks for the window's focus. The second source, the profile's plays, says plainly what a play without
// key data can and cannot show. Main does the reading (app/replayIpc.js); osu!'s folders are only read.
import { t } from "../../src/i18n/i18n.js";
import { createReplayPlayer } from "./replayPlayer.js";
import { createReplayView, playTime } from "./replayView.js";
import { reportSections, el, button, percent, acc2, num1, dateText } from "./replayReport.js";
import { manipStrip } from "./replayCharts.js";
import { MANIP } from "../../src/replay/manip.js";
import { buildReport } from "../../src/replay/report.js";
import { validFingers, handsOf } from "../../src/replay/fingers.js";

const SOURCE_KEY = "replay-source";
const SKIN_KEY = "replay-skin";
const FINGERS_KEY = "replay-fingers";
const SOURCES = ["replay", "gameplay"];
const SOURCE_TEXT = { replay: "replay.source.replay", gameplay: "replay.source.gameplay" };
const GAME_DAYS = 30; // of which the profile hands over the newest 30 plays
const GAME_MATCH_MS = 10 * 60 * 1000; // a replay this close to a play's time, of the same map, is that play's
const REASON_TEXT = { random: "replay.reason.random", keys: "replay.reason.keys", empty: "replay.reason.empty" };
// why a play that just ended has no replay
const ENDED_TEXT = { pass: "replay.ended.pass", fail: "replay.ended.fail", quit: "replay.ended.quit", lazer: "replay.ended.lazer", noFolder: "replay.ended.noFolder" };

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
// table; it counts a hold as one for the combo); only UR is not in a replay.
function statTiles(replay, analysis) {
    const tile = (label, value, title = "") => {
        const box = el("div", "rp-tile");
        if (title) box.title = title;
        box.append(el("div", "muted", label), el("b", "", value));
        return box;
    };
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
    let listed = false;
    let skinLoaded = false;
    let fingers = readFingers();
    let later = null; // the map's dans and pattern families, once they come
    let earlier = null; // the earlier plays of the map, once they come
    let earlierAsked = 0; // the fingers can change while they are on their way: only the last answer counts
    const status = (text = "", cls = "") => {
        const box = $("rp-status");
        box.textContent = text;
        box.className = `muted sk-status ${cls}`;
    };

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
    function drawList(place) {
        const box = $("rp-list");
        const folder = $("rp-folder");
        folder.textContent = place?.folder ? `${t("replay.list.from", { folder: place.folder })} ${t("replay.list.readOnly")}` : "";
        if (!place?.folder) {
            box.replaceChildren(el("div", "muted", t("replay.list.noFolder")), button(t("replay.list.pick"), "small", async () => {
                const r = await api.replayPickFolder?.();
                if (r?.ok) void refresh();
            }));
            return;
        }
        if (!items.length) {
            box.replaceChildren(el("div", "muted", t("replay.list.empty")));
            return;
        }
        box.replaceChildren(...items.map((item) => {
            const name = item.title ? mapName(item) : t("replay.list.unknownMap", { md5: item.md5.slice(0, 8) });
            const row = el("button", "rp-row");
            row.type = "button";
            row.dataset.file = item.file;
            row.title = t("replay.list.title", { map: name, acc: item.accuracy?.toFixed(2) ?? "—", miss: item.miss });
            const line = el("div", "rp-row-line");
            line.append(el("span", "rp-row-name", name), el("span", "rp-num", acc2(item.accuracy)));
            const sub = el("div", "muted rp-row-sub");
            sub.textContent = [dateText(item.at), modsText(item.modNames, item.rate)].filter(Boolean).join(" · ");
            row.append(line, sub);
            row.addEventListener("click", () => void openReplay({ file: item.file }));
            return row;
        }));
    }

    async function refresh() {
        if (!items.length) $("rp-list").replaceChildren(el("div", "muted", t("replay.list.loading")));
        const quick = await api.replayList?.({ titles: false });
        if (!quick?.ok) {
            status(t("replay.err.failed", { message: quick?.message ?? "" }), "bad");
            return null;
        }
        items = quick.items;
        drawList(quick);
        listed = true;
        if (!quick.folder) return quick;
        const named = await api.replayList?.({ titles: true });
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
        const r = await api.replaySkin?.(request);
        if (!r?.ok) return;
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
        view.setSkin(r.config, pictures);
        const note = $("rp-skin-note");
        note.textContent = !r.chosen ? t("replay.play.plainSkin") : r.mania4 ? "" : t("replay.play.no4k");
    }
    $("rp-skin").addEventListener("change", (e) => {
        const value = e.target.value;
        store(SKIN_KEY, value);
        void loadSkin(skinRequest(value));
    });

    // ---- one replay open ----
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
            replay, analysis, report, later, earlier, fingers, timeOf, seek,
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
        player.unload();
        const { replay, map, analysis, reason } = result;
        $("rp-map").textContent = map ? mapName(map) : t("replay.list.unknownMap", { md5: replay.md5.slice(0, 8) });
        $("rp-who").textContent = [t("replay.head.by", { player: replay.player, date: dateText(replay.at) }), modsText(replay.modNames, replay.rate)].filter(Boolean).join(" · ");
        const why = reason === "nomap" ? (result.folder ? "replay.reason.nomap" : "replay.reason.nomapFolder") : REASON_TEXT[reason];
        $("rp-reason").hidden = !why;
        $("rp-reason").textContent = why ? t(why) : "";
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
        if (!skinLoaded) {
            skinLoaded = true;
            await loadSkin(skinRequest(readStored(SKIN_KEY, null)));
        } else view.redraw();
        void loadAudio(result);
        void loadDetails(result);
        void loadEarlier(result);
    }

    async function loadAudio(result) {
        if (!result.map.audio) return;
        const note = $("rp-skin-note");
        const before = note.textContent;
        note.textContent = t("replay.play.audioLoading");
        const r = await api.replayAudio?.({ id: result.id });
        if (opened?.id !== result.id) return;
        if (!r?.ok) {
            note.textContent = r?.stale ? before : t("replay.play.noAudio", { message: r?.message ?? "" });
            return;
        }
        try {
            await player.loadAudio(r.data);
            note.textContent = before;
        } catch {
            note.textContent = t("replay.play.noAudio", { message: t("replay.err.noAudio") });
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
        const ok = await openReplay({ file: play.file });
        if (ok) endedNote(t("replay.ended.opened", { map: mapName(play) }), "good");
        return ok;
    }

    // main found the play's replay, or says why not: { outcome, artist, title, version, accuracy, file, reason, moved }, or
    // that it is still on its way: waiting. A retry mid-map (a quit) leaves the tab where it is, and so does a next play
    // already going on: the note waits there for whoever comes to look. So does a replay that comes while another plays.
    async function playEnded(play) {
        const name = mapName(play);
        if (play.waiting) {
            endedNote(t("replay.ended.waiting", { map: name }));
            return;
        }
        if (play.file && player.playing) {
            endedNote(t("replay.ended.ready", { map: name }), "", button(t("replay.ended.open"), "small", () => void openEnded(play)));
            return;
        }
        if (play.file) {
            if (await openEnded(play)) {
                goToTab();
                return;
            }
        }
        const key = play.reason === "lazer" || play.reason === "noFolder" ? play.reason : play.outcome;
        endedNote(t(ENDED_TEXT[key] ?? ENDED_TEXT.quit, { map: name, acc: play.accuracy === null ? "—" : play.accuracy.toFixed(2) }));
        if (play.outcome !== "quit" && !play.moved) goToTab();
    }
    api.onReplayEnded?.((play) => void playEnded(play));

    async function openReplay(request) {
        endedNote("");
        status(t("replay.opening"));
        const r = await api.replayOpen?.(request);
        if (!r || r.cancelled) {
            status();
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
    async function drawGame() {
        const box = $("rp-game");
        const has = el("div", "group rp-block");
        has.append(el("div", "flabel", t("replay.game.has")), el("div", "muted", t("replay.game.hasList")));
        const needs = el("div", "group rp-block");
        needs.append(el("div", "flabel", t("replay.game.needs")), el("div", "muted", t("replay.game.needsList")));
        const rows = el("div", "rp-game-rows");
        box.replaceChildren(el("div", "rp-intro", t("replay.game.intro")), has, needs, el("div", "muted", t("replay.game.how")), el("div", "flabel", t("replay.game.recent")), rows);
        rows.replaceChildren(el("div", "muted", t("replay.game.loading")));
        const [history, list] = await Promise.all([api.localProfileHistory?.(GAME_DAYS), api.replayList?.({ titles: false, limit: 120 })]);
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
            const match = replays.find((r) => r.md5 === p.md5 && Math.abs(r.at - p.at) < GAME_MATCH_MS);
            row.append(text, match ? button(t("replay.game.open"), "small", () => void openReplay({ file: match.file })) : el("span", "muted", t("replay.game.noReplay")));
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
