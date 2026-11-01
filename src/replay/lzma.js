// LZMA "alone" streams (what an osu! replay holds), decoded in plain JS: the decoder of the LZMA specification
// (LZMA SDK, lzma-specification.txt), no dependency. bytes → Uint8Array of what was packed; throws on a broken stream.
// Header: 1 byte lc / lp / pb, 4 bytes dictionary size, 8 bytes unpacked size (all FF: unknown, ended by a marker).
const TOP = 2 ** 24;
const BIT_MODEL_BITS = 11;
const MOVE_BITS = 5;
const PROB_INIT = (1 << BIT_MODEL_BITS) >>> 1;
const STATES = 12;
const POS_STATES_MAX_BITS = 4;
const LEN_TO_POS_STATES = 4;
const ALIGN_BITS = 4;
const END_POS_MODEL = 14;
const FULL_DISTANCES = 1 << (END_POS_MODEL >> 1);
const MATCH_MIN_LEN = 2;
const HEADER = 13;
export const MAX_UNPACKED = 512 * 1024 * 1024;

const probs = (n) => new Uint16Array(n).fill(PROB_INIT);
const lengthCoder = () => ({
    choice: probs(2),
    low: probs(8 << POS_STATES_MAX_BITS),
    mid: probs(8 << POS_STATES_MAX_BITS),
    high: probs(256),
});

