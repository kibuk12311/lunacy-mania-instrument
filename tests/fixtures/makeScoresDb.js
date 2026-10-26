// A synthetic osu! stable scores.db (the legacy format src/localProfile/scoresDb.js reads), for tests only.
// scores: [{ md5, player, replayMd5, mode, n300, n100, n50, geki, katu, miss, score, maxCombo, perfect, mods, at (ms),
// onlineId, tpInfo }]; grouped by md5 like osu! writes them.
const TICKS_AT_EPOCH = 621355968000000000n;

function str(s) {
    if (s === null || s === undefined) return Buffer.from([0]);
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

const i8 = (v) => Buffer.from([v & 0xff]);
const i16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const f64 = (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };

export function makeScoresDb(scores, { version = 20240101 } = {}) {
    const groups = new Map();
    for (const s of scores) {
        if (!groups.has(s.md5)) groups.set(s.md5, []);
        groups.get(s.md5).push(s);
    }
    const parts = [i32(version), i32(groups.size)];
    for (const [md5, list] of groups) {
        parts.push(str(md5), i32(list.length));
        for (const s of list) {
            const mods = (s.mods ?? 0) >>> 0;
            parts.push(
                i8(s.mode ?? 3), i32(version), str(md5), str(s.player ?? "TestPlayer"), str(s.replayMd5 ?? null),
                i16(s.n300 ?? 0), i16(s.n100 ?? 0), i16(s.n50 ?? 0), i16(s.geki ?? 0), i16(s.katu ?? 0), i16(s.miss ?? 0),
                i32(s.score ?? 0), i16(s.maxCombo ?? 0), i8(s.perfect ? 1 : 0), i32(mods), str(""),
                i64(BigInt(s.at ?? 0) * 10000n + TICKS_AT_EPOCH), i32(-1), i64(s.onlineId ?? 0),
            );
            if (mods & (1 << 23)) parts.push(f64(s.tpInfo ?? 0));
        }
    }
    return Buffer.concat(parts);
}
