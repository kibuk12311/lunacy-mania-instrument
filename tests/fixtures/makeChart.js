// Generates synthetic osu!mania .osu text for tests (no copyrighted maps).

const PATTERNS = {
    stream: [[0], [2], [1], [3], [0], [3], [1], [2]],
    jack: [[0, 1], [0, 1], [2, 3], [2, 3], [0, 2], [0, 2], [1, 3], [1, 3]],
    jumpstream: [[0, 2], [1], [0, 3], [2], [1, 3], [0], [1, 2], [3]],
    ln: [[0], [2], [1], [3], [0], [3], [1], [2]],
};

function columnX(column, keys) {
    return Math.floor(((column + 0.5) * 512) / keys);
}

export function makeChart({ kind = "stream", bpm = 180, seconds = 60, keys = 4, lnShare = 0 } = {}) {
    const beatMs = 60000 / bpm;
    const stepMs = beatMs / 4;
    const start = 1000;
    const count = Math.max(1, Math.floor((seconds * 1000) / stepMs));
    const rows = PATTERNS[kind] ?? PATTERNS.stream;
    const share = kind === "ln" && lnShare === 0 ? 0.6 : lnShare;

    const objects = [];
    let lnCounter = 0;
    for (let i = 0; i < count; i += 1) {
        const time = Math.round(start + i * stepMs);
        for (const rawColumn of rows[i % rows.length]) {
            const column = rawColumn % keys;
            const x = columnX(column, keys);
            lnCounter += share;
            if (lnCounter >= 1) {
                lnCounter -= 1;
                const end = Math.round(time + stepMs * 3);
                objects.push(`${x},192,${time},128,0,${end}:0:0:0:0:`);
            } else {
                objects.push(`${x},192,${time},1,0,0:0:0:0:`);
            }
        }
    }

    return [
        "osu file format v14",
        "",
        "[General]",
        "AudioFilename: audio.mp3",
        "Mode: 3",
        "",
        "[Metadata]",
        `Title:Synthetic ${kind}`,
        "Artist:Test",
        "Creator:Test",
        `Version:${kind} ${bpm}`,
        "",
        "[Difficulty]",
        "HPDrainRate:8",
        `CircleSize:${keys}`,
        "OverallDifficulty:8",
        "ApproachRate:5",
        "SliderMultiplier:1",
        "SliderTickRate:1",
        "",
        "[TimingPoints]",
        `0,${beatMs},4,1,0,100,1,0`,
        "",
        "[HitObjects]",
        ...objects,
        "",
    ].join("\r\n");
}
