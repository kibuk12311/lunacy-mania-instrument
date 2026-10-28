// Rate maps: a difficulty already sped up (or slowed down) into a file of its own, as the Rate tab makes them
// (src/rate/rateMap.js: "<version> <r>x (<bpm>bpm)", " NC Mirror NoLN" after it, the lunacy-mania-rate tag) and as
// osu-trainer does ("<version> <r>x (<bpm>bpm)", " HP8 OD9" after it, the osutrainer tag, the rate written with the
// player's decimal comma on some systems). Which difficulty such a file was made from and at what rate, so the card
// can show it as that original at that rate. A name alone is never enough: the file also needs its tag, its own BPM
// equal to the name's "(Nbpm)", or the original found beside it whose notes, times ÷ the rate, are the file's.
// Pure (no files): app/rateMapOrigin.js reads the folder.
import { RATE_TAG, firstRedBpm, rateOsu } from "./rateMap.js";
import { transformOsu, transformSuffix } from "./chartTransform.js";

export const OSU_TRAINER_TAG = "osutrainer";
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
// a time of the file against the original's ÷ the rate: rounding (or osu-trainer's truncation) plus a little
const TIME_SLACK_MS = 1.5;
const BPM_SLACK = 1;
const HOLD = 128;

const field = (text, key) => new RegExp(`^${key}\\s*:(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
const tagsOf = (text) => field(text, "Tags").split(/\s+/).filter(Boolean);
const number = (s) => Number(String(s).replace(",", "."));

// "<base> <rate>x", an optional " (<bpm>bpm)", then the tools' marks in any order: NC, Mirror, NoLN (ours) and
// HP / OD / CS / AR with their value (osu-trainer's)
const NAME = /^(.*?\S)\s+(\d(?:[.,]\d{1,2})?)x(?:\s+\((\d{1,4})bpm\))?((?:\s+(?:NC|Mirror|NoLN|(?:HP|OD|CS|AR)\d{1,2}(?:[.,]\d)?))*)$/i;

// A rate map's difficulty name → { base, rate, bpm (or null), pitch, mirror, noLn }; null for anything else
// ("4x4", "2x Speed", "x1.5 jacks", "Insane", a rate of 1 or out of 0.5…2).
export function parseRateVersion(version) {
    const m = NAME.exec(String(version ?? "").trim());
    if (!m) return null;
    const rate = number(m[2]);
    if (!(rate >= MIN_RATE && rate <= MAX_RATE) || rate === 1) return null;
    const marks = m[4].trim().toLowerCase().split(/\s+/).filter(Boolean);
    return {
        base: m[1].trim(),
        rate,
        bpm: m[3] === undefined ? null : Number(m[3]),
        pitch: marks.includes("nc"),
        mirror: marks.includes("mirror"),
        noLn: marks.includes("noln"),
    };
}

// The parsed name of a chart's difficulty when it reads like a rate map's (cheap: no evidence looked at yet).
export const rateVersionOf = (osuText) => parseRateVersion(field(String(osuText ?? ""), "Version"));

// Red lines as [time, bpm]; the BPMs a rate tool may have written in the name: the first red line's and the one
// that lasts longest.
function ownBpms(osuText) {
    const lines = osuText.split(/\r?\n/);
    const first = firstRedBpm(lines);
    const reds = [];
    const start = lines.findIndex((l) => l.trim() === "[TimingPoints]");
    for (let i = start + 1; start >= 0 && i < lines.length && !lines[i].startsWith("["); i += 1) {
        const p = lines[i].split(",");
        const beat = Number(p[1]);
        if (p.length > 1 && beat > 0 && (p[6] === undefined || p[6].trim() === "1")) reds.push([Number(p[0]), 60000 / beat]);
    }
    const objects = objectsOf(osuText);
    const end = objects.length ? objects.at(-1).t : 0;
    let longest = null;
    let span = -Infinity;
    reds.forEach(([at, bpm], i) => {
        const lasts = (i + 1 < reds.length ? reds[i + 1][0] : Math.max(end, at)) - at;
        if (lasts > span) [span, longest] = [lasts, bpm];
    });
    return [first, longest].filter((b) => Number.isFinite(b) && b > 0);
}

// The hit objects as { t, col, end } (end null for a note), in time then column order.
function objectsOf(osuText) {
    const keys = Math.round(Number(field(osuText, "CircleSize")));
    const lanes = Number.isFinite(keys) && keys >= 1 ? keys : 4;
    const out = [];
    let inObjects = false;
    for (const line of osuText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            inObjects = trimmed === "[HitObjects]";
            continue;
        }
        if (!inObjects || !trimmed || trimmed.startsWith("//")) continue;
        const p = trimmed.split(",");
        if (p.length < 5) continue;
        const x = Number(p[0]);
        const t = Number(p[2]);
        if (!Number.isFinite(x) || !Number.isFinite(t)) continue;
        const col = Math.min(lanes - 1, Math.max(0, Math.floor((x * lanes) / 512)));
        const end = Number(p[3]) & HOLD ? Number(String(p[5] ?? "").split(":")[0]) : null;
        out.push({ t, col, end: Number.isFinite(end) ? end : null });
    }
    return out.sort((a, b) => a.t - b.t || a.col - b.col);
}

// Is `candidate` the difficulty the rate map `osuText` (name parsed into `name`) was made from: the same song, mapper
// and keys, its version the rate map's base name, and its notes — mirrored and without holds when the name says so —
// the rate map's, every time ÷ the rate within rounding.
export function isOriginalOf(candidate, osuText, name) {
    if (typeof candidate !== "string" || !name) return false;
    for (const key of ["Artist", "Title", "Creator", "CircleSize", "Mode"]) {
        if (field(candidate, key) !== field(osuText, key)) return false;
    }
    if (field(candidate, "Version") !== name.base) return false;
    const mine = objectsOf(osuText);
    const theirs = objectsOf(transformOsu(candidate, { mirror: name.mirror, noLn: name.noLn }))
        .map((o) => ({ t: o.t / name.rate, col: o.col, end: o.end === null ? null : o.end / name.rate }))
        .sort((a, b) => a.t - b.t || a.col - b.col);
    if (!mine.length || mine.length !== theirs.length) return false;
    return mine.every((a, i) => {
        const b = theirs[i];
        if (a.col !== b.col || (a.end === null) !== (b.end === null) || Math.abs(a.t - b.t) > TIME_SLACK_MS) return false;
        return a.end === null || Math.abs(a.end - b.end) <= TIME_SLACK_MS;
    });
}

// The original made back from a rate map when it is nowhere to be found: the very chart of the file, every time × the
// rate (rateOsu at 1 ÷ rate), named by its base (with the chart's own marks, Mirror and NoLN, which stay in it) and
// without the rate tools' tags. Its audio is still the rate map's, already at that rate: no copy is made from it.
export function originalFromRateMap(osuText, name) {
    const back = rateOsu(osuText, { rate: 1 / name.rate, audioFilename: field(osuText, "AudioFilename") });
    const tags = tagsOf(osuText).filter((tag) => tag !== RATE_TAG && tag !== OSU_TRAINER_TAG).join(" ");
    const version = `${name.base}${transformSuffix({ mirror: name.mirror, noLn: name.noLn })}`;
    const id = field(osuText, "BeatmapID");
    return back
        .replace(/^Version[ \t]*:[^\r\n]*/m, () => `Version:${version}`)
        .replace(/^Tags[ \t]*:[^\r\n]*/m, () => `Tags:${tags}`)
        .replace(/^BeatmapID[ \t]*:[^\r\n]*/m, () => `BeatmapID:${id}`);
}

// osuText: the selected chart; siblings: [{ text }] the other .osu files of its folder (none on lazer).
// → null when it is not a rate map, else { rate, base, version (the rate map's), pitch, mirror, noLn, evidence
// ("original" | "tag" | "bpm"), sibling (index into siblings, or null), virtual, text }: text is the original chart
// the ladder works on — the sibling with the rate map's Mirror / NoLN applied, or originalFromRateMap's.
export function findRateOrigin(osuText, siblings = []) {
    const text = String(osuText ?? "");
    const name = rateVersionOf(text);
    if (!name) return null;
    // osu-trainer's copies meant to be played with DT on (their audio "… withDT") are at another speed than their name
    if (/\bwithDT\b/i.test(field(text, "AudioFilename"))) return null;
    const out = { rate: name.rate, base: name.base, version: field(text, "Version"), pitch: name.pitch, mirror: name.mirror, noLn: name.noLn };
    const at = (siblings ?? []).findIndex((s) => s && s.text !== text && isOriginalOf(s.text, text, name));
    if (at >= 0) {
        return { ...out, evidence: "original", sibling: at, virtual: false, text: transformOsu(siblings[at].text, { mirror: name.mirror, noLn: name.noLn }) };
    }
    const tags = tagsOf(text);
    const tagged = tags.includes(RATE_TAG) || tags.includes(OSU_TRAINER_TAG);
    const bpmMatch = name.bpm !== null && ownBpms(text).some((bpm) => Math.abs(bpm - name.bpm) <= BPM_SLACK);
    if (!tagged && !bpmMatch) return null;
    return { ...out, evidence: tagged ? "tag" : "bpm", sibling: null, virtual: true, text: originalFromRateMap(text, name) };
}
