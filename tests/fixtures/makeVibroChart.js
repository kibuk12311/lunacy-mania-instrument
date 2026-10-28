// Synthetic 4K .osu texts for the vibro tests (no copyrighted maps): a chart from rows, and the pieces the tests put
// together, each returning rows [time ms, [columns]] from a start time.

const X = [64, 192, 320, 448]; // the middle of each of the 4 columns

// rows [[t, [cols]]] → .osu text (Mode 3, CircleSize keys)
export function chartOf(rows, { keys = 4, mode = 3, title = "Synthetic vibro" } = {}) {
    const objects = [];
    for (const [t, cols] of rows) for (const c of cols) objects.push(`${X[c]},192,${Math.round(t)},1,0,0:0:0:0:`);
    return [
        "osu file format v14", "", "[General]", "AudioFilename: audio.mp3", `Mode: ${mode}`, "",
        "[Metadata]", `Title:${title}`, "Artist:Test", "Creator:TestPlayer", "Version:vibro", "",
        "[Difficulty]", "HPDrainRate:8", `CircleSize:${keys}`, "OverallDifficulty:8", "ApproachRate:5", "",
        "[TimingPoints]", "0,500,4,1,0,100,1,0", "", "[HitObjects]", ...objects, "",
    ].join("\r\n");
}

// a roll 1-3-2-4 at gapMs: no two rows in a row share a column (no jack at all)
export const stream = (start, n, gapMs) => Array.from({ length: n }, (_, i) => [start + i * gapMs, [[0, 2, 1, 3][i % 4]]]);
// the same columns n times at gapMs: a jack (one column), a jumpjack (two), a quad jack (four)
export const jack = (start, n, gapMs, cols = [0]) => Array.from({ length: n }, (_, i) => [start + i * gapMs, cols]);
// chords that move every row ([12][23][34][41]): each shares one of its two notes with the row before
export const chordjack = (start, n, gapMs) => Array.from({ length: n }, (_, i) => [start + i * gapMs, [i % 4, (i + 1) % 4]]);
// the end of a piece of rows, for the next one to start after a pause
export const after = (rows, pauseMs = 500) => rows.at(-1)[0] + pauseMs;
