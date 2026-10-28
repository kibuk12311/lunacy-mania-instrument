// Extra blocks of the analysis card, drawn inside #card under the card itself (analysisExtras.js has the HTML).
// initAnalysisPanel({ card, redraw }): card is #card, redraw() draws the card again;
// analysisPanelHtml(view, opts) → HTML put after renderView(view, opts).
// The panel follows the view it is drawn with: a new map clears its details, parts and ladder; details come from main
// ("analysis-details", for their key only), the dan by part from "analysis-sections" (a part under the pointer is told
// in the line under its chart, one tapped stays told), the ladder's dans from "analysis-rate", the player from
// profile.js.
import { LADDER_RATES, renderExtras } from "./analysisExtras.js";
import { setPatternMode, onPatternMode } from "./patternMode.js";
import { getProfile, onProfile, ensureProfile } from "./profile.js";

const STORAGE_KEY = "analysis-extras"; // { ladderOpen, partsOpen }
const LADDER_DELAY_MS = 600;
const validRate = (r) => typeof r === "number" && Number.isFinite(r) && r >= 0.5 && r <= 2;
const rateKey = (r) => Math.round(Number(r) * 100) / 100;

// The ladder's dans, one rate at a time (so the worker never has more than one of them waiting): 1.0x first, for
// the deltas, then the rest from the lowest; the current rate comes from the card and rates in `have` are known —
// but for a rate map (askCurrent) the card's dan is the file's own, so its current rate is asked for right after 1.0x
// (the ladder's rows, now included, are its original's).
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
        start({ key: chosen, currentRate = null, have = [], askCurrent = false }) {
            token += 1;
            const current = currentRate === null ? null : rateKey(currentRate);
            const known = new Set(have.map(rateKey));
            const all = rates.map(rateKey);
            if (askCurrent && validRate(current) && !all.includes(current)) all.push(current);
            const first = (r) => (r === 1 ? 2 : askCurrent && r === current ? 1 : 0);
            const todo = all.filter((r) => (askCurrent || r !== current) && !known.has(r)).sort((a, b) => first(b) - first(a) || a - b);
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

// which of the folding lists are open: { ladderOpen, partsOpen }
function readOpen(storage) {
    try {
        const saved = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "null");
        return { ladderOpen: saved?.ladderOpen === true, partsOpen: saved?.partsOpen === true };
    } catch {
        return { ladderOpen: false, partsOpen: false };
    }
}

function saveOpen(storage, open) {
    try {
        storage()?.setItem(STORAGE_KEY, JSON.stringify(open));
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
        key: null, rate: null, rateMap: false, details: null, sections: undefined, partSel: null, profile: profile.getProfile(), ladder: new Map(),
        ...readOpen(storage),
    };
    const remember = () => saveOpen(storage, { ladderOpen: state.ladderOpen, partsOpen: state.partsOpen });
    let lastDetails = null; // the last analysis-details payload, kept in case it comes before its card
    let lastSections = null; // the same for analysis-sections
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

    const startLadder = () => runner.start({ key: state.key, currentRate: state.rate, have: [...state.ladder.keys()], askCurrent: state.rateMap });

    // starts the ladder when it is open, can be seen and is not done yet; a delay of 0 starts it at once
    function maybeLadder(delayMs) {
        if (!state.key || !state.ladderOpen || state.key === staleKey) {
            stopLadder();
            return;
        }
        if (runner.key === state.key || ladderTimer !== null) return;
        const nowKnown = !state.rateMap || state.rate === null || state.ladder.has(rateKey(state.rate));
        if (nowKnown && LADDER_RATES.every((r) => r === rateKey(state.rate) || state.ladder.has(r))) return;
        if (delayMs <= 0) {
            startLadder();
            return;
        }
        const key = state.key;
        ladderTimer = setTimer(() => {
            ladderTimer = null;
            if (state.key === key && state.ladderOpen) startLadder();
        }, delayMs);
    }

    function follow(view) {
        const result = view?.screen === "result" ? view.result : null;
        const key = result?.kind === "ok" && typeof view.key === "string" && view.key ? view.key : null;
        // a rate map's ladder is its original's, now row included: the same file shown as one or not is another ladder
        const rateMap = key !== null && Boolean(view.rateMap);
        if (key !== state.key || rateMap !== state.rateMap) {
            stopLadder();
            staleKey = null;
            state.key = key;
            state.rateMap = rateMap;
            // past the ladder (view.rateMap.beyond) no row of the original is the one played
            state.rate = key && !view.rateMap?.beyond ? rateKey(result.rate ?? 1) : null;
            state.ladder = new Map();
            state.details = key && lastDetails?.key === key ? lastDetails.details ?? null : null;
            state.sections = key && lastSections?.key === key ? lastSections.sections ?? null : undefined;
            state.partSel = null;
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

    function onSections(payload) {
        if (typeof payload?.key !== "string") return;
        lastSections = payload;
        if (payload.key !== state.key) return;
        state.sections = payload.sections ?? null;
        state.partSel = null;
        later();
    }

    // the line under the parts' chart tells the part under the pointer, and the chosen one again once it leaves
    function tell(target) {
        const bar = target?.closest?.("[data-part]");
        const info = card?.querySelector?.(".an-sec-info");
        if (!info) return;
        const chosen = card.querySelector(".an-sec-sel");
        const text = (bar ?? chosen)?.dataset?.info;
        if (typeof text === "string" && info.textContent !== text) info.textContent = text;
    }

    // clicks on the blocks under the card, found by their data-* attributes on the way up to #card
    function act(target) {
        for (let node = target; node && node !== card; node = node.parentElement) {
            const data = node.dataset ?? {};
            if (data.part !== undefined) {
                const i = Number(data.part);
                if (Number.isInteger(i) && i >= 0) {
                    state.partSel = i;
                    redraw();
                    card?.querySelector?.(`[data-part="${i}"]`)?.focus?.(); // the bar was drawn anew
                }
                return;
            }
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
                remember();
                maybeLadder(0);
                redraw();
                card?.querySelector?.("[data-toggle=ladder]")?.focus?.(); // the button was drawn anew
                return;
            }
            if (data.toggle === "parts") {
                state.partsOpen = !state.partsOpen;
                remember();
                redraw();
                card?.querySelector?.("[data-toggle=parts]")?.focus?.();
                return;
            }
        }
    }

    card?.addEventListener?.("click", (e) => act(e?.target));
    card?.addEventListener?.("mouseover", (e) => tell(e?.target));
    card?.addEventListener?.("focusin", (e) => tell(e?.target));
    card?.addEventListener?.("mouseleave", () => tell(null));
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
    try {
        api()?.onAnalysisSections?.(onSections);
    } catch {
        // no dan by part: the rest still works
    }

    return {
        html(view) {
            follow(view);
            return renderExtras({
                view, details: state.details, sections: state.sections, partSel: state.partSel, partsOpen: state.partsOpen,
                profile: state.profile, ladder: state.ladder, ladderOpen: state.ladderOpen,
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
