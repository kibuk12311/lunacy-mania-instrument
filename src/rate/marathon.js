// Marathon (dan-course style): map, gap, map, gap … in one chart. Each map is cut to its notes (plus a lead-in and a
// tail), played at its own rate, and starts on its own red line so its beat grid stays exact; gaps become breaks.
import { rateText } from "./rateMap.js";
import { t } from "../i18n/i18n.js";

const BREAK_MIN_MS = 650; // osu! ignores shorter breaks
const LEAD_MS = 2000;
const TAIL_MS = 1000;

const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
const fmt = (x) => String(Number(x.toFixed(12)));

function sectionLines(text, name) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === `[${name}]`);
    const out = [];
    for (let i = start + 1; start >= 0 && i < lines.length && !lines[i].startsWith("["); i += 1) {
        if (lines[i].trim() && !lines[i].startsWith("//")) out.push(lines[i]);
    }
    return out;
}

function parse(osuText) {
    const notes = sectionLines(osuText, "HitObjects").map((line) => {
        const p = line.split(",");
        const hold = Number(p[3]) & 128;
        return { p, t: Number(p[2]), end: hold ? Number(p[5].split(":")[0]) : null };
    }).filter((n) => Number.isFinite(n.t));
    const points = sectionLines(osuText, "TimingPoints").map((line) => {
        const p = line.split(",");
        return { p, t: Number(p[0]), beat: Number(p[1]), red: Number(p[1]) > 0 && (p[6] === undefined || p[6].trim() === "1") };
    }).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
    return {
        notes, points,
        meta: { artist: field(osuText, "Artist"), title: field(osuText, "Title"), version: field(osuText, "Version") },
    };
}

// The part of a chart a marathon keeps: from leadMs before its first note to tailMs after its last note ends
// (never before 0). notes: [{ t, end }]; null without notes.
function rangeOf(notes, leadMs, tailMs) {
    if (!notes.length) return null;
    const first = Math.min(...notes.map((n) => n.t));
    const last = Math.max(...notes.map((n) => n.end ?? n.t));
    const srcStartMs = Math.max(0, first - leadMs);
    const srcEndMs = last + tailMs;
    return { srcStartMs, srcEndMs, cutMs: srcEndMs - srcStartMs };
}

// The cut buildMarathon makes of one chart, in the chart's own ms: { srcStartMs, srcEndMs, cutMs } or null.
export function cutRange(osuText, { leadMs = LEAD_MS, tailMs = TAIL_MS } = {}) {
    return rangeOf(parse(String(osuText ?? "")).notes, leadMs, tailMs);
}

export function buildMarathon(entries, {
    gapMs = 10000, leadMs = LEAD_MS, tailMs = TAIL_MS, title = "Marathon", audioFilename = "audio.mp3",
    background = null, od = null, hp = null,
} = {}) {
    const segments = [];
    const timing = [];
    const objects = [];
    const breaks = [];
    const list = [];
    let cursor = 0;

    entries.forEach(({ osuText, rate }, index) => {
        const { notes, points, meta } = parse(osuText);
        const range = rangeOf(notes, leadMs, tailMs);
        if (!range) throw new Error(t("app.marathon.noNotes", { title: meta.title }));
        const { srcStartMs, srcEndMs } = range;
        const outStartMs = index === 0 ? 0 : cursor + gapMs;
        const outEndMs = outStartMs + Math.round((srcEndMs - srcStartMs) / rate);
        const out = (t) => outStartMs + Math.round((t - srcStartMs) / rate);
        if (index > 0 && gapMs >= BREAK_MIN_MS) breaks.push(`2,${cursor},${outStartMs}`);
        segments.push({ index, srcStartMs, srcEndMs, rate, outStartMs, outEndMs });

        // the red line in effect at the cut, moved to its first beat inside the cut
        const reds = points.filter((x) => x.red);
        const active = [...reds].reverse().find((x) => x.t <= srcStartMs) ?? reds[0];
        if (active) {
            const firstBeat = active.t + Math.ceil((srcStartMs - active.t) / active.beat - 1e-9) * active.beat;
            timing.push({ t: out(firstBeat), line: [out(firstBeat), fmt(active.beat / rate), ...active.p.slice(2)].join(",") });
        }
        for (const x of points) {
            if (x === active || x.t < srcStartMs || x.t > srcEndMs) continue;
            const beat = x.red ? fmt(x.beat / rate) : x.p[1];
            timing.push({ t: out(x.t), line: [out(x.t), beat, ...x.p.slice(2)].join(",") });
        }

        for (const n of notes) {
            const p = [...n.p];
            p[2] = String(out(n.t));
            if (n.end !== null) {
                const extra = p[5].split(":");
                extra[0] = String(out(n.end));
                p[5] = extra.join(":");
            }
            objects.push({ t: out(n.t), line: p.join(",") });
        }
        list.push({ ...meta, rate, label: `${meta.artist} - ${meta.title} [${meta.version}]${rate !== 1 ? ` ${rateText(rate)}x` : ""}` });
        cursor = outEndMs;
    });

    timing.sort((a, b) => a.t - b.t);
    objects.sort((a, b) => a.t - b.t);
    const osuText = [
        "osu file format v14", "",
        "[General]", `AudioFilename: ${audioFilename}`, "AudioLeadIn: 0", "PreviewTime: 0", "Countdown: 0", "SampleSet: Soft",
        "StackLeniency: 0.7", "Mode: 3", "LetterboxInBreaks: 0", "SpecialStyle: 0", "WidescreenStoryboard: 0", "",
        "[Editor]", "DistanceSpacing: 1", "BeatDivisor: 4", "GridSize: 4", "",
        "[Metadata]", `Title:${title}`, `TitleUnicode:${title}`, "Artist:Various Artists", "ArtistUnicode:Various Artists",
        "Creator:Lunacy mania", `Version:${title}`, "Source:", "Tags:lunacy-mania-marathon", "BeatmapID:0", "BeatmapSetID:-1", "",
        "[Difficulty]", `HPDrainRate:${hp ?? 8}`, "CircleSize:4", `OverallDifficulty:${od ?? 8}`, "ApproachRate:5",
        "SliderMultiplier:1.4", "SliderTickRate:1", "",
        "[Events]", "//Background and Video events", ...(background ? [`0,0,"${background}",0,0`] : []), "//Break Periods", ...breaks, "",
        "[TimingPoints]", ...timing.map((x) => x.line), "",
        "[HitObjects]", ...objects.map((x) => x.line), "",
    ].join("\r\n");
    return { osuText, segments, list, totalMs: cursor };
}
