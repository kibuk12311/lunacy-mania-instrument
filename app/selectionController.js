// Turns tosu frames into window views: latest selection wins, results cached per (chart, rate).
import { cacheKey } from "../src/core/cache.js";
import { getLang, t } from "../src/i18n/i18n.js";

const UPDATE_HINT_MS = 10_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

// onResult({ key, text, rate, result }): once per fresh result that is still the selection (cache hits and errors
// too, key and text null when the file could not be read); showing a kept result again does not call it.
export function createSelectionController({ fetchOsu, analyze, cache, now = Date.now, onView, onResult = () => {} }) {
    let tosuStatus = "connecting";
    let sawFrame = false;
    let current = null; // { checksum, rate, lang } being shown or analysed
    let currentResult = null; // last result for `current`
    let currentKey = null; // its cache key, when the file was read
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
    const resultView = () => (currentKey ? { screen: "result", result: currentResult, key: currentKey } : { screen: "result", result: currentResult });

    async function run(checksum, rate) {
        const id = ++requestId;
        const isSameSelection = current && current.checksum === checksum && current.rate === rate;
        if (!isSameSelection) failure = null;
        const lang = getLang();
        current = { checksum, rate, lang };
        currentResult = null;
        currentKey = null;
        show({ screen: "loading" });
        let result;
        let key = null;
        let text = null;
        try {
            const fetched = external && external.checksum === checksum ? external.text : await fetchOsu();
            if (id !== requestId) return;
            if (typeof fetched !== "string" || !fetched) throw new Error(t("app.select.noFile"));
            text = fetched;
            key = cacheKey(text, rate);
            const memoKey = `${lang} ${key}`;
            result = errorMemo.get(memoKey) ?? await cache.get(key);
            if (id !== requestId) return;
            if (result === undefined) {
                result = await analyze(text, rate);
                if (result?.kind === "error" && !result.transient) errorMemo.set(memoKey, result);
                else if (result?.kind !== "error") await cache.set(key, result);
            }
        } catch (error) {
            result = { kind: "error", message: String(error?.message ?? error), transient: true };
        }
        if (id !== requestId) return;
        failure = result?.transient ? { at: now(), attempts: (failure?.attempts ?? 0) + 1 } : null;
        currentResult = result;
        currentKey = key;
        show(resultView());
        try {
            onResult({ key, text, rate, result });
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
            failure = null;
            show({ screen: "external-info", info: { title, artist, diff, rate, note } });
        },
        external: () => (external ? { checksum: external.checksum, rate: external.rate } : null),
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
