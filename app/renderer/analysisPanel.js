// Extra blocks of the analysis card, drawn inside #card under the card itself (analysisExtras.js has the HTML).
// initAnalysisPanel({ card, redraw }): card is #card, redraw() draws the card again;
// analysisPanelHtml(view, opts) → HTML put after renderView(view, opts).
// The panel follows the view it is drawn with: a new map clears its details and ladder; details come from main
// ("analysis-details", for their key only), the ladder's dans from "analysis-rate", the player from profile.js.
import { LADDER_RATES, renderExtras } from "./analysisExtras.js";
import { setPatternMode, onPatternMode } from "./patternMode.js";
import { getProfile, onProfile, ensureProfile } from "./profile.js";

const STORAGE_KEY = "analysis-extras"; // { ladderOpen }
const LADDER_DELAY_MS = 600;
const validRate = (r) => typeof r === "number" && Number.isFinite(r) && r >= 0.5 && r <= 2;
const rateKey = (r) => Math.round(Number(r) * 100) / 100;

// The ladder's dans, one rate at a time (so the worker never has more than one of them waiting): 1.0x first, for
// the deltas, then the rest from the lowest; the current rate comes from the card and rates in `have` are known.
// start() again or stop() drops whatever is on its way; a stale answer (main has another map by now) ends the run.
// onRow(key, rate, { state: "ok", numeric, label } | { state: "fail" }); onStale(key).
export function createLadderRunner({ analysisRate, rates = LADDER_RATES, onRow, onStale = () => {} }) {
    let token = 0;
    let key = null;

    async function run(my, chosen, todo) {
        for (const rate of todo) {
            let answer;
            try {
                answer = await analysisRate(chosen, rate);
            } catch {
                answer = { ok: false };
            }
            if (my !== token) return;
            if (answer?.stale) {
                onStale(chosen);
                break;
            }
            const ok = answer?.ok && answer.kind === "ok" && Number.isFinite(answer.numeric);
            onRow(chosen, rate, ok ? { state: "ok", numeric: answer.numeric, label: answer.label } : { state: "fail" });
        }
        if (my === token) key = null;
    }

    return {
        start({ key: chosen, currentRate = null, have = [] }) {
            token += 1;
            const current = currentRate === null ? null : rateKey(currentRate);
            const known = new Set(have.map(rateKey));
            const todo = rates.map(rateKey).filter((r) => r !== current && !known.has(r)).sort((a, b) => (b === 1) - (a === 1) || a - b);
            key = todo.length ? chosen : null;
            if (todo.length) run(token, chosen, todo);
        },
        stop() {
            token += 1;
            key = null;
        },
        // the map whose ladder is being worked out, or null
        get key() {
            return key;
        },
    };
}

function readOpen(storage) {
    try {
        return JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "null")?.ladderOpen === true;
    } catch {
        return false;
    }
}

function saveOpen(storage, ladderOpen) {
    try {
        storage()?.setItem(STORAGE_KEY, JSON.stringify({ ladderOpen }));
    } catch {
        // not remembered, still applied
    }
}

