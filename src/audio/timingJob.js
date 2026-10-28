// Timing detection for the create tab, run in the worker (detect-timing) → Timing
// { sections, bpm, offsetMs, confidence, variable, refinedErrMs, alternatives }.
// With fine onsets (fineOnset.js) every red line is refined to the millisecond and moved by OFFSET_BIAS_MS, the
// measured gap between our attacks and where people put red lines; without them the envelope alone decides.
// With `hint` (the user's own timing, «Подогнать по волне») its sections are kept and refined: with fine onsets its
// red lines are first moved to where their attacks would be (−OFFSET_BIAS_MS), so the search stays next to them.
// alternatives: [{ timeMs, bpm, share }], the other octaves of a single BPM that score close to it (the timing panel
// offers them as one click); [] for a hint or a variable BPM.
import { detectTimingSections } from "./tempo.js";
import { OFFSET_BIAS_MS } from "./fineOnset.js";

const hintSections = (hint, shiftMs) => {
    const raw = hint?.sections?.length ? hint.sections : hint ? [{ timeMs: hint.offsetMs, bpm: hint.bpm }] : null;
    return raw && { sections: raw.map((s) => ({ timeMs: s.timeMs + shiftMs, bpm: s.bpm, meter: s.meter ?? 4 })).sort((a, b) => a.timeMs - b.timeMs) };
};

// a first red line: on the first beat at or after 0, whole ms
const firstLine = (timeMs, bpm) => {
    const beatMs = 60000 / bpm;
    return Math.max(0, Math.round(((timeMs % beatMs) + beatMs) % beatMs));
};

export function detectTimingFull({ envelope, fine = null, hint = null }) {
    const found = detectTimingSections(envelope, { fine, hint: hintSections(hint, fine ? -OFFSET_BIAS_MS : 0) });
    let sections = found.sections;
    let alternatives = hint ? [] : found.alternatives ?? [];
    if (fine) {
        sections = sections.map((s, i) => {
            const timeMs = s.timeMs + OFFSET_BIAS_MS;
            return { ...s, timeMs: i === 0 && !hint ? firstLine(timeMs, s.bpm) : Math.max(0, Math.round(timeMs)) };
        });
        sections = sections.filter((s, i) => i === 0 || s.timeMs > sections[i - 1].timeMs);
        alternatives = alternatives.map((a) => ({ ...a, timeMs: firstLine(a.timeMs + OFFSET_BIAS_MS, a.bpm) }));
    }
    return {
        sections,
        bpm: sections[0].bpm,
        offsetMs: sections[0].timeMs,
        confidence: found.confidence,
        variable: sections.length > 1,
        refinedErrMs: found.refinedErrMs,
        alternatives: sections.length > 1 ? [] : alternatives,
    };
}
