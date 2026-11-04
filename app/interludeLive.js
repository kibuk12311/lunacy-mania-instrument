// Interlude followed live: the lines of app/interludeReader.js turned into what the app does with them.
//   - status lines → the live state the window shows (the footer badge, the IL panel's line): waiting, attached,
//     an error by its code (field_not_found, dac_not_found, attach_failed, …), the reader missing or restarting;
//   - a selection (chart hash + rate) that changed → after a short pause (scrolling the song wheel goes past many),
//     the chart is looked up in the linked library (once more after the copy of charts.db is read again, for a chart
//     imported since) and put on the card at its rate, like osu!'s selection; a chart the library doesn't have is shown
//     by its names from the reader with a note. Priority with osu!: whichever selection changed last has the card
//     (the selection controller gives it back to osu! when osu!'s own selection changes);
//   - every state line → the overlay (its own Interlude session, src/overlay/interludeData.js);
//   - a play of the player's own (the "play" screen with a play, not autoplay; not "practice", not "replay", which is
//     watching one) followed from its first line to the line that leaves it → onPlayEnded, for the Replay tab: "finished"
//     when the score screen opens after the chart's last note (Interlude saves the play then), "quit" when another
//     screen comes (level select mid-play: Interlude saves nothing), a retry starts the play over (a new play id), or
//     the score screen opens before the end. That last one is a quit too: Interlude's "On quit out" option opens the
//     score screen on Escape when set to "Show score (Don't save)" (nothing saved) or "Save and show score" (saved at
//     once); a play failed partway is saved at once as well, so the short wait of a quit finds its row all the same.
import { t } from "../src/i18n/i18n.js";

export const SELECT_PAUSE_MS = 300;
// How far before its last note (chart ms) a play's last line may be and the score screen still mean the play ran to
// its end: Interlude ends a play only after its last note has passed, but the reader's last line before the score
// screen comes up to a frame (30 a second, more chart time at a higher rate) before that, and the offsets move the clock.
export const PLAY_END_SLACK_MS = 1_000;
// the screens no play goes on: the reader has not read it yet (unknown), or a line with none
const NO_SCREEN = new Set(["unknown", ""]);
const NOTE_KEYS = {
    field_not_found: "app.interlude.live.fieldNotFound",
    dac_not_found: "app.interlude.live.dacNotFound",
    attach_failed: "app.interlude.live.attachFailed",
    not_dotnet: "app.interlude.live.otherError",
    runtime_init_failed: "app.interlude.live.otherError",
    read_failed: "app.interlude.live.readFailed",
};

// The live state as words for the window, in the language of the moment.
// state: { status: "off" | "starting" | "waiting" | "attached" | "error" | "missing" | "crashed", code, reason, version,
// allowDownload, retryMs }
export function liveText(state) {
    const s = state ?? {};
    switch (s.status) {
        case "off": return t("app.interlude.live.off");
        case "starting": return t("app.interlude.live.starting");
        case "waiting": return t("app.interlude.live.waiting");
        case "attached": {
            // attached, but a part of the game wasn't found (an Interlude update): both are told
            const base = t("app.interlude.live.attached", { version: s.version ?? "?" });
            return s.warn && s.code ? `${base} ${errorText(s)}` : base;
        }
        case "missing": return t("app.interlude.live.missing");
        case "crashed": return t("app.interlude.live.crashed", { s: Math.max(1, Math.round((s.retryMs ?? 0) / 1000)) });
        case "error": return errorText(s);
        default: return "";
    }
}

function errorText(s) {
    const key = NOTE_KEYS[s.code] ?? "app.interlude.live.otherError";
    const text = t(key, { reason: s.reason ?? "", code: s.code ?? "" });
    return s.code === "dac_not_found" && !s.allowDownload ? `${text} ${t("app.interlude.live.dacHint")}` : text;
}

// The reader runs while Interlude is followed (the client's liveSettings().follow: the setting, or a linked folder by
// default, never while Interlude is turned off in Settings); a change of the download setting starts it again with the
// new command line. While Interlude is turned off, an Interlude chart still on the card leaves it. main.js runs sync() at
// start and on every change of the client, without waiting: each sync runs after the one before it, so a quick off and on
// again starts the reader once the one being stopped has exited.
// interlude: createInterludeClient(); reader: createReaderProcess() (app/interludeReader.js); live: createInterludeLive();
// card: { end } (the selection controller's endExternal); stopped() → true once the app is quitting.
// allowDownload(): what the reader is (to be) started with.
export function createReaderSync({ interlude, reader, live, card = null, stopped = () => false }) {
    let allowDownload = false;
    let last = Promise.resolve(); // the sync before this one
    async function once() {
        if (stopped()) return;
        let settings;
        try {
            settings = await interlude.liveSettings();
        } catch {
            return;
        }
        const downloadChanged = settings.allowDownload !== allowDownload;
        allowDownload = settings.allowDownload;
        live.setAllowDownload(settings.allowDownload);
        if (!settings.enabled) {
            // turned off: live's selection is dropped before the card is ended, so a chart still being looked up or
            // copied out goes nowhere after it (the reader may take a moment to stop)
            live.off();
            card?.end();
        }
        if (!settings.follow) {
            if (reader.wanted()) {
                await reader.stop();
                live.off();
            }
            return;
        }
        if (reader.wanted() && downloadChanged) await reader.restart();
        else reader.start();
    }
    function sync() {
        const run = last.then(once);
        last = run.catch(() => {});
        return run;
    }
    return { sync, allowDownload: () => allowDownload };
}

