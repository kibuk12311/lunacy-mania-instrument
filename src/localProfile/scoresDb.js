// osu! stable's local score file, scores.db (next to osu!.exe), read only — the documented legacy format
// (osu.ppy.sh/wiki/Client/File_formats/osu!.db, "scores.db"):
//   Int version, Int beatmap count, then per beatmap: String md5, Int score count, the scores;
//   a score: Byte mode, Int version, String beatmap md5, String player name, String replay md5,
//            Short 300, 100, 50, geki, katu, miss, Int score, Short max combo, Bool perfect, Int mods,
//            String (empty: the life bar), Long timestamp (Windows ticks), Int −1, Long online score id,
//            Double extra mod info only when Target Practice (1 << 23) is on.
// Strings are 0x00 (none) or 0x0b, a ULEB128 length and UTF-8. In osu!mania geki = MAX (320) and katu = 200.
// osu! keeps only passed plays here (a failed or quit play is never saved locally).

const TICKS_AT_EPOCH = 621355968000000000n; // .NET ticks at 1970-01-01
const TARGET_PRACTICE = 1 << 23;

export const MOD_BITS = {
    NF: 1, EZ: 2, TD: 4, HD: 8, HR: 16, SD: 32, DT: 64, RX: 128, HT: 256, NC: 512, FL: 1024, AT: 2048, SO: 4096,
    AP: 8192, PF: 16384, FI: 1 << 20, RD: 1 << 21, CN: 1 << 22, TP: 1 << 23, CP: 1 << 25, V2: 1 << 29, MR: 1 << 30,
};

// The mods' bits → acronyms (NC without its DT bit, PF without SD).
export function modNames(bits) {
    const n = Number(bits) >>> 0;
    const out = [];
    for (const [name, bit] of Object.entries(MOD_BITS)) if (n & bit) out.push(name);
    const drop = new Set([...(out.includes("NC") ? ["DT"] : []), ...(out.includes("PF") ? ["SD"] : [])]);
    return out.filter((m) => !drop.has(m));
}

// DT / NC 1.5, HT 0.75, else 1.
export function rateOfMods(names) {
    if (names.includes("DT") || names.includes("NC")) return 1.5;
    if (names.includes("HT")) return 0.75;
    return 1;
}

export const ticksToMs = (ticks) => Number((BigInt(ticks) - TICKS_AT_EPOCH) / 10000n);

class Reader {
    constructor(buf) {
        this.buf = buf;
        this.at = 0;
    }
    need(n) {
        if (this.at + n > this.buf.length) throw new Error("scores.db ends too early");
    }
    u8() { this.need(1); return this.buf[this.at++]; }
    bool() { return this.u8() !== 0; }
    i16() { this.need(2); const v = this.buf.readUInt16LE(this.at); this.at += 2; return v; }
    i32() { this.need(4); const v = this.buf.readInt32LE(this.at); this.at += 4; return v; }
    i64() { this.need(8); const v = this.buf.readBigInt64LE(this.at); this.at += 8; return v; }
    f64() { this.need(8); const v = this.buf.readDoubleLE(this.at); this.at += 8; return v; }
    uleb() {
        let result = 0;
        let shift = 0;
        for (;;) {
            const b = this.u8();
            result += (b & 0x7f) * 2 ** shift;
            if (!(b & 0x80)) return result;
            shift += 7;
            if (shift > 35) throw new Error("bad string length in scores.db");
        }
    }
    str() {
        const flag = this.u8();
        if (flag === 0x00) return null;
        if (flag !== 0x0b) throw new Error("bad string in scores.db");
        const len = this.uleb();
        this.need(len);
        const s = this.buf.toString("utf8", this.at, this.at + len);
        this.at += len;
        return s;
    }
}

// scores.db bytes → { version, beatmaps, scores: [...] }; mode: only scores of that mode (3 = mania; null: all).
export function parseScoresDb(bytes, { mode = 3 } = {}) {
    const r = new Reader(Buffer.from(bytes));
    const version = r.i32();
    const beatmaps = r.i32();
    if (beatmaps < 0 || beatmaps > 10_000_000) throw new Error("bad scores.db");
    const scores = [];
    for (let b = 0; b < beatmaps; b += 1) {
        r.str(); // the beatmap's md5, repeated in each score
        const count = r.i32();
        if (count < 0 || count > 1_000_000) throw new Error("bad scores.db");
        for (let i = 0; i < count; i += 1) {
            const s = {
                mode: r.u8(), version: r.i32(), md5: r.str(), player: r.str(), replayMd5: r.str(),
                n300: r.i16(), n100: r.i16(), n50: r.i16(), geki: r.i16(), katu: r.i16(), miss: r.i16(),
                score: r.i32(), maxCombo: r.i16(), perfect: r.bool(), mods: r.i32() >>> 0,
            };
            r.str(); // life bar graph
            const ticks = r.i64();
            r.i32(); // always −1
            const onlineId = r.i64();
            if (s.mods & TARGET_PRACTICE) r.f64();
            if (mode !== null && s.mode !== mode) continue;
            const names = modNames(s.mods);
            scores.push({
                ...s,
                md5: s.md5 ? s.md5.toLowerCase() : null,
                modNames: names,
                rate: rateOfMods(names),
                at: ticksToMs(ticks),
                onlineId: onlineId > 0n ? String(onlineId) : null,
                // osu!mania's judgements under the overlay's names
                hits: { max: s.geki, n300: s.n300, n200: s.katu, n100: s.n100, n50: s.n50, miss: s.miss },
            });
        }
    }
    return { version, beatmaps, scores };
}

// The player whose scores to take: the one asked for if they have any, else the name with the most scores.
export function mainPlayer(scores, preferred = null) {
    const counts = new Map();
    for (const s of scores) if (s.player) counts.set(s.player, (counts.get(s.player) ?? 0) + 1);
    const want = typeof preferred === "string" ? preferred.trim().toLowerCase() : "";
    if (want) for (const name of counts.keys()) if (name.toLowerCase() === want) return name;
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
