// A rate-changed difficulty written into the beatmap's own folder, with its own audio (made once per rate).
// Mirror and no-LN change the chart first; at 1.0 without nightcore the map's own audio is used as it is.
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { rateOsu, rateVersionName, rateText, firstRedBpm } from "../src/rate/rateMap.js";
import { transformOsu, transformSuffix } from "../src/rate/chartTransform.js";
import { renderRateAudio } from "./rateAudio.js";
import { safeFileName } from "./mapExport.js";

const exists = (p) => access(p).then(() => true, () => false);
const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";

export function mapInfo(osuText) {
    return {
        title: field(osuText, "Title"),
        artist: field(osuText, "Artist"),
        creator: field(osuText, "Creator"),
        version: field(osuText, "Version"),
        audioFilename: field(osuText, "AudioFilename"),
        bpm: Math.round(firstRedBpm(osuText.split(/\r?\n/)) * 100) / 100,
        od: Number(field(osuText, "OverallDifficulty")),
        hp: Number(field(osuText, "HPDrainRate")),
    };
}

// osuText: the map's text when the caller has read it already (a batch reads it once).
export async function createRateMap({ ffmpeg, beatmapPath, rate, pitch, od = null, hp = null, mirror = false, noLn = false, osuText = null }) {
    const text = osuText ?? await readFile(beatmapPath, "utf8");
    const info = mapInfo(text);
    const dir = path.dirname(beatmapPath);
    const audioIn = path.join(dir, info.audioFilename);
    const ownAudio = rate === 1 && !pitch;
    const base = path.parse(info.audioFilename).name;
    const audioName = ownAudio ? info.audioFilename : safeFileName(`${base} ${rateText(rate)}x${pitch ? " nc" : ""}`) + ".mp3";
    const audioPath = path.join(dir, audioName);

    const reusedAudio = ownAudio || await exists(audioPath);
    if (!reusedAudio) await renderRateAudio({ ffmpeg, input: audioIn, output: audioPath, rate, pitch });

    const versionSuffix = transformSuffix({ pitch, mirror, noLn });
    const version = rateVersionName(info.version, rate, info.bpm) + versionSuffix;
    const outText = rateOsu(transformOsu(text, { mirror, noLn }), { rate, audioFilename: audioName, od, hp, versionSuffix });
    const osuPath = path.join(dir, safeFileName(`${info.artist} - ${info.title} (${info.creator}) [${version}]`) + ".osu");
    await writeFile(osuPath, outText, "utf8");
    return { osuPath, audioPath, version, reusedAudio, osuText: outText };
}
