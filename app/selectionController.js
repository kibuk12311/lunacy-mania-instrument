// Turns tosu frames into window views: latest selection wins, results cached per (chart, rate).
import { cacheKey } from "../src/core/cache.js";
import { getLang, t } from "../src/i18n/i18n.js";
import { detectVibro } from "../src/vibro/detect.js";

const UPDATE_HINT_MS = 10_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

// the rate a rate map's original is shown at: the rate map's own times the mods', to 4 decimals (no float dust); null
// out of the ladder's 0.5…2, where the card shows the rate map as it is (its ladder and the Rate tab are still the original's)
function shownRate(mapRate, rate) {
    const shown = Math.round(mapRate * rate * 1e4) / 1e4;
    return shown >= 0.5 && shown <= 2 ? shown : null;
}

// The card's vibro mark: the chart's .osu at the rate it is played at (the file's own at the mods' rate, its real speed)
// → { share, timeShare, longestRows, peakGapMs, confidence } when it is vibro (src/vibro/detect.js), else null. Worked
// out beside the analysis, never in it: the result and its cache stay as they are.
export function cardVibro(text, rate) {
    try {
        const v = detectVibro(text, rate);
        if (!v?.vibro) return null;
        return { share: v.share, timeShare: v.timeShare, longestRows: v.longestRows, peakGapMs: v.peakGapMs, confidence: v.confidence };
    } catch {
        return null;
    }
}

