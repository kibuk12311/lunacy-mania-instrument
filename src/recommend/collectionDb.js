// osu!stable's collection.db: Int32 version, Int32 collection count; each collection is a name, an Int32 count
// and that many beatmap MD5s. Strings are 0x0b, the UTF-8 byte length in ULEB128 and the bytes; an empty one is 0x00.
import { t } from "../i18n/i18n.js";

export const COLLECTION_DB_VERSION = 20150203;

export function uleb128(n) {
    const out = [];
    let v = Math.max(0, Math.floor(Number(n) || 0));
    do {
        let byte = v % 128;
        v = Math.floor(v / 128);
        if (v > 0) byte |= 0x80;
        out.push(byte);
    } while (v > 0);
    return Buffer.from(out);
}

export function osuString(s) {
    const text = typeof s === "string" ? s : "";
    if (!text) return Buffer.from([0x00]);
    const body = Buffer.from(text, "utf8");
    return Buffer.concat([Buffer.from([0x0b]), uleb128(body.length), body]);
}

const int32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    return b;
};

export function encodeCollectionDb({ version = COLLECTION_DB_VERSION, collections = [] } = {}) {
    const parts = [int32(version), int32(collections.length)];
    for (const c of collections) {
        const hashes = Array.isArray(c?.hashes) ? c.hashes : [];
        parts.push(osuString(c?.name), int32(hashes.length), ...hashes.map(osuString));
    }
    return Buffer.concat(parts);
}

// The reverse, for checks; a cut or garbled file throws.
export function decodeCollectionDb(buf) {
    let at = 0;
    const bad = () => new Error(t("recommend.err.badCollectionDb"));
    const need = (n) => { if (at + n > buf.length) throw bad(); };
    const readInt = () => {
        need(4);
        const v = buf.readInt32LE(at);
        at += 4;
        return v;
    };
    const readUleb = () => {
        let v = 0;
        let scale = 1;
        for (;;) {
            need(1);
            const byte = buf[at++];
            v += (byte & 0x7f) * scale;
            if (!(byte & 0x80)) return v;
            scale *= 128;
            if (scale > 2 ** 35) throw bad();
        }
    };
    const readString = () => {
        need(1);
        const marker = buf[at++];
        if (marker === 0x00) return "";
        if (marker !== 0x0b) throw bad();
        const n = readUleb();
        need(n);
        const s = buf.toString("utf8", at, at + n);
        at += n;
        return s;
    };
    const version = readInt();
    const count = readInt();
    if (count < 0) throw bad();
    const collections = [];
    for (let i = 0; i < count; i++) {
        const name = readString();
        const n = readInt();
        if (n < 0) throw bad();
        const hashes = [];
        for (let k = 0; k < n; k++) hashes.push(readString());
        collections.push({ name, hashes });
    }
    if (at !== buf.length) throw bad();
    return { version, collections };
}
