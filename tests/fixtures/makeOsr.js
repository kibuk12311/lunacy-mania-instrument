// Synthetic osu! replays for tests and the smoke, with a made-up player: a real .osr layout around frames this file writes,
// packed by a small LZMA encoder (literals only: valid LZMA, no matches; the decoder's matches are tested on
// tests/fixtures/lzmaSample.js). Nothing here comes from a real replay.
const TICKS_AT_EPOCH = 621355968000000000n;

// ---- the range encoder of the LZMA SDK, literals only ----
function lzmaLiterals(bytes) {
    const lc = 3;
    const props = lc; // lp 0, pb 0
    const probs = new Uint16Array(0x300 << lc).fill(1024);
    const isMatch = new Uint16Array(12 << 4).fill(1024);
    const out = [];
    let low = 0n;
    let range = 0xffffffff;
    let cache = 0;
    let cacheSize = 1;
    const shiftLow = () => {
        if (low < 0xff000000n || low >= 0x100000000n) {
            const carry = Number(low >> 32n);
            let c = cache;
            do {
                out.push((c + carry) & 0xff);
                c = 0xff;
                cacheSize -= 1;
            } while (cacheSize !== 0);
            cache = Number((low >> 24n) & 0xffn);
        }
        cacheSize += 1;
        low = (low & 0x00ffffffn) << 8n;
    };
    const encodeBit = (p, i, bit) => {
        const v = p[i];
        const bound = (range >>> 11) * v;
        if (bit === 0) {
            range = bound;
            p[i] = v + ((2048 - v) >>> 5);
        } else {
            low += BigInt(bound);
            range = (range - bound) >>> 0;
            p[i] = v - (v >>> 5);
        }
        while (range < 2 ** 24) {
            range = (range * 256) >>> 0;
            shiftLow();
        }
    };
    let prev = 0;
    for (const byte of bytes) {
        encodeBit(isMatch, 0, 0); // state 0 after literals, one position state
        const base = 0x300 * (prev >> (8 - lc));
        let symbol = 1;
        for (let i = 7; i >= 0; i -= 1) {
            const bit = (byte >> i) & 1;
            encodeBit(probs, base + symbol, bit);
            symbol = (symbol << 1) | bit;
        }
        prev = byte;
    }
    for (let i = 0; i < 5; i += 1) shiftLow();
    const head = Buffer.alloc(13);
    head[0] = props;
    head.writeUInt32LE(1 << 16, 1);
    head.writeBigUInt64LE(BigInt(bytes.length), 5);
    return Buffer.concat([head, Buffer.from(out)]);
}

const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
function str(s) {
    if (s === null || s === undefined) return u8(0);
    const bytes = Buffer.from(String(s), "utf8");
    const len = [];
    let n = bytes.length;
    do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n) b |= 0x80;
        len.push(b);
    } while (n);
    return Buffer.concat([Buffer.from([0x0b, ...len]), bytes]);
}

// Key presses [{ t, col, up }] → the frames' text as osu! writes it: two blank frames, a frame at every key change, the
// seed frame.
export function framesText(presses, keys = 4) {
    const changes = [];
    for (const p of presses) {
        changes.push({ t: p.t, col: p.col, down: true });
        changes.push({ t: p.up ?? p.t + 40, col: p.col, down: false });
    }
    changes.sort((a, b) => a.t - b.t || (a.down ? 1 : -1));
    const lines = ["0|256|-500|0", "-1|256|-500|0"];
    let clock = -1;
    let mask = 0;
    let i = 0;
    while (i < changes.length) {
        const t = changes[i].t;
        for (; i < changes.length && changes[i].t === t; i += 1) {
            if (changes[i].down) mask |= 1 << changes[i].col;
            else mask &= ~(1 << changes[i].col);
        }
        lines.push(`${t - clock}|${mask & ((1 << keys) - 1)}|0|0`);
        clock = t;
    }
    lines.push("-12345|0|0|4242");
    return `${lines.join(",")},`;
}