// onResult({ key, text, rate, result, checksum, rateMap }): once per fresh result that is still the selection (cache hits and
// errors too, key and text null when the file could not be read); showing a kept result again does not call it.
// rateOrigin(text, { checksum }) → Promise of null or the original of a rate map (app/rateMapOrigin.js): a difficulty
// already sped up into a file of its own. Its dan stays the file's own (the file at the mods' rate, as for any map: the
// calculators do not give a chart at ×r and its rate map at 1.0 the same dan), but the card shows it as its original at
// the rate map's rate times the mods', as Interlude's charts at a rate: the view's result.rate is that rate and its
// rateMap { rate, virtual } says so; onResult's rateMap { rate, shown, text } gives the ladder the original's chart
// (key, text, rate, result and checksum stay the file's: the details, the dan by part and the overlay go by them).
// Past the ladder's 0.5…2 (a 1.5x rate map with DT) the card shows the file as it is (view.rateMap.beyond), while the
// ladder's rows stay its original's, none of them marked, and rateMap() still gives the original: a row and the Rate tab
// it opens are the same chart, which does not depend on the mods, and the sped-up file is never re-rated.
export function createSelectionController({ fetchOsu, analyze, cache, now = Date.now, onView, onResult = () => {}, rateOrigin = null }) {
    let tosuStatus = "connecting";
    let sawFrame = false;
    let current = null; // { checksum, rate, lang } being shown or analysed
    let currentResult = null; // last result for `current`
    let currentKey = null; // its cache key, when the file was read
    let currentOrigin = null; // the rate map's original for `current` (rateOrigin's answer and its `shown` rate, null past the ladder), or null
    let currentVibro = null; // cardVibro of `current`'s chart, or null
    let requestId = 0;
    let missingSince = null;
    let lastView = null;
    let failure = null; // { at, attempts } after a transient error (tosu fetch, worker timeout) for `current`
    // a map shown from somewhere else than osu! (an Interlude chart): { checksum, rate, text, osuKey, onEnd } — kept
    // until osu!'s own selection is another one than when it was shown (osuKey)
    let external = null;
    let lastOsuKey = null;
    // deterministic analysis errors: not cached on disk, but never recomputed this session (per language: they hold text)
    const errorMemo = new Map();

    function show(view) {
        lastView = view;
        onView(view);
    }

    const retryDelay = (attempts) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
    function resultView() {
        const plain = currentKey ? { screen: "result", result: currentResult, key: currentKey } : { screen: "result", result: currentResult };
        const view = currentVibro && currentResult?.kind === "ok" ? { ...plain, vibro: currentVibro } : plain;
        if (!currentOrigin || currentResult?.kind !== "ok") return view;
        const rateMap = { rate: currentOrigin.rate, virtual: currentOrigin.virtual === true };
        if (currentOrigin.shown === null) return { ...view, rateMap: { ...rateMap, beyond: true } };
        return { ...view, result: { ...currentResult, rate: currentOrigin.shown }, rateMap };
    }

    async function run(checksum, rate) {
        const id = ++requestId;
        const isSameSelection = current && current.checksum === checksum && current.rate === rate;
        if (!isSameSelection) failure = null;
        const lang = getLang();
        current = { checksum, rate, lang };
        currentResult = null;
        currentKey = null;
        currentOrigin = null;
        currentVibro = null;
        show({ screen: "loading" });
        let result;
        let key = null;
        let text = null;
        let origin = null;
        try {
            const fromOsu = !(external && external.checksum === checksum);
            const fetched = fromOsu ? await fetchOsu() : external.text;
            if (id !== requestId) return;
            if (typeof fetched !== "string" || !fetched) throw new Error(t("app.select.noFile"));
            text = fetched;
            // a rate map's original is looked for while the chart itself is analysed; a failure only leaves it out
            const looking = fromOsu && rateOrigin
                ? Promise.resolve().then(() => rateOrigin(fetched, { checksum })).catch(() => null)
                : null;
            key = cacheKey(text, rate);
            const memoKey = `${lang} ${key}`;
            result = errorMemo.get(memoKey) ?? await cache.get(key);
            if (id !== requestId) return;
            if (result === undefined) {
                result = await analyze(text, rate);
                if (result?.kind === "error" && !result.transient) errorMemo.set(memoKey, result);
                else if (result?.kind !== "error") await cache.set(key, result);
            }
            const found = looking ? await looking : null;
            if (id !== requestId) return;
            const isOrigin = typeof found?.text === "string" && found.text && Number.isFinite(found.rate);
            origin = isOrigin ? { ...found, shown: shownRate(found.rate, rate) } : null;
        } catch (error) {
            result = { kind: "error", message: String(error?.message ?? error), transient: true };
        }
        if (id !== requestId) return;
        failure = result?.transient ? { at: now(), attempts: (failure?.attempts ?? 0) + 1 } : null;
        currentResult = result;
        currentKey = key;
        currentOrigin = origin;
        currentVibro = result?.kind === "ok" && text ? cardVibro(text, rate) : null;
        show(resultView());
        try {
            const rateMap = origin ? { rateMap: { rate: origin.rate, shown: origin.shown, text: origin.text } } : {};
            onResult({ key, text, rate, result, checksum, ...rateMap });
        } catch {
            // a tab's hook must not stop the card
        }
    }

    return {
        // An outside map on the card: { id, text, rate }; onEnd() when osu!'s selection takes the card back.
        showExternal({ id, text, rate = 1, onEnd = () => {} }) {
            external = { checksum: `external:${id}`, rate, text, osuKey: lastOsuKey, onEnd };
            run(external.checksum, rate);
        },
        // An outside map that can't be analysed here (an Interlude chart not in the linked library): what is known of it
        // on the card, { id, rate, title, artist, diff, note }, kept like showExternal's until osu! takes the card back.
        showInfo({ id, rate = 1, title = "", artist = "", diff = "", note = "", onEnd = () => {} }) {
            external = { checksum: `external:${id}`, rate, text: null, osuKey: lastOsuKey, onEnd };
            requestId += 1; // an analysis still running for the card is no longer wanted
            current = null;
            currentResult = null;
            currentKey = null;
            currentOrigin = null;
            currentVibro = null;
            failure = null;
            show({ screen: "external-info", info: { title, artist, diff, rate, note } });
        },
        external: () => (external ? { checksum: external.checksum, rate: external.rate } : null),
        // the original of the rate map on the card once its result is there (rateOrigin's answer with its `shown`
        // rate, null when the mods take it past the ladder), else null: the Rate tab works on it instead of the sped-up
        // file, whatever the mods
        rateMap: () => (currentOrigin && currentResult ? currentOrigin : null),
        onFrame(frame) {
            sawFrame = true;
            const osuKey = frame.checksum === null ? null : `${frame.checksum} ${frame.rate}`;
            if (osuKey !== null) lastOsuKey = osuKey;
            if (external) {
                if (osuKey === null || frame.state === "playing" || osuKey === external.osuKey) return;
                const ended = external;
                external = null;
                try {
                    ended.onEnd();
                } catch {
                    // the listener's problem
                }
            }
            if (frame.checksum === null && frame.state !== "menu") {
                missingSince ??= now();
            } else {
                missingSince = null;
            }
            if (frame.state === "playing" || frame.checksum === null) return;
            // an error message is text: after a language switch the same selection is worked out again to show it anew
            const same = current && current.checksum === frame.checksum && current.rate === frame.rate
                && (current.lang === getLang() || currentResult?.kind !== "error");
            if (same) {
                if (failure && now() - failure.at >= retryDelay(failure.attempts)) {
                    run(frame.checksum, frame.rate);
                } else if (currentResult && lastView?.screen !== "result" && lastView?.screen !== "loading") {
                    show(resultView());
                }
                return;
            }
            run(frame.checksum, frame.rate);
        },
        onTosuStatus(status) {
            tosuStatus = status;
            if (status !== "connected") missingSince = null;
            if (status === "down" && !external && (!sawFrame || !lastView)) show({ screen: "waiting-osu" });
        },
        onTosuFailed(reason) {
            if (external) return; // an Interlude chart on the card needs no osu!
            show({ screen: "tosu-failed", reason });
        },
        tick() {
            if (tosuStatus === "connected" && missingSince !== null && now() - missingSince >= UPDATE_HINT_MS) {
                if (lastView?.screen !== "osu-updated") show({ screen: "osu-updated" });
            }
        },
    };
}
