// Interlude followed live: the lines of app/interludeReader.js turned into what the app does with them.
//   - status lines → the live state the window shows (the footer badge, the IL panel's line): waiting, attached,
//     an error by its code (field_not_found, dac_not_found, attach_failed, …), the reader missing or restarting;
//   - a selection (chart hash + rate) that changed → after a short pause (scrolling the song wheel goes past many),
//     the chart is looked up in the linked library (once more after the copy of charts.db is read again, for a chart
//     imported since) and put on the card at its rate, like osu!'s selection; a chart the library doesn't have is shown
//     by its names from the reader with a note. Priority with osu!: whichever selection changed last has the card
//     (the selection controller gives it back to osu! when osu!'s own selection changes);
//   - every state line → the overlay (its own Interlude session, src/overlay/interludeData.js).
import { t } from "../src/i18n/i18n.js";

export const SELECT_PAUSE_MS = 300;
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

// interlude: createInterludeClient(); card: { showExternal, showInfo } of the selection controller;
// overlay: () → the overlay (its onInterlude); onState(state): the live state changed (to the window).
export function createInterludeLive({
    interlude, card, overlay = () => null, onState = () => {}, log = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, pauseMs = SELECT_PAUSE_MS,
}) {
    let state = { status: "off" };
    let lastKey = null; // "<hash> <rate>" of the last selection seen
    let pending = null;
    let token = 0;
    let attached = false;
    let onCard = null; // the key of the selection put on the card, while it is there

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
        const linked = Boolean((await interlude.status().catch(() => null))?.linked);
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

    return {
        // one parsed line of the reader
        onMessage(msg) {
            if (!msg || typeof msg !== "object") return;
            if (typeof msg.status === "string") return onStatus(msg);
            if (msg.client !== "interlude") return undefined;
            if (state.status !== "attached") tell({ status: "attached", version: msg.version ?? state.version ?? null });
            if (state.screen !== msg.screen) tell({ screen: msg.screen ?? null });
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
            tell({ status: "off", screen: null });
            overlay()?.onInterlude?.(null);
        },
        setAllowDownload(on) {
            if (state.allowDownload !== on) tell({ allowDownload: Boolean(on) });
        },
        state: () => ({ ...state }),
        text: () => liveText(state),
    };
}
