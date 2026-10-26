// Timing detection for the create tab, run in the worker (detect-timing) → Timing
// { sections, bpm, offsetMs, confidence, variable, refinedErrMs }.
// With fine onsets (fineOnset.js) every red line is refined to the millisecond and moved by OFFSET_BIAS_MS, the
// measured gap between our attacks and where people put red lines; without them the envelope alone decides.
// With `hint` (the user's own timing, «Подогнать по волне») its sections are kept and refined.
import { detectTimingSections } from "./tempo.js";
import { OFFSET_BIAS_MS } from "./fineOnset.js";

const hintSections = (hint) => {
    const raw = hint?.sections?.length ? hint.sections : hint ? [{ timeMs: hint.offsetMs, bpm: hint.bpm }] : null;
    return raw && { sections: raw.map((s) => ({ timeMs: s.timeMs, bpm: s.bpm, meter: s.meter ?? 4 })).sort((a, b) => a.timeMs - b.timeMs) };
};

export function detectTimingFull({ envelope, fine = null, hint = null }) {
    const found = detectTimingSections(envelope, { fine, hint: hintSections(hint) });
    let sections = found.sections;
    if (fine) {
        sections = sections.map((s, i) => {
            let timeMs = s.timeMs + OFFSET_BIAS_MS;
            if (i === 0 && !hint) {
                const beatMs = 60000 / s.bpm;
                timeMs = ((timeMs % beatMs) + beatMs) % beatMs;
            }
            return { ...s, timeMs: Math.max(0, Math.round(timeMs)) };
        });
        sections = sections.filter((s, i) => i === 0 || s.timeMs > sections[i - 1].timeMs);
    }
    return {
        sections,
        bpm: sections[0].bpm,
        offsetMs: sections[0].timeMs,
        confidence: found.confidence,
        variable: sections.length > 1,
        refinedErrMs: found.refinedErrMs,
    };
}
