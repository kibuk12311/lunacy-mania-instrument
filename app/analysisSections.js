// The analysis tab's «Дан по частям» in main: the dan of each part of the map selected (src/analysis/sections.js,
// the worker's "sections" job in the background line), once per map and rate, kept in the shared result cache like
// the card's details. Fed by the selection controller's "result" hook, as the details are; the card's own dan is not
// touched.
// onResult({ key, text, rate, result }) — the selection changed; an ok result gets its parts delayMs later (after the
//   details, which wait less), from the cache or the worker, sent as send({ key, sections | null }) only while key is
//   still the selection;
// last() → the payload sent for the current map, or null (sent again when the page reloads).
import { validRate } from "./validate.js";
import { SECTIONS_VERSION } from "../src/analysis/sections.js";

// bumped with a new cut or a new correction (src/analysis/sectionCalibration.js), so an older cached answer is never
// served
const SECTIONS_CACHE = 1;
export const sectionsKey = (key) => `${key}#sections${SECTIONS_VERSION}.${SECTIONS_CACHE}`;

export const looksLikeSections = (s) => s?.v === SECTIONS_VERSION && Array.isArray(s.parts) && Number.isInteger(s.top);

export function createSectionsService({
    analysis, worker, cache, send, log = () => {}, delayMs = 500, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
    let current = null; // the key selected
    let timer = null;
    let running = null; // the key whose parts are being worked out
    let last = null;

    const isCurrent = (key) => current === key;

    async function cached(key) {
        try {
            const value = await cache.get(sectionsKey(key));
            return looksLikeSections(value) ? value : null;
        } catch {
            return null;
        }
    }

    // the parts, null when they could not be worked out, undefined when another map took the line meanwhile
    async function workOut(key, text, rate) {
        const hit = await cached(key);
        if (hit) {
            log(`sections ${key} ok cached`);
            return hit;
        }
        if (!isCurrent(key)) return undefined;
        const started = Date.now();
        // on the worker the line runs on (its pool when there is one), else this one
        const answer = await analysis.enqueue((on = worker) => on.sections(text, rate), { isCancelled: () => !isCurrent(key) });
        if (answer?.cancelled) return undefined;
        if (answer?.kind !== "sections" || !looksLikeSections(answer.sections)) {
            log(`sections ${key} fail ${answer?.message ?? ""}`.trimEnd());
            return null; // told as such; asked again the next time the map is selected
        }
        log(`sections ${key} ok ${answer.sections.parts.length} parts ${Date.now() - started} ms`);
        try {
            await cache.set(sectionsKey(key), answer.sections);
        } catch (error) {
            log(`sections cache write failed: ${error?.message}`); // still good to show
        }
        return answer.sections;
    }

    async function fetchFor(key, text, rate) {
        if (running === key) return;
        running = key;
        try {
            const sections = await workOut(key, text, rate);
            if (sections === undefined || !isCurrent(key)) return;
            last = { key, sections: sections ?? null };
            send(last);
        } catch (error) {
            log(`sections ${key} fail ${error?.message ?? error}`);
        } finally {
            if (running === key) running = null;
        }
    }

    return {
        onResult({ key, text, rate, result } = {}) {
            current = typeof key === "string" && key ? key : null;
            clearTimer(timer);
            timer = null;
            if (!current || typeof text !== "string" || result?.kind !== "ok" || !validRate(rate)) return;
            const chosen = current;
            timer = setTimer(() => {
                timer = null;
                if (isCurrent(chosen)) fetchFor(chosen, text, rate);
            }, delayMs);
        },
        last: () => (last && isCurrent(last.key) ? last : null),
    };
}
