// Rate-changed copy of an .osu (like osu-trainer): every timestamp ÷ rate, red beat lengths ÷ rate,
// SV (green lines) untouched, new difficulty name, its own audio file, optional OD/HP.

export const RATE_TAG = "lunacy-mania-rate";

export const rateText = (rate) => String(Number(rate.toFixed(2)));
const scale = (t, rate) => Math.round(Number(t) / rate);
const fmt = (x) => String(Number(x.toFixed(12)));

export function rateVersionName(version, rate, bpm) {
    return `${version} ${rateText(rate)}x (${Math.round(bpm * rate)}bpm)`;
}

export function firstRedBpm(lines) {
    const start = lines.findIndex((l) => l.trim() === "[TimingPoints]");
    for (let i = start + 1; start >= 0 && i < lines.length && !lines[i].startsWith("["); i += 1) {
        const p = lines[i].split(",");
        const beat = Number(p[1]);
        if (p.length > 1 && beat > 0 && (p[6] === undefined || p[6].trim() === "1")) return 60000 / beat;
    }
    return 0;
}

function hitObject(line, rate) {
    const p = line.split(",");
    if (p.length < 5) return line;
    p[2] = String(scale(p[2], rate));
    const type = Number(p[3]);
    if (type & 128 && p[5] !== undefined) {
        // mania hold: "endTime:hitSample"
        const extra = p[5].split(":");
        extra[0] = String(scale(extra[0], rate));
        p[5] = extra.join(":");
    } else if (type & 8 && p[5] !== undefined) {
        p[5] = String(scale(p[5], rate)); // spinner end
    }
    return p.join(",");
}

function timingPoint(line, rate) {
    const p = line.split(",");
    if (p.length < 2) return line;
    p[0] = String(scale(p[0], rate));
    const beat = Number(p[1]);
    if (beat > 0) p[1] = fmt(beat / rate);
    return p.join(",");
}

function event(line, rate) {
    const p = line.split(",");
    if (p[0] === "2" || p[0] === "Break") return [p[0], scale(p[1], rate), scale(p[2], rate), ...p.slice(3)].join(",");
    if (p[0] === "1" || p[0] === "Video") return [p[0], scale(p[1], rate), ...p.slice(2)].join(",");
    return line;
}

export function rateOsu(osuText, { rate, audioFilename, od = null, hp = null, versionSuffix = "" }) {
    const lines = osuText.split(/\r?\n/);
    const bpm = firstRedBpm(lines);
    let section = "";
    const out = lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            section = trimmed.slice(1, -1);
            return line;
        }
        if (!trimmed || trimmed.startsWith("//")) return line;
        const key = line.slice(0, line.indexOf(":")).trim();
        const value = line.slice(line.indexOf(":") + 1).trim();
        switch (section) {
            case "General":
                if (key === "AudioFilename") return `AudioFilename: ${audioFilename}`;
                if (key === "PreviewTime" && Number(value) >= 0) return `PreviewTime: ${scale(value, rate)}`;
                return line;
            case "Editor":
                if (key === "Bookmarks" && value) return `Bookmarks: ${value.split(",").map((t) => scale(t, rate)).join(",")}`;
                return line;
            case "Metadata":
                if (key === "Version") return `Version:${rateVersionName(value, rate, bpm)}${versionSuffix}`;
                if (key === "Tags") return `Tags:${value ? `${value} ` : ""}${RATE_TAG}`;
                if (key === "BeatmapID") return "BeatmapID:0";
                return line;
            case "Difficulty":
                if (key === "OverallDifficulty" && od !== null) return `OverallDifficulty:${od}`;
                if (key === "HPDrainRate" && hp !== null) return `HPDrainRate:${hp}`;
                return line;
            case "Events": return event(line, rate);
            case "TimingPoints": return timingPoint(line, rate);
            case "HitObjects": return hitObject(line, rate);
            default: return line;
        }
    });
    return out.join("\r\n");
}