export function createAnalysisPanel({
    card, redraw = () => {}, api = () => globalThis.window?.danApi,
    profile = { getProfile, onProfile, ensureProfile },
    storage = () => globalThis.localStorage,
    dispatch = (event) => globalThis.window?.dispatchEvent(event),
    setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
    const state = {
        key: null, rate: null, compact: false, details: null, profile: profile.getProfile(), ladder: new Map(),
        ladderOpen: readOpen(storage),
    };
    let lastDetails = null; // the last analysis-details payload, kept in case it comes before its card
    let ladderTimer = null;
    let staleKey = null; // main has another map than this one: its ladder is not asked for again
    let redrawQueued = false;

    // several changes in a row draw once, and never from inside a draw
    function later() {
        if (redrawQueued) return;
        redrawQueued = true;
        queueMicrotask(() => {
            redrawQueued = false;
            redraw();
        });
    }

    const runner = createLadderRunner({
        analysisRate: (key, rate) => api()?.analysisRate?.(key, rate) ?? Promise.resolve({ ok: false }),
        onRow(key, rate, row) {
            if (key !== state.key) return;
            state.ladder.set(rate, row);
            later();
        },
        onStale(key) {
            staleKey = key;
        },
    });

    function stopLadder() {
        runner.stop();
        clearTimer(ladderTimer);
        ladderTimer = null;
    }

    const startLadder = () => runner.start({ key: state.key, currentRate: state.rate, have: [...state.ladder.keys()] });

    // starts the ladder when it is open, can be seen and is not done yet; a delay of 0 starts it at once
    function maybeLadder(delayMs) {
        if (!state.key || !state.ladderOpen || state.compact || state.key === staleKey) {
            stopLadder();
            return;
        }
        if (runner.key === state.key || ladderTimer !== null) return;
        if (LADDER_RATES.every((r) => r === rateKey(state.rate) || state.ladder.has(r))) return;
        if (delayMs <= 0) {
            startLadder();
            return;
        }
        const key = state.key;
        ladderTimer = setTimer(() => {
            ladderTimer = null;
            if (state.key === key && state.ladderOpen && !state.compact) startLadder();
        }, delayMs);
    }

    function follow(view, compact) {
        const result = view?.screen === "result" ? view.result : null;
        const key = result?.kind === "ok" && typeof view.key === "string" && view.key ? view.key : null;
        state.compact = Boolean(compact);
        if (key !== state.key) {
            stopLadder();
            staleKey = null;
            state.key = key;
            state.rate = key ? rateKey(result.rate ?? 1) : null;
            state.ladder = new Map();
            state.details = key && lastDetails?.key === key ? lastDetails.details ?? null : null;
            // the profile client asks main once a session (again after a failure, no sooner than 60 s)
            if (key) queueMicrotask(() => profile.ensureProfile());
        }
        maybeLadder(LADDER_DELAY_MS);
    }

    function onDetails(payload) {
        if (typeof payload?.key !== "string") return;
        lastDetails = payload;
        if (payload.key !== state.key) return;
        state.details = payload.details ?? null;
        later();
    }

    // clicks on the blocks under the card, found by their data-* attributes on the way up to #card
    function act(target) {
        for (let node = target; node && node !== card; node = node.parentElement) {
            const data = node.dataset ?? {};
            if (data.rate !== undefined) {
                const rate = Number(data.rate);
                if (validRate(rate)) dispatch(new CustomEvent("open-rate", { detail: { rate } }));
                return;
            }
            if (data.go !== undefined) {
                if (data.go === "recommend") dispatch(new CustomEvent("open-tab", { detail: { tab: "recommend" } }));
                return;
            }
            if (data.patternMode !== undefined) {
                setPatternMode(data.patternMode); // every tab follows; this card redraws through onPatternMode
                return;
            }
            if (data.toggle === "ladder") {
                state.ladderOpen = !state.ladderOpen;
                saveOpen(storage, state.ladderOpen);
                maybeLadder(0);
                redraw();
                card?.querySelector?.("[data-toggle=ladder]")?.focus?.(); // the button was drawn anew
                return;
            }
        }
    }

    card?.addEventListener?.("click", (e) => act(e?.target));
    // the General / Detailed switch is shared by every tab: the card and the strip follow it
    onPatternMode(() => later());
    profile.onProfile((p) => {
        state.profile = p;
        later();
    });
    try {
        api()?.onAnalysisDetails?.(onDetails);
    } catch {
        // no details: the rest still works
    }

    return {
        html(view, opts = {}) {
            follow(view, opts?.compact);
            return renderExtras({
                view, compact: state.compact, details: state.details, profile: state.profile, ladder: state.ladder, ladderOpen: state.ladderOpen,
            });
        },
        state,
    };
}

let panel = null;

export function initAnalysisPanel({ card, redraw } = {}) {
    panel = createAnalysisPanel({ card, redraw });
}

export function analysisPanelHtml(view, opts) {
    return panel ? panel.html(view, opts) : "";
}
