// The Dan widget's data in main: per map and rate (the overlay session's checksum — osu!'s MD5 from tosu, or
// "interlude:<hash>" — and the play's rate) the card's analysis result and its details (the difficulty line), worked
// out once and kept for the last few maps, never per frame.
//   - the card feeds it: every result the selection controller has for the selected map (hooks "result") is kept
//     at once under that map's key, its details looked up after (the card's own details job caches them);
//   - a play of a map the card has not shown (a multiplayer pick, a map started from elsewhere) asks for it once:
//     its .osu text (tosu's file, Interlude's library chart) goes through the same analysis and cache.
// analyze({ text, rate, result }) → { result, details } (makeDanAnalyzer below: the shared cache, the worker's
// background line); onChange(key) when an entry changed.
import { cacheKey } from "../../src/core/cache.js";
import { parseManiaNotes } from "../../src/overlay/maniaNotes.js";
import { danKey, danStateOf, sectionDans } from "../../src/overlay/dan.js";
import { detailsKey, looksLikeDetails } from "../analysisDetails.js";

const KEEP = 8; // maps kept
export const RETRY_MS = 15_000; // a transient failure (the worker busy, a fetch that failed) is asked again after this

// The analysis for the Dan widget over the app's shared services: the result from the shared cache (the card's), else
// the worker's background line; the details likewise (the card's details job caches them under detailsKey).
export function makeDanAnalyzer({ analysis, worker, cache, log = () => {} }) {
    return async ({ text, rate, result = null }) => {
        const r = result ?? await analysis.analyzeQueued(text, rate);
        if (r?.kind !== "ok") return { result: r ?? null, details: null };
        const key = detailsKey(cacheKey(text, rate));
        let details = null;
        try {
            const hit = await cache.get(key);
            details = looksLikeDetails(hit) ? hit : null;
        } catch {
            details = null;
        }
        if (!details) {
            const answer = await analysis.enqueue(() => worker.details(text, rate));
            details = answer?.kind === "details" && looksLikeDetails(answer.details) ? answer.details : null;
            if (details) {
                try {
                    await cache.set(key, details);
                } catch (error) {
                    log(`overlay dan: details not cached (${error?.message})`); // still good to show
                }
            }
        }
        return { result: r, details };
    };
}

// the first note's time on the play's clock: the .osu's own (osu!), 0 for Interlude (its clock starts at the first note)
function firstNoteMs(text, interlude) {
    if (interlude) return 0;
    try {
        return parseManiaNotes(text)?.notes?.[0]?.t ?? 0;
    } catch {
        return 0;
    }
}

// The card's checksum (selection controller) → the overlay's: an Interlude chart on the card is "external:<hash>".
export const overlayChecksum = (checksum) => (typeof checksum === "string" && checksum.startsWith("external:")
    ? `interlude:${checksum.slice("external:".length)}`
    : checksum);

export function createDanSource({ analyze = null, log = () => {}, onChange = () => {}, now = () => Date.now(), keep = KEEP }) {
    const entries = new Map(); // key → { state, result, details, sections, firstMs, lastMs, failedAt, version }
    let version = 0;

    function put(key, patch) {
        const before = entries.get(key) ?? {};
        entries.delete(key);
        const next = { ...before, ...patch, version: ++version };
        if (next.result?.kind === "ok") {
            next.sections = sectionDans(next.details?.strain, next.result.numeric);
            const sec = Number(next.details?.durationSec ?? next.result.durationSec);
            const rate = Number(next.result.rate) > 0 ? Number(next.result.rate) : 1;
            next.lastMs = Number.isFinite(sec) && Number.isFinite(next.firstMs) ? next.firstMs + sec * 1000 * rate : null;
        }
        entries.set(key, next);
        while (entries.size > keep) entries.delete(entries.keys().next().value);
        try {
            onChange(key);
        } catch {
            // the listener's problem
        }
        return next;
    }

    async function work(key, { text, rate, interlude, result = null }) {
        if (!analyze) {
            put(key, { state: "done", result: { kind: "error", message: "" } });
            return;
        }
        try {
            const body = typeof text === "function" ? await text() : text;
            if (typeof body !== "string" || !body) throw new Error("no map file");
            const firstMs = firstNoteMs(body, interlude);
            if (result) put(key, { state: "counting", result, firstMs }); // the card's dan shows before its details
            const out = await analyze({ text: body, rate, result });
            const transient = out?.result?.kind === "error" && out.result.transient;
            put(key, { state: transient ? "failed" : "done", result: transient ? null : out?.result ?? null, details: out?.details ?? null, firstMs, failedAt: transient ? now() : null });
            log(`overlay dan ${key} ${out?.result?.kind ?? "?"}${out?.details ? " +line" : ""}`);
        } catch (error) {
            log(`overlay dan ${key} failed: ${error?.message ?? error}`);
            put(key, { state: "failed", failedAt: now() });
        }
    }

    return {
        // the map of a play at its rate: worked out unless it is known, on its way, or failed only just now.
        // text: the .osu text, or () → Promise of it
        want(checksum, rate, { text, interlude = false }) {
            if (!checksum) return null;
            const key = danKey(checksum, rate);
            const e = entries.get(key);
            if (e && (e.state !== "failed" || now() - e.failedAt < RETRY_MS)) return key;
            put(key, { state: "counting" });
            void work(key, { text, rate, interlude });
            return key;
        },
        // a result the card has for its map ({ checksum, text, rate, result } of the "result" hook, checksum added)
        fromCard({ checksum, text, rate, result } = {}) {
            const id = overlayChecksum(checksum);
            if (!id || typeof text !== "string" || !text || !result) return;
            if (result.kind === "error" && result.transient) return;
            const key = danKey(id, rate);
            const e = entries.get(key);
            if (e?.state === "done" && e.result?.kind === result.kind && e.details) return;
            put(key, { state: "counting" });
            void work(key, { text, rate, interlude: id.startsWith("interlude:"), result });
        },
        get: (key) => entries.get(key) ?? null,
        // the widget's state for an entry: "counting" while there is no result yet
        stateOf: (key) => {
            const e = entries.get(key);
            return e?.result ? danStateOf(e.result) : "counting";
        },
        version: () => version,
    };
}