export function lzmaDecode(input) {
    const src = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (src.length < HEADER + 5) throw new Error("LZMA: too short");
    const d = src[0];
    if (d >= 225) throw new Error("LZMA: bad properties");
    const lc = d % 9;
    const lp = Math.floor(d / 9) % 5;
    const pb = Math.floor(d / 45);
    let unknownSize = true;
    let size = 0;
    for (let i = 7; i >= 0; i -= 1) {
        if (src[5 + i] !== 0xff) unknownSize = false;
        size = size * 256 + src[5 + i];
    }
    if (unknownSize) size = -1;
    if (size > MAX_UNPACKED) throw new Error("LZMA: too big");

    let out = new Uint8Array(size >= 0 ? size : Math.max(1 << 16, src.length * 8));
    let pos = 0;
    let at = HEADER;
    if (src[at] !== 0) throw new Error("LZMA: bad stream");
    let code = ((src[at + 1] * TOP) + ((src[at + 2] << 16) | (src[at + 3] << 8) | src[at + 4])) >>> 0;
    at += 5;
    let range = 0xffffffff;

    const normalize = () => {
        if (range < TOP) {
            range = (range * 256) >>> 0;
            code = ((code * 256) + (at < src.length ? src[at] : 0)) % 4294967296;
            at += 1;
            if (at > src.length + 8) throw new Error("LZMA: stream ends too early");
        }
    };
    const bit = (p, i) => {
        normalize();
        const v = p[i];
        const bound = (range >>> BIT_MODEL_BITS) * v;
        if (code < bound) {
            range = bound;
            p[i] = v + (((1 << BIT_MODEL_BITS) - v) >>> MOVE_BITS);
            return 0;
        }
        range = (range - bound) >>> 0;
        code = (code - bound) >>> 0;
        p[i] = v - (v >>> MOVE_BITS);
        return 1;
    };
    const direct = (n) => {
        let res = 0;
        for (let i = 0; i < n; i += 1) {
            normalize();
            range >>>= 1;
            if (code >= range) {
                code = (code - range) >>> 0;
                res = res * 2 + 1;
            } else res *= 2;
        }
        return res;
    };
    const tree = (p, base, n) => {
        let m = 1;
        for (let i = 0; i < n; i += 1) m = (m << 1) + bit(p, base + m);
        return m - (1 << n);
    };
    const reverse = (p, base, n) => {
        let m = 1;
        let sym = 0;
        for (let i = 0; i < n; i += 1) {
            const b = bit(p, base + m);
            m = (m << 1) + b;
            sym |= b << i;
        }
        return sym;
    };

    const literal = probs(0x300 << (lc + lp));
    const isMatch = probs(STATES << POS_STATES_MAX_BITS);
    const isRep = probs(STATES);
    const isRepG0 = probs(STATES);
    const isRepG1 = probs(STATES);
    const isRepG2 = probs(STATES);
    const isRep0Long = probs(STATES << POS_STATES_MAX_BITS);
    const slots = probs(LEN_TO_POS_STATES << 6);
    const posCoders = probs(1 + FULL_DISTANCES - END_POS_MODEL);
    const align = probs(1 << ALIGN_BITS);
    const lenCoder = lengthCoder();
    const repCoder = lengthCoder();
    const posMask = (1 << pb) - 1;
    const litMask = (1 << lp) - 1;

    const put = (byte) => {
        if (pos >= out.length) {
            if (size >= 0) throw new Error("LZMA: more data than the header says");
            if (out.length * 2 > MAX_UNPACKED) throw new Error("LZMA: too big");
            const bigger = new Uint8Array(out.length * 2);
            bigger.set(out);
            out = bigger;
        }
        out[pos] = byte;
        pos += 1;
    };
    const length = (c, posState) => {
        if (bit(c.choice, 0) === 0) return tree(c.low, posState << 3, 3);
        if (bit(c.choice, 1) === 0) return 8 + tree(c.mid, posState << 3, 3);
        return 16 + tree(c.high, 0, 8);
    };
    const distance = (len) => {
        const slot = tree(slots, Math.min(len, LEN_TO_POS_STATES - 1) << 6, 6);
        if (slot < 4) return slot;
        const n = (slot >> 1) - 1;
        const dist = (2 | (slot & 1)) * 2 ** n;
        if (slot < END_POS_MODEL) return dist + reverse(posCoders, dist - slot, n);
        return dist + direct(n - ALIGN_BITS) * (1 << ALIGN_BITS) + reverse(align, 0, ALIGN_BITS);
    };

    let state = 0;
    let rep0 = 0;
    let rep1 = 0;
    let rep2 = 0;
    let rep3 = 0;
    while (size < 0 || pos < size) {
        const posState = pos & posMask;
        if (bit(isMatch, (state << POS_STATES_MAX_BITS) + posState) === 0) {
            const prev = pos > 0 ? out[pos - 1] : 0;
            const base = 0x300 * (((pos & litMask) << lc) + (prev >> (8 - lc)));
            let symbol = 1;
            if (state >= 7) {
                let matchByte = rep0 < pos ? out[pos - rep0 - 1] : 0;
                do {
                    const matchBit = (matchByte >> 7) & 1;
                    matchByte = (matchByte << 1) & 0xff;
                    const b = bit(literal, base + ((1 + matchBit) << 8) + symbol);
                    symbol = (symbol << 1) | b;
                    if (matchBit !== b) break;
                } while (symbol < 0x100);
            }
            while (symbol < 0x100) symbol = (symbol << 1) | bit(literal, base + symbol);
            put(symbol & 0xff);
            state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
            continue;
        }
        let len;
        if (bit(isRep, state) !== 0) {
            if (pos === 0) throw new Error("LZMA: bad stream");
            if (bit(isRepG0, state) === 0) {
                if (bit(isRep0Long, (state << POS_STATES_MAX_BITS) + posState) === 0) {
                    state = state < 7 ? 9 : 11;
                    put(out[pos - rep0 - 1]);
                    continue;
                }
            } else {
                let dist;
                if (bit(isRepG1, state) === 0) dist = rep1;
                else {
                    if (bit(isRepG2, state) === 0) dist = rep2;
                    else {
                        dist = rep3;
                        rep3 = rep2;
                    }
                    rep2 = rep1;
                }
                rep1 = rep0;
                rep0 = dist;
            }
            len = length(repCoder, posState);
            state = state < 7 ? 8 : 11;
        } else {
            rep3 = rep2;
            rep2 = rep1;
            rep1 = rep0;
            len = length(lenCoder, posState);
            state = state < 7 ? 7 : 10;
            rep0 = distance(len);
            if (rep0 === 0xffffffff) {
                if (size >= 0) throw new Error("LZMA: end marker in a sized stream");
                break;
            }
            if (rep0 >= pos) throw new Error("LZMA: bad distance");
        }
        const copy = len + MATCH_MIN_LEN;
        for (let i = 0; i < copy && (size < 0 || pos < size); i += 1) put(out[pos - rep0 - 1]);
    }
    return size >= 0 ? out : out.subarray(0, pos);
}
