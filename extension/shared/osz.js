// Reading an .osz (a zip) in the browser: the central directory, stored and deflated entries (DecompressionStream
// "deflate-raw"), names as UTF-8, a size cap per entry. Ported from src/rate/oszRead.js (the app's reader), including
// its fix for packers that write a wrong directory offset.
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
export const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

export class ZipError extends Error {
    constructor(message) {
        super(message);
        this.name = "ZipError";
        this.code = "not-zip";
    }
}
const damaged = (why) => new ZipError(`not a readable .osz (${why})`);
const utf8 = new TextDecoder("utf-8");

async function inflate(raw, expected, cap) {
    if (typeof DecompressionStream !== "function") throw damaged("no DecompressionStream");
    let reader;
    try {
        reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    } catch {
        throw damaged("deflate-raw unsupported");
    }
    const parts = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > cap) {
                reader.cancel().catch(() => {});
                throw damaged("entry too big");
            }
            parts.push(value);
        }
    } catch (error) {
        if (error instanceof ZipError) throw error;
        throw damaged("bad deflate data");
    }
    if (total !== expected) throw damaged("wrong size");
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

// [{ name, method, size, read() -> Promise<Uint8Array> }] of a zip in memory; throws a ZipError on anything that is
// not a readable zip. maxEntryBytes caps what one entry may unpack to.
export function readZip(input, { maxEntryBytes = MAX_ENTRY_BYTES } = {}) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const u16 = (p) => view.getUint16(p, true);
    const u32 = (p) => view.getUint32(p, true);
    if (buf.length < 22) throw damaged("too short");
    const from = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let p = buf.length - 22; p >= from; p -= 1) {
        if (u32(p) === EOCD) {
            eocd = p;
            break;
        }
    }
    if (eocd < 0) throw damaged("no directory");
    const count = u16(eocd + 10);
    const size = u32(eocd + 12);
    const declared = u32(eocd + 16);
    const okAt = (p) => p >= 0 && p + 4 <= buf.length && u32(p) === CENTRAL;
    // The directory always ends at the EOCD: when the declared offset is wrong (data glued in front), its real start
    // comes from its size, and every local header moves by the same amount.
    const shift = okAt(declared) ? 0 : eocd - size - declared;
    let p = declared + shift;
    const entries = [];
    for (let i = 0; i < count; i += 1) {
        if (!okAt(p) || p + 46 > buf.length) throw damaged("bad directory entry");
        const method = u16(p + 10);
        const packed = u32(p + 20);
        const unpacked = u32(p + 24);
        const nameLen = u16(p + 28);
        const extraLen = u16(p + 30);
        const commentLen = u16(p + 32);
        const local = u32(p + 42) + shift;
        if (p + 46 + nameLen > buf.length) throw damaged("bad name");
        // UTF-8 whether or not flag bit 11 says so: that is what .osz packers write
        const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        entries.push({
            name,
            method,
            size: unpacked,
            async read() {
                if (local < 0 || local + 30 > buf.length || u32(local) !== LOCAL) throw damaged("bad local header");
                const start = local + 30 + u16(local + 26) + u16(local + 28);
                if (packed === 0xffffffff || unpacked === 0xffffffff) throw damaged("zip64");
                if (start + packed > buf.length) throw damaged("cut off");
                if (unpacked > maxEntryBytes) throw damaged("entry too big");
                const raw = buf.subarray(start, start + packed);
                if (method === 0) return raw.slice();
                if (method === 8) return inflate(raw, unpacked, maxEntryBytes);
                throw damaged(`method ${method}`);
            },
        });
    }
    return entries;
}

// An entry's name for comparing: "/" for "\", no leading "./", lower case.
export const entryKey = (name) => String(name ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").toLowerCase();

// The entry named `name` (as an .osu names its audio: any case, "\" or "/"), looked up next to `folder` first.
export function findEntry(entries, name, folder = "") {
    const want = entryKey(name);
    if (!want) return null;
    const dir = entryKey(folder).replace(/\/+$/, "");
    const byKey = new Map(entries.map((e) => [entryKey(e.name), e]));
    return (dir && dir !== "." && byKey.get(`${dir}/${want}`)) || byKey.get(want) || null;
}
