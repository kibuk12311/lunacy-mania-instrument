// Seeded irregular 4K charts (no copyrighted maps): uneven snaps, chords, jacks, a few LNs, BPM changes, breaks
// and any OD, so an exact-equality check reaches more of the estimators' branches than the regular makeChart.

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];

function columnX(column, keys) {
    return Math.floor(((column + 0.5) * 512) / keys);
}

// seconds: rough length; lnShare: share of notes that are LNs (4K rice stops at 15%).
export function randomChart(seed, { seconds = 90, keys = 4, lnShare = null } = {}) {
    const rand = mulberry32(seed);
    const od = Math.round((4 + rand() * 6) * 10) / 10;
    const ln = lnShare ?? (rand() < 0.5 ? 0 : rand() * 0.12);
    const chordWeights = pick(rand, [[6, 3, 1, 0], [3, 4, 2, 1], [1, 3, 4, 2], [8, 2, 0, 0]]);
    const jackChance = pick(rand, [0, 0.05, 0.2, 0.45]);
    const divisors = pick(rand, [[4], [4, 4, 2], [4, 3, 6], [2, 4, 8], [3, 6]]);

    const sections = [];
    let time = Math.round(rand() * 2500);
    const end = time + seconds * 1000;
    while (time < end) {
        const bpm = 100 + Math.round(rand() * 180);
        sections.push({ time, beat: 60000 / bpm });
        time += 15000 + Math.round(rand() * 45000);
    }

    const busyUntil = new Array(keys).fill(-Infinity);
    let previous = [];
    const objects = [];
    let s = 0;
    time = sections[0].time + 200;
    while (time < end) {
        while (s + 1 < sections.length && sections[s + 1].time <= time) s += 1;
        const beat = sections[s].beat;
        const size = 1 + weighted(rand, chordWeights);
        const columns = chooseColumns(rand, keys, size, previous, jackChance);
        const step = beat / pick(rand, divisors);
        const placed = [];
        for (const c of columns) {
            if (busyUntil[c] >= time) continue;
            const x = columnX(c, keys);
            const t = Math.round(time);
            if (rand() < ln) {
                const tail = Math.round(time + step * (1 + Math.floor(rand() * 4)));
                busyUntil[c] = tail + 1;
                objects.push(`${x},192,${t},128,0,${tail}:0:0:0:0:`);
            } else {
                busyUntil[c] = t;
                objects.push(`${x},192,${t},1,0,0:0:0:0:`);
            }
            placed.push(c);
        }
        if (placed.length) previous = placed;
        time += rand() < 0.01 ? 2000 + rand() * 3000 : step;
    }

    const timing = sections.map((p) => `${p.time},${p.beat},4,1,0,100,1,0`);
    return [
        "osu file format v14",
        "",
        "[General]",
        "AudioFilename: audio.mp3",
        "Mode: 3",
        "",
        "[Metadata]",
        `Title:Random ${seed}`,
        "Artist:Test",
        "Creator:TestPlayer",
        `Version:Random ${seed}`,
        "",
        "[Difficulty]",
        "HPDrainRate:8",
        `CircleSize:${keys}`,
        `OverallDifficulty:${od}`,
        "ApproachRate:5",
        "SliderMultiplier:1",
        "SliderTickRate:1",
        "",
        "[TimingPoints]",
        ...timing,
        "",
        "[HitObjects]",
        ...objects,
        "",
    ].join("\r\n");
}

function weighted(rand, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    for (let i = 0; i < weights.length; i += 1) {
        r -= weights[i];
        if (r < 0) return i;
    }
    return weights.length - 1;
}

function chooseColumns(rand, keys, size, previous, jackChance) {
    const chosen = new Set();
    for (const c of previous) {
        if (chosen.size < size && rand() < jackChance) chosen.add(c);
    }
    const free = [...Array(keys).keys()].filter((c) => !chosen.has(c) && !previous.includes(c));
    while (chosen.size < size && free.length) chosen.add(free.splice(Math.floor(rand() * free.length), 1)[0]);
    const rest = [...Array(keys).keys()].filter((c) => !chosen.has(c));
    while (chosen.size < size && rest.length) chosen.add(rest.splice(Math.floor(rand() * rest.length), 1)[0]);
    return [...chosen].sort((a, b) => a - b);
}