// A whole .osr. counts: { max, n300, n200, n100, n50, miss }; presses as in framesText, or text: the frames' text.
export function makeOsr({
    md5, player = "TestPlayer", mode = 3, version = 20260924, counts = {}, score = 1000000, maxCombo = 0, perfect = false,
    mods = 0, at = Date.UTC(2026, 9, 1, 12), presses = [], text = null, keys = 4, onlineId = 0,
}) {
    const data = lzmaLiterals(Buffer.from(text ?? framesText(presses, keys), "latin1"));
    const c = { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0, ...counts };
    return Buffer.concat([
        u8(mode), i32(version), str(md5), str(player), str("0".repeat(32)),
        u16(c.n300), u16(c.n100), u16(c.n50), u16(c.max), u16(c.n200), u16(c.miss),
        i32(score), u16(maxCombo), u8(perfect ? 1 : 0), i32(mods), str(""),
        i64(BigInt(at) * 10000n + TICKS_AT_EPOCH), i32(data.length), data, i64(onlineId),
    ]);
}

// ---- synthetic plays ----

// Small seeded generator for play noise.
export function noise(seed = 1) {
    let s = seed >>> 0;
    const next = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
    // normal by Box–Muller
    return (sd) => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next()) * sd;
}

// A play of the notes [{ t, col, end }] within one judged window of perfect: every note pressed at its time + a normal
// error of sdMs, whole ms.
export function honestPresses(notes, { sdMs = 10, seed = 1 } = {}) {
    const gauss = noise(seed);
    return notes.map((n) => {
        const t = Math.round(n.t + gauss(sdMs));
        return { t, col: n.col, up: n.end ?? t + 30 };
    });
}

// A roll played as jumps: each two notes of a hand in a row (different columns) pressed at the same moment.
export function gluedPresses(notes, { sdMs = 4, seed = 2 } = {}) {
    const gauss = noise(seed);
    const out = [];
    for (const hand of [[0, 1], [2, 3]]) {
        const own = notes.filter((n) => hand.includes(n.col));
        for (let i = 0; i < own.length; i += 2) {
            const a = own[i];
            const b = own[i + 1];
            if (!b) {
                out.push({ t: a.t, col: a.col, up: a.t + 30 });
                continue;
            }
            const t = Math.round((a.t + b.t) / 2 + gauss(sdMs));
            out.push({ t, col: a.col, up: t + 30 }, { t: t + (b.col === a.col ? 1 : 0), col: b.col, up: t + 30 });
        }
    }
    return out.sort((x, y) => x.t - y.t);
}

// A 4K roll: 1 2 3 4 1 2 3 4 … every stepMs (ms of the map) from startMs.
export function rollNotes({ count = 400, stepMs = 50, startMs = 1000 } = {}) {
    return Array.from({ length: count }, (_, i) => ({ t: startMs + i * stepMs, col: i % 4, end: null }));
}

// The .osu text of notes (hit objects only and what the app reads), with its metadata.
export function chartText(notes, { od = 8, title = "Fixture Roll", artist = "Test", version = "Rolls", audio = "audio.wav", bpm = 150 } = {}) {
    const x = (c) => Math.floor(((c + 0.5) * 512) / 4);
    return [
        "osu file format v14", "", "[General]", `AudioFilename: ${audio}`, "Mode: 3", "", "[Metadata]", `Title:${title}`, `TitleUnicode:${title}`, `Artist:${artist}`,
        `ArtistUnicode:${artist}`, "Creator:TestPlayer", `Version:${version}`, "BeatmapID:1", "BeatmapSetID:1", "",
        "[Difficulty]", "HPDrainRate:8", "CircleSize:4", `OverallDifficulty:${od}`, "ApproachRate:5", "SliderMultiplier:1", "SliderTickRate:1", "",
        "[TimingPoints]", `0,${60000 / bpm},4,1,0,100,1,0`, "", "[HitObjects]",
        ...notes.map((n) => (n.end === null ? `${x(n.col)},192,${n.t},1,0,0:0:0:0:` : `${x(n.col)},192,${n.t},128,0,${n.end}:0:0:0:0:`)), "",
    ].join("\r\n");
}
