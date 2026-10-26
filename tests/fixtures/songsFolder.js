// A fake osu! stable Songs folder in a temp directory for tests: set folders "<id> <artist> - <title>" with synthetic
// .osu files (tests/fixtures/makeChart.js) — 4K mania ones, and the kinds the session library must leave out: 7K
// mania, osu!standard, a rate copy and a marathon the app made. Nothing here is a real map or a real osu! folder.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeChart } from "./makeChart.js";

// osuText with its metadata lines set (Title, Artist, Version, Creator, BeatmapID, BeatmapSetID, Tags).
export function withMeta(osuText, meta) {
    let text = osuText;
    for (const [k, v] of Object.entries(meta)) {
        const line = `${k}:${v}`;
        text = new RegExp(`^${k}:.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}:.*$`, "m"), line) : text.replace(/^\[Metadata\]\r?$/m, `[Metadata]\r\n${line}`);
    }
    return text;
}

export const standardChart = () => [
    "osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "", "[Metadata]", "Title:Circles", "Artist:Test",
    "Creator:Test", "Version:Normal", "", "[Difficulty]", "CircleSize:4", "OverallDifficulty:5", "", "[HitObjects]", "256,192,1000,1,0,0:0:0:0:", "",
].join("\r\n");

// sets: [{ id, artist, title, charts: [{ file, text }] }] → the folder's path; the default is a small library.
export async function makeSongsFolder(sets = defaultSets()) {
    const root = await mkdtemp(path.join(tmpdir(), "songs-"));
    for (const set of sets) {
        const dir = path.join(root, `${set.id} ${set.artist} - ${set.title}`);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "audio.mp3"), Buffer.alloc(16));
        for (const c of set.charts) await writeFile(path.join(dir, c.file), c.text, "utf8");
    }
    // a stray file at the top is no set
    await writeFile(path.join(root, "desktop.ini"), "");
    return root;
}

const chart = (kind, bpm, seconds, meta, extra = {}) => withMeta(makeChart({ kind, bpm, seconds, ...extra }), meta);

export function defaultSets() {
    return [
        {
            id: 101, artist: "Alpha", title: "First Song",
            charts: [
                { file: "Alpha - First Song (M) [Easy].osu", text: chart("stream", 150, 90, { Title: "First Song", Artist: "Alpha", Version: "Easy", BeatmapID: 1001, BeatmapSetID: 101 }) },
                { file: "Alpha - First Song (M) [Hard].osu", text: chart("jumpstream", 180, 120, { Title: "First Song", Artist: "Alpha", Version: "Hard", BeatmapID: 1002, BeatmapSetID: 101 }) },
                { file: "Alpha - First Song (M) [7K].osu", text: chart("stream", 180, 60, { Title: "First Song", Artist: "Alpha", Version: "7K", BeatmapID: 1003, BeatmapSetID: 101 }, { keys: 7 }) },
                { file: "Alpha - First Song (M) [Hard 1.1x (198bpm)].osu", text: chart("jumpstream", 198, 110, { Title: "First Song", Artist: "Alpha", Version: "Hard 1.1x (198bpm)", Tags: "lunacy-mania-rate" }) },
            ],
        },
        {
            id: 102, artist: "Beta", title: "Second Song",
            charts: [
                { file: "Beta - Second Song (M) [Jacks].osu", text: chart("jack", 160, 100, { Title: "Second Song", Artist: "Beta", Version: "Jacks", BeatmapID: 1004, BeatmapSetID: 102 }) },
                { file: "Beta - Second Song (M) [Normal].osu", text: standardChart() },
            ],
        },
        {
            id: 103, artist: "Gamma", title: "Third Song",
            charts: [
                { file: "Gamma - Third Song (M) [LN].osu", text: chart("ln", 170, 90, { Title: "Third Song", Artist: "Gamma", Version: "LN", BeatmapID: 1005, BeatmapSetID: 103 }) },
                { file: "Gamma - Third Song (M) [Stream].osu", text: chart("stream", 200, 150, { Title: "Third Song", Artist: "Gamma", Version: "Stream", BeatmapID: 1006, BeatmapSetID: 103 }) },
            ],
        },
    ];
}