// interlude: createInterludeClient(); card: { showExternal, showInfo } of the selection controller;
// overlay: () → the overlay (its onInterlude); onState(state): the live state changed (to the window);
// onPlayEnded({ client: "interlude", chart, rate, startedAt, endedAt, outcome: "finished" | "quit", artist, title,
// version, ruleset }): a play of the player's own left its screen (times by now(), unix ms; ruleset the name of the one
// Interlude judged it by, null when no line said).
export function createInterludeLive({
    interlude, card, overlay = () => null, onState = () => {}, onPlayEnded = () => {}, log = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, pauseMs = SELECT_PAUSE_MS, now = () => Date.now(),
}) {
    let state = { status: "off" };
    let lastKey = null; // "<hash> <rate>" of the last selection seen
    let pending = null;
    let token = 0;
    let attached = false;
    let onCard = null; // the key of the selection put on the card, while it is there
    // the play going on: { chart, playId, rate, startedAt, artist, title, version, ruleset, timeMs, durationMs } with
    // timeMs and durationMs (chart ms from the first note; null when a line had none) from its last line
    let play = null;
    // The name of the ruleset Interlude judged its last play by, as its lines say: Interlude writes the one chosen into
    // options.json only as it closes, so while it runs this is what tells a ruleset switched to. Forgotten when Interlude
    // closes (options.json has it then) or is no longer followed.
    let ruleset = null;

    const tell = (patch) => {
        state = { ...state, ...patch };
        onState(state);
    };

    // after an attach, the attached line's version stays; an error stays until the next attach
    function onStatus(msg) {
        if (msg.status === "attached") {
            attached = true;
            tell({ status: "attached", version: msg.version ?? null, pid: msg.pid ?? null, clr: msg.clr ?? null, code: null, reason: null });
            log(`interlude live: attached pid ${msg.pid} Interlude ${msg.version} clr ${msg.clr} dac ${msg.dac?.source ?? "?"}${msg.dac?.exact === false ? " (other patch)" : ""}`);
        } else if (msg.status === "waiting") {
            attached = false;
            play = null; // Interlude closed: a play cut short by that is saved nowhere
            ruleset = null;
            tell({ status: "waiting", code: null, reason: msg.reason ?? null });
            overlay()?.onInterlude?.(null);
        } else if (msg.status === "error") {
            log(`interlude live: ${msg.code} ${msg.reason ?? ""}`);
            // a missing field while attached: the rest still works, the badge stays attached and the text says what
            tell({ status: attached && msg.code === "field_not_found" ? "attached" : "error", code: msg.code ?? null, reason: msg.reason ?? null, warn: msg.code === "field_not_found" });
        } else if (msg.status === "resolved") {
            // statics that appeared later: nothing to show
        }
    }

    async function select(chart, key, my) {
        const hash = chart.hash;
        const rate = Number.isFinite(chart.rate) && chart.rate > 0 ? chart.rate : 1;
        const status = await interlude.status().catch(() => null);
        // Interlude turned off in Settings (a line read while the reader stops): nothing for the card
        if (status?.off) return;
        const linked = Boolean(status?.linked);
        let meta = null;
        if (linked) {
            meta = await interlude.library.meta(hash).catch(() => null);
            if (!meta) {
                // imported since the copy of charts.db was read: read it again, once
                interlude.library.forget();
                meta = await interlude.library.meta(hash).catch(() => null);
            }
        }
        if (my !== token) return;
        const onEnd = () => {
            if (onCard === key) onCard = null;
            interlude.clearSelection();
            tell({ onCard: false });
        };
        if (meta) {
            try {
                const sel = await interlude.select(hash);
                if (my !== token) return;
                card.showExternal({ id: sel.hash, text: sel.text, rate, onEnd });
                onCard = key;
                tell({ onCard: true, chart: { title: chart.title ?? meta.title, artist: chart.artist ?? meta.artist, diff: chart.diff ?? meta.version, rate } });
                log(`interlude live: card ${hash} at ${rate}x`);
                return;
            } catch (error) {
                log(`interlude live: select failed: ${error?.message}`);
            }
        }
        if (my !== token) return;
        card.showInfo({
            id: hash, rate, title: chart.title ?? "", artist: chart.artist ?? "", diff: chart.diff ?? "",
            note: t(linked ? "app.interlude.live.notInLibrary" : "app.interlude.live.noFolderNote"), onEnd,
        });
        onCard = key;
        tell({ onCard: true, chart: { title: chart.title ?? "", artist: chart.artist ?? "", diff: chart.diff ?? "", rate } });
        log(`interlude live: ${hash} not in the library, names only`);
    }

    function onSelection(chart) {
        if (!chart || typeof chart.hash !== "string" || !chart.hash || chart.hash.length > 256) return;
        const rate = Number.isFinite(chart.rate) && chart.rate > 0 ? chart.rate : 1;
        const key = `${chart.hash} ${rate}`;
        if (key === lastKey) return;
        lastKey = key;
        const my = ++token;
        clearTimer(pending);
        pending = setTimer(() => {
            pending = null;
            select(chart, key, my).catch((error) => log(`interlude live: ${error?.message}`));
        }, pauseMs);
    }

    // A play of the player's own from the lines: one begins on the play screen with a play (autoplay is not the
    // player's, and Interlude keeps none of it); a new play id (a retry) or another chart is another play, and the one
    // before was cut short; the score screen ends it as finished when its last line was at the chart's end (or did not
    // say where it was), as quit when it was not (a quit out or a fail); any other screen ends it as quit. The one line
    // with no play as the play screen is left says nothing yet: the next says where it went.
    function followPlay(msg) {
        const screen = typeof msg.screen === "string" ? msg.screen : "unknown";
        if (typeof msg.play?.ruleset === "string" && msg.play.ruleset) ruleset = msg.play.ruleset;
        if (screen === "play") {
            if (!msg.play || typeof msg.play !== "object") return;
            const hash = typeof msg.chart?.hash === "string" && msg.chart.hash ? msg.chart.hash : null;
            const playId = msg.play.playId ?? null;
            if (play && (play.playId !== playId || play.chart !== hash)) endPlay("quit");
            if (play) return void progress(msg.play);
            if (!hash || msg.autoplay) return;
            const rate = [msg.play.rate, msg.chart.rate].find((r) => Number.isFinite(r) && r > 0) ?? 1;
            play = {
                chart: hash, playId, rate, startedAt: now(),
                artist: msg.chart.artist ?? null, title: msg.chart.title ?? null, version: msg.chart.diff ?? null, ruleset: null,
                timeMs: null, durationMs: null,
            };
            progress(msg.play);
            return;
        }
        if (play && !NO_SCREEN.has(screen)) endPlay(screen === "score" && atEnd(play) ? "finished" : "quit");
    }

    // where the play is, and what judges it, from one of its lines
    function progress(p) {
        if (typeof p.ruleset === "string" && p.ruleset) play.ruleset = p.ruleset;
        play.timeMs = Number.isFinite(p.timeMs) ? p.timeMs : null;
        play.durationMs = Number.isFinite(p.durationMs) && p.durationMs > 0 ? p.durationMs : null;
    }

    // the play's last line was at its last note or after; a line that did not say counts as there (as before)
    function atEnd(p) {
        return p.timeMs === null || p.durationMs === null || p.timeMs >= p.durationMs - PLAY_END_SLACK_MS;
    }

    function endPlay(outcome) {
        const { chart, rate, startedAt, artist, title, version, ruleset: judgedBy } = play;
        play = null;
        log(`interlude live: play of ${chart} at ${rate}x ${outcome}`);
        try {
            onPlayEnded({ client: "interlude", chart, rate, startedAt, endedAt: now(), outcome, artist, title, version, ruleset: judgedBy });
        } catch (error) {
            log(`interlude live: the end of a play not passed on: ${error?.message}`);
        }
    }

    return {
        // one parsed line of the reader
        onMessage(msg) {
            if (!msg || typeof msg !== "object") return;
            if (typeof msg.status === "string") return onStatus(msg);
            if (msg.client !== "interlude") return undefined;
            if (state.status !== "attached") tell({ status: "attached", version: msg.version ?? state.version ?? null });
            if (state.screen !== msg.screen) tell({ screen: msg.screen ?? null });
            followPlay(msg);
            onSelection(msg.chart);
            overlay()?.onInterlude?.(msg);
            return undefined;
        },
        // the reader process itself (createReaderProcess's onState)
        onReader(r) {
            if (r.state === "running") tell({ status: "starting", code: null, reason: null, retryMs: null });
            else if (r.state === "missing") tell({ status: "missing" });
            else if (r.state === "crashed") tell({ status: "crashed", retryMs: r.retryMs ?? null });
            else if (r.state === "stopped") tell({ status: "off" });
            if (r.state !== "running") {
                attached = false;
                play = null; // how the play ends is not seen any more
                ruleset = null;
                overlay()?.onInterlude?.(null);
            }
        },
        // following stopped: forget the last selection, so the next start shows it again
        off() {
            clearTimer(pending);
            pending = null;
            token += 1;
            lastKey = null;
            attached = false;
            play = null;
            ruleset = null;
            tell({ status: "off", screen: null });
            overlay()?.onInterlude?.(null);
        },
        setAllowDownload(on) {
            if (state.allowDownload !== on) tell({ allowDownload: Boolean(on) });
        },
        state: () => ({ ...state }),
        text: () => liveText(state),
        // the name of the ruleset Interlude judged its last play by, or null
        ruleset: () => ruleset,
    };
}
