// The analysis tab's main-process service, fed by the "result" hook of the selection controller:
// details for the map selected in osu! (the strain line and pattern strip under the card, a lazy worker job in the
// background line), and the ladder's dan of the same chart at other rates.
// onResult({ key, text, rate, result }) — the selection changed; an ok result gets its details delayMs later,
//   from the shared cache or the worker, sent as send({ key, details | null }) only while key is still the selection;
// rate({ key, rate }) → { ok:true, rate, kind:"ok", label, numeric, primary } | { ok:true, rate, kind, message }
//   | { ok:false, stale:true } (another map by now) | { ok:false, message };
// last() → the payload sent for the current map, or null (sent again when the page reloads).
import { validRate } from "./validate.js";
import { t } from "../src/i18n/i18n.js";

// bumped when the details' shape changes, so an older cached shape is never served; the overlay's Dan widget reads the
// same cache entries (app/overlay/danSource.js)
const DETAILS_VERSION = 2;
export const detailsKey = (key) => `${key}#details${DETAILS_VERSION}`;
const MAX_KEY = 80;
const KINDS = ["not-rice", "too-short", "error"];

export const looksLikeDetails = (d) => d?.v === DETAILS_VERSION && Array.isArray(d.strain) && Array.isArray(d.families) && Array.isArray(d.flavourBins);

export function createDetailsService({
    analysis, worker, cache, send, log = () => {}, delayMs = 300, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
    let current = { key: null, text: null };
    let timer = null;
    let running = null; // the key whose details are being worked out
    let last = null;

    const isCurrent = (key) => current.key === key;

    async function cached(key) {
        try {
            const value = await cache.get(detailsKey(key));
            return looksLikeDetails(value) ? value : null;
        } catch {
            return null;
        }
    }

    async function workOut(key, text, rate) {
        const hit = await cached(key);
        if (hit) {
            log(`details ${key} ok cached`);
            return hit;
        }
        if (!isCurrent(key)) return undefined;
        // on the worker the line runs on (its pool when there is one), else this one
        const answer = await analysis.enqueue((on = worker) => on.details(text, rate), { isCancelled: () => !isCurrent(key) });
        if (answer?.cancelled) return undefined; // another map took its place in the line
        if (answer?.kind !== "details" || !looksLikeDetails(answer.details)) {
            log(`details ${key} fail ${answer?.message ?? ""}`.trimEnd());
            return null;
        }
        log(`details ${key} ok`);
        try {
            await cache.set(detailsKey(key), answer.details);
        } catch (error) {
            log(`details cache write failed: ${error?.message}`); // still good to show
        }
        return answer.details;
    }

    async function fetchFor(key, text, rate) {
        if (running === key) return; // the job already on its way sends when it is done
        running = key;
        try {
            const details = await workOut(key, text, rate);
            if (details === undefined || !isCurrent(key)) return;
            last = { key, details };
            send(last);
        } catch (error) {
            log(`details ${key} fail ${error?.message ?? error}`);
        } finally {
            if (running === key) running = null;
        }
    }

    return {
        onResult({ key, text, rate, result } = {}) {
            current = { key: typeof key === "string" && key ? key : null, text: typeof text === "string" ? text : null };
            clearTimer(timer);
            timer = null;
            if (!current.key || current.text === null || result?.kind !== "ok" || !validRate(rate)) return;
            const chosen = current.key;
            const chart = current.text;
            timer = setTimer(() => {
                timer = null;
                if (isCurrent(chosen)) fetchFor(chosen, chart, rate);
            }, delayMs);
        },

        async rate(request) {
            try {
                const key = typeof request?.key === "string" && request.key && request.key.length <= MAX_KEY ? request.key : null;
                if (!key) return { ok: false, message: t("analysis.err.request") };
                if (!isCurrent(key) || current.text === null) return { ok: false, stale: true };
                const rate = request.rate;
                if (typeof rate !== "number" || !validRate(rate)) return { ok: false, message: t("analysis.err.rate") };
                const r = await analysis.analyzeQueued(current.text, rate, { isCancelled: () => !isCurrent(key) });
                if (r?.cancelled || !isCurrent(key)) return { ok: false, stale: true };
                log(`ladder ${rate} ${r?.kind === "ok" ? r.label : r?.kind ?? "?"}`);
                if (r?.kind === "ok") return { ok: true, rate, kind: "ok", label: r.label, numeric: r.numeric, primary: r.primary ?? null };
                return { ok: true, rate, kind: KINDS.includes(r?.kind) ? r.kind : "error", message: String(r?.message ?? "") };
            } catch (error) {
                return { ok: false, message: String(error?.message ?? error) };
            }
        },

        last: () => (last && isCurrent(last.key) ? last : null),
    };
}
