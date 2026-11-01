// osu!'s replay file (.osr, osu.ppy.sh/wiki/Client/File_formats/osr_(file_format)), read only:
//   Byte mode, Int version, String map md5, String player, String replay md5, Short 300, 100, 50, geki, katu, miss,
//   Int score, Short max combo, Byte perfect, Int mods, String life bar, Long timestamp (Windows ticks), Int length,
//   the LZMA stream of "w|x|y|z," frames, Long online score id.
// w: ms since the last frame; in osu!mania x is the bitmask of the columns held. Two frames at the start (x 256,
// y −500) mean nothing; a last frame w = −12345 holds the seed; a negative w moves the clock but is not played (as
// osu! lazer's replay decoder reads them). Strings as in scores.db. Pure: no node modules.
// The header's counts and max combo are 16 bits: a marathon's come back short by whole 65 536s (a real play of 156 764 notes
// reads 91 228), so they are put right once it is known how many notes the play got to (unwrapped, fullCounts).
import { lzmaDecode } from "./lzma.js";
import { modNames, rateOfMods, ticksToMs } from "../localProfile/scoresDb.js";

export const MANIA = 3;
export const SEED_FRAME = -12345;

class Reader {
    constructor(bytes) {
        this.b = bytes;
        this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.at = 0;
    }
    need(n) {
        if (n < 0 || this.at + n > this.b.length) throw new Error("osr: ends too early");
    }
    u8() { this.need(1); return this.b[this.at++]; }
    u16() { this.need(2); const x = this.v.getUint16(this.at, true); this.at += 2; return x; }
    i32() { this.need(4); const x = this.v.getInt32(this.at, true); this.at += 4; return x; }
    i64() { this.need(8); const x = this.v.getBigInt64(this.at, true); this.at += 8; return x; }
    str() {
        const flag = this.u8();
        if (flag === 0) return null;
        if (flag !== 0x0b) throw new Error("osr: bad string");
        let len = 0;
        for (let shift = 0; ; shift += 7) {
            if (shift > 28) throw new Error("osr: bad string");
            const c = this.u8();
            len += (c & 0x7f) * 2 ** shift;
            if (!(c & 0x80)) break;
        }
        this.need(len);
        const text = new TextDecoder("utf-8").decode(this.b.subarray(this.at, this.at + len));
        this.at += len;
        return text;
    }
}

// .osr bytes → the header and where the frames are: { mode, version, md5, player, replayMd5, counts, total, score,
// maxCombo, perfect, mods, modNames, rate, at, packed, onlineId }. counts: { max, n300, n200, n100, n50, miss }
// (osu!mania's names; geki is its MAX, katu its 200). packed: the LZMA stream's bytes, not unpacked yet.
export function readOsr(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const r = new Reader(bytes);
    const mode = r.u8();
    if (mode > 3) throw new Error("osr: unknown mode");
    const version = r.i32();
    const md5 = r.str();
    if (!md5 || !/^[0-9a-f]{32}$/i.test(md5)) throw new Error("osr: no map md5");
    const player = r.str() ?? "";
    const replayMd5 = r.str();
    const n300 = r.u16();
    const n100 = r.u16();
    const n50 = r.u16();
    const max = r.u16();
    const n200 = r.u16();
    const miss = r.u16();
    const score = r.i32();
    const maxCombo = r.u16();
    const perfect = r.u8() !== 0;
    const mods = r.i32() >>> 0;
    r.str(); // the life bar
    const ticks = r.i64();
    const length = r.i32();
    r.need(length);
    const packed = bytes.subarray(r.at, r.at + length);
    r.at += length;
    let onlineId = null;
    if (r.at + 8 <= bytes.length) {
        const id = r.i64();
        if (id > 0n) onlineId = String(id);
    }
    const names = modNames(mods);
    return {
        mode, version, md5: md5.toLowerCase(), player, replayMd5,
        counts: { max, n300, n200, n100, n50, miss }, total: max + n300 + n200 + n100 + n50 + miss,
        score, maxCombo, perfect, mods, modNames: names, rate: rateOfMods(names),
        at: ticks > 0n ? ticksToMs(ticks) : null, packed, onlineId,
    };
}

export const COUNT_WRAP = 65536;

// A 16-bit value back to what it was, given about what it should be: the same modulo 65 536, closest to `near`, never less.
export const unwrapped = (value, near) => value + Math.max(0, Math.round((near - value) / COUNT_WRAP)) * COUNT_WRAP;

// The header's counts for a play of about `judged` notes. The 65 536s lost go to max: a marathon's biggest count, and to
// accuracy MAX and 300 are the same.
export function fullCounts(counts, judged) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const lost = unwrapped(total, judged) - total;
    return lost ? { ...counts, max: counts.max + lost } : counts;
}

// The frames' text → { times: Int32Array, masks: Uint8Array, seed }: the frames that are played, in file order.
export function parseFrames(text, keys = 4) {
    const parts = String(text).split(",");
    const times = new Int32Array(parts.length);
    const masks = new Uint8Array(parts.length);
    const all = (1 << keys) - 1;
    let clock = 0;
    let n = 0;
    let seed = null;
    for (let i = 0; i < parts.length; i += 1) {
        const p = parts[i];
        const bar = p.indexOf("|");
        const bar2 = p.indexOf("|", bar + 1);
        if (bar < 0 || bar2 < 0) continue;
        const w = Number(p.slice(0, bar));
        const x = Number(p.slice(bar + 1, bar2));
        if (!Number.isFinite(w) || !Number.isFinite(x)) continue;
        if (w === SEED_FRAME) {
            const z = Number(p.slice(p.lastIndexOf("|") + 1));
            seed = Number.isFinite(z) ? z : null;
            continue;
        }
        clock += w;
        if (i < 2 && x === 256) continue;
        if (w < 0) continue;
        times[n] = clock;
        masks[n] = x & all;
        n += 1;
    }
    return { times: times.subarray(0, n), masks: masks.subarray(0, n), seed };
}

export function unpackFrames(packed, keys = 4) {
    if (!packed?.length) return { times: new Int32Array(0), masks: new Uint8Array(0), seed: null };
    return parseFrames(new TextDecoder("latin1").decode(lzmaDecode(packed)), keys);
}

// The frames → the key presses of each column: [[{ t, up }], …] sorted by t; up: the release's time, null when the key
// is still down at the end.
export function keyPresses({ times, masks }, keys = 4) {
    const columns = Array.from({ length: keys }, () => []);
    const open = new Array(keys).fill(null);
    let last = 0;
    for (let i = 0; i < masks.length; i += 1) {
        const mask = masks[i];
        const changed = mask ^ last;
        if (changed) {
            for (let c = 0; c < keys; c += 1) {
                if (!(changed & (1 << c))) continue;
                if (mask & (1 << c)) {
                    open[c] = { t: times[i], up: null };
                    columns[c].push(open[c]);
                } else if (open[c]) {
                    open[c].up = times[i];
                    open[c] = null;
                }
            }
        }
        last = mask;
    }
    return columns;
}
