// Form values → generator request. Shared by the renderer (labels) and tests.
import { t } from "../i18n/i18n.js";
import { PATTERN_NAMES } from "./patterns.js";
import { flavoursOf } from "./flavours.js";

const GREEK = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa"];

// `name` is a getter so it follows the current language ("1 дан" / "Dan 1"); Greek names are the same in both.
export const LEVELS = Array.from({ length: 20 }, (_, i) => ({
    value: i + 1,
    get name() {
        return i < 10 ? t("create.level.dan", { n: i + 1 }) : GREEK[i - 10];
    },
}));

export const STEPS = [
    { id: "low", offset: -0.4 },
    { id: "low/mid", offset: -0.2 },
    { id: "mid", offset: 0 },
    { id: "mid/high", offset: 0.2 },
    { id: "high", offset: 0.4 },
];

export function targetNumeric(level, step) {
    const s = STEPS.find((x) => x.id === step) ?? STEPS[2];
    return Math.round((level + s.offset) * 10) / 10;
}

// A family's chosen flavours (sub-patterns): the known ones of that family, each once, in the catalogue's order;
// none → the key is left out, so a family-only pattern stays { name, share } as before.
export function cleanFlavours(name, flavours) {
    if (!Array.isArray(flavours)) return [];
    const own = flavoursOf(name);
    return own.filter((id) => flavours.includes(id));
}
// A pattern's flavours as sent: none, or a list of its own family's (what the worker accepts, at the top level and in
// a part alike).
const flavoursValid = (p) => p?.flavours === undefined || (Array.isArray(p.flavours) && p.flavours.every((f) => flavoursOf(p.name).includes(f)));
const withFlavours = (p, out) => {
    const flavours = cleanFlavours(p.name, p.flavours);
    return flavours.length ? { ...out, flavours } : out;
};

export function normalizeShares(patterns) {
    if (!patterns.length) throw new Error(t("create.error.noPatterns"));
    const total = patterns.reduce((s, p) => s + Math.max(0, Number(p.share) || 0), 0);
    if (total <= 0) return patterns.map((p) => withFlavours(p, { name: p.name, share: 1 / patterns.length }));
    return patterns.map((p) => withFlavours(p, { name: p.name, share: Math.round((Math.max(0, Number(p.share) || 0) / total) * 1000) / 1000 }));
}

// ---- mapgen v3: the whole request and the song parts, checked again in the worker ----

export const PART_KINDS = ["intro", "build", "drop", "break", "outro", "part"];
const SNAPS = [4, 3, 6, 8];
const MAX_PARTS = 24;
const MAX_OWN_RANGES = 8;
const MAX_DAN = 21;
const DEFAULT_BAR_MS = 2000;

// The generator's request with every default filled in: range (or the old single target), shares that sum to 1,
// the two seeds (both default to `seed`), the grids (1/4 always) and the scroll-speed lines. A flavour that is not
// its pattern's own throws gen.request.bad, as it does in a part (gen.parts.bad).
export function normalizeRequest(raw, _durationMs) {
    (raw.patterns ?? []).forEach((p, i) => {
        if (!flavoursValid(p)) throw new Error(t("gen.request.bad", { what: `patterns[${i}].flavours` }));
    });
    const range = raw.range ? { lo: raw.range.lo, hi: raw.range.hi } : null;
    const seed = Number.isSafeInteger(raw.seed) ? raw.seed : 1;
    return {
        ...raw,
        range,
        target: range ? (range.lo + range.hi) / 2 : raw.target,
        patterns: normalizeShares(raw.patterns ?? []),
        mix: raw.mix === "mixed" ? "mixed" : "sections",
        stamina: raw.stamina ?? 0.5,
        burst: raw.burst ?? 0.3,
        seed,
        planSeed: Number.isSafeInteger(raw.planSeed) ? raw.planSeed : seed,
        noteSeed: Number.isSafeInteger(raw.noteSeed) ? raw.noteSeed : seed,
        snaps: SNAPS.filter((s) => s === 4 || raw.snaps?.includes(s)),
        normalizeSv: raw.normalizeSv ?? true,
    };
}

const badParts = (what) => new Error(t("gen.parts.bad", { what }));
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

function checkPart(p, i) {
    const at = `parts[${i}]`;
    if (!p || typeof p !== "object" || !isNumber(p.startMs) || !isNumber(p.endMs) || !(p.startMs < p.endMs)) throw badParts(at);
    if (!PART_KINDS.includes(p.kind)) throw badParts(`${at}.kind`);
    const out = { startMs: p.startMs, endMs: p.endMs, kind: p.kind };
    if (p.range) {
        const { lo, hi } = p.range;
        if (!isNumber(lo) || !isNumber(hi) || lo < 0 || hi > MAX_DAN || !(lo < hi)) throw badParts(`${at}.range`);
        out.range = { lo, hi };
    }
    if (p.patterns) {
        if (!Array.isArray(p.patterns) || !p.patterns.length || p.patterns.some((x) => !PATTERN_NAMES.includes(x?.name))) throw badParts(`${at}.patterns`);
        if (!p.patterns.every(flavoursValid)) throw badParts(`${at}.patterns.flavours`);
        out.patterns = normalizeShares(p.patterns);
    }
    if (p.empty) out.empty = true;
    if (Number.isSafeInteger(p.seed)) out.seed = p.seed;
    return out;
}

// Song parts (sent or detected) → parts that cover [0, durationMs) end to end: sorted, clipped, gaps closed by
// stretching the part before, parts under a bar merged into a neighbour, at most 24 (the shortest merge first).
// A merged part keeps its neighbour's settings. Throws gen.parts.bad naming the field.
export function normalizeParts(parts, durationMs, { barMs = DEFAULT_BAR_MS } = {}) {
    if (!Array.isArray(parts)) throw badParts("parts");
    const checked = parts.map(checkPart);
    if (checked.filter((p) => p.range).length > MAX_OWN_RANGES) throw badParts("parts");
    let list = checked
        .map((p) => ({ ...p, startMs: Math.max(0, p.startMs), endMs: Math.min(durationMs, p.endMs) }))
        .filter((p) => p.endMs > p.startMs)
        .sort((a, b) => a.startMs - b.startMs);
    if (!list.length) return [{ startMs: 0, endMs: durationMs, kind: "part" }];
    list[0].startMs = 0;
    for (let i = 1; i < list.length; i += 1) list[i].startMs = Math.max(list[i].startMs, list[i - 1].startMs);
    for (let i = 0; i + 1 < list.length; i += 1) list[i].endMs = list[i + 1].startMs;
    list.at(-1).endMs = durationMs;
    list = list.filter((p) => p.endMs > p.startMs);
    const length = (p) => p.endMs - p.startMs;
    // part i goes into part j (a neighbour), which keeps its own settings
    const mergeInto = (i, j) => {
        const keep = list[j];
        keep.startMs = Math.min(keep.startMs, list[i].startMs);
        keep.endMs = Math.max(keep.endMs, list[i].endMs);
        list.splice(i, 1);
    };
    for (let i = 0; i < list.length && list.length > 1;) {
        if (length(list[i]) < barMs) mergeInto(i, i === 0 ? 1 : i - 1);
        else i += 1;
    }
    while (list.length > MAX_PARTS) {
        let i = 0;
        for (let k = 1; k < list.length; k += 1) if (length(list[k]) < length(list[i])) i = k;
        const before = i > 0 ? i - 1 : null;
        const after = i + 1 < list.length ? i + 1 : null;
        mergeInto(i, after === null || (before !== null && length(list[before]) <= length(list[after])) ? before : after);
    }
    return list;
}
