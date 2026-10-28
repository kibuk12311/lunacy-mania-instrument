// The Dan widget's data in main: per map and rate (the overlay session's checksum — osu!'s MD5 from tosu, or
// "interlude:<hash>" — and the play's rate) the card's analysis result, worked out once and kept for the last few
// maps, never per frame. The widget shows the map's overall dan, the card's own.
//   - the card feeds it: every result the selection controller has for the selected map (hooks "result") is kept
//     at once under that map's key;
//   - a play of a map the card has not shown (a multiplayer pick, a map started from elsewhere) asks for it once:
//     its .osu text (tosu's file, Interlude's library chart) goes through the same analysis and cache.
// analyze({ text, rate, result }) → { result } (makeDanAnalyzer below: the shared cache, the worker's background
// line); onChange(key) when an entry changed. Beside a result with a dan the entry keeps whether the map is vibro at
// that rate (src/vibro/detect.js over the same .osu, not part of the analysis): the widget's "this play" says so.
import { danKey, danStateOf } from "../../src/overlay/dan.js";
import { detectVibro, vibroSummary } from "../../src/vibro/detect.js";

const KEEP = 8; // maps kept
export const RETRY_MS = 15_000; // a transient failure (the worker busy, a fetch that failed) is asked again after this

// The analysis for the Dan widget over the app's shared services: the result from the shared cache (the card's), else
// the worker's background line.
export function makeDanAnalyzer({ analysis }) {
    return async ({ text, rate, result = null }) => ({ result: result ?? await analysis.analyzeQueued(text, rate) ?? null });
}

// The card's checksum (selection controller) → the overlay's: an Interlude chart on the card is "external:<hash>".
export const overlayChecksum = (checksum) => (typeof checksum === "string" && checksum.startsWith("external:")
    ? `interlude:${checksum.slice("external:".length)}`
    : checksum);

// A result with a dan and its .osu at the rate → the vibro summary kept beside it, or null.
function vibroFor(result, text, rate) {
    if (result?.kind !== "ok" || typeof text !== "string" || !text) return null;
    try {
        return vibroSummary(detectVibro(text, rate));
    } catch {
        return null;
    }
}

export function createDanSource({ analyze = null, log = () => {}, onChange = () => {}, now = () => Date.now(), keep = KEEP }) {
    const entries = new Map(); // key → { state, result, vibro, failedAt, version }
    let version = 0;

    function put(key, patch) {
        const before = entries.get(key) ?? {};
        entries.delete(key);
        const next = { ...before, ...patch, version: ++version };
        entries.set(key, next);
        while (entries.size > keep) entries.delete(entries.keys().next().value);
        try {
            onChange(key);
        } catch {
            // the listener's problem
        }
        return next;
    }

    async function work(key, { text, rate, result = null }) {
        if (!analyze) {
            put(key, { state: "done", result: { kind: "error", message: "" } });
            return;
        }
        try {
            const body = typeof text === "function" ? await text() : text;
            if (typeof body !== "string" || !body) throw new Error("no map file");
            const out = await analyze({ text: body, rate, result });
            const transient = out?.result?.kind === "error" && out.result.transient;
            const got = transient ? null : out?.result ?? null;
            put(key, { state: transient ? "failed" : "done", result: got, vibro: vibroFor(got, body, rate), failedAt: transient ? now() : null });
            log(`overlay dan ${key} ${out?.result?.kind ?? "?"}`);
        } catch (error) {
            log(`overlay dan ${key} failed: ${error?.message ?? error}`);
            put(key, { state: "failed", failedAt: now() });
        }
    }

    return {
        // the map of a play at its rate: worked out unless it is known, on its way, or failed only just now.
        // text: the .osu text, or () → Promise of it
        want(checksum, rate, { text }) {
            if (!checksum) return null;
            const key = danKey(checksum, rate);
            const e = entries.get(key);
            if (e && (e.state !== "failed" || now() - e.failedAt < RETRY_MS)) return key;
            put(key, { state: "counting" });
            void work(key, { text, rate });
            return key;
        },
        // a result the card has for its map ({ checksum, rate, result, text } of the "result" hook, checksum added): kept
        // as it is, with whether the map is vibro at that rate from the same text
        fromCard({ checksum, rate, result, text = null } = {}) {
            const id = overlayChecksum(checksum);
            if (!id || !result) return;
            if (result.kind === "error" && result.transient) return;
            const key = danKey(id, rate);
            const e = entries.get(key);
            if (e?.state === "done" && e.result?.kind === result.kind && e.result?.numeric === result.numeric) return;
            put(key, { state: "done", result, vibro: vibroFor(result, text, rate), failedAt: null });
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
