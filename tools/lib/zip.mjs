// Streaming zip reader for big archives (multi-GB chart packs). Only positional reads through one file handle:
// the central directory is read once (ZIP64 included), and each entry is inflated straight to disk, so an archive
// is never held in memory. Archives are downloads, i.e. untrusted: names go through safeEntryParts/safeJoin,
// sizes are capped and checked against the directory and the CRC, and nothing inside is ever executed.
import { open, mkdir, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync, crc32 } from "node:zlib";
import path from "node:path";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const U16 = 0xffff;
const U32 = 0xffffffff;
const CHUNK = 1 << 20;
const MAX_DIRECTORY_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

// IBM code page 437, bytes 0x80–0xFF: the zip default for names without the UTF-8 flag.
const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes, utf8Flag) {
    if (utf8Flag) return bytes.toString("utf8");
    // Many packers write UTF-8 without setting the flag; anything else is taken as CP437.
    try {
        return utf8Strict.decode(bytes);
    } catch {
        let s = "";
        for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
        return s;
    }
}

async function readAt(fh, position, length) {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
        const { bytesRead } = await fh.read(buf, got, length - got, position + got);
        if (!bytesRead) break;
        got += bytesRead;
    }
    return buf.subarray(0, got);
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// The parts of an entry name that may become a path, or null: no absolute paths, drive letters, "..", device
// names or ":" (alternate streams). Trailing dots/spaces are dropped as Windows would; bad characters become "_".
export function safeEntryParts(name) {
    if (typeof name !== "string" || !name) return null;
    const n = name.replace(/\\/g, "/");
    if (n.startsWith("/") || /^[a-z]:/i.test(n)) return null;
    const parts = [];
    for (const raw of n.split("/")) {
        if (raw === "" || raw === ".") continue;
        if (raw === ".." || raw.includes(":")) return null;
        const part = raw.replace(/[\u0000-\u001f<>"|?*]/g, "_").replace(/[. ]+$/, "");
        if (!part || RESERVED.test(part)) return null;
        parts.push(part);
    }
    return parts.length ? parts : null;
}

// root + entry name as an absolute path inside root, or null when the name is unsafe.
export function safeJoin(root, name) {
    const parts = safeEntryParts(name);
    if (!parts) return null;
    const base = path.resolve(root);
    const full = path.resolve(base, ...parts);
    const rel = path.relative(base, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return full;
}

function parseCentral(cd, count, shift) {
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i += 1) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`bad central directory at entry ${i}`);
        const flags = cd.readUInt16LE(p + 8);
        const method = cd.readUInt16LE(p + 10);
        const crc = cd.readUInt32LE(p + 16);
        let compressedSize = cd.readUInt32LE(p + 20);
        let size = cd.readUInt32LE(p + 24);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        let localOffset = cd.readUInt32LE(p + 42);
        const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
        const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
        let name = decodeName(nameBytes, (flags & 0x800) !== 0);
        for (let q = 0; q + 4 <= extra.length;) {
            const id = extra.readUInt16LE(q);
            const len = extra.readUInt16LE(q + 2);
            const body = extra.subarray(q + 4, q + 4 + len);
            if (id === 0x0001) {
                // ZIP64: only the saturated fields are here, always in this order
                let r = 0;
                const next = () => {
                    if (r + 8 > body.length) throw new Error(`short zip64 field in ${name}`);
                    const v = Number(body.readBigUInt64LE(r));
                    r += 8;
                    return v;
                };
                if (size === U32) size = next();
                if (compressedSize === U32) compressedSize = next();
                if (localOffset === U32) localOffset = next();
            } else if (id === 0x7075 && body.length > 5 && body[0] === 1 && body.readUInt32LE(1) === crc32(nameBytes)) {
                name = body.subarray(5).toString("utf8"); // Info-ZIP Unicode path for this very name
            }
            q += 4 + len;
        }
        p += 46 + nameLen + extraLen + commentLen;
        name = name.replace(/\\/g, "/");
        entries.push({
            name, method, flags, crc32: crc, compressedSize, size, localOffset: localOffset + shift,
            isDirectory: name.endsWith("/"), encrypted: (flags & 1) !== 0,
        });
    }
    return entries;
}

// { entries, size, readEntry(entry, opts) → Buffer, extractEntry(entry, file, opts) → bytes, close() }
export async function openZip(file) {
    const fh = await open(file, "r");
    try {
        const { size } = await fh.stat();
        const tailLen = Math.min(size, 22 + U16 + 20);
        const tailStart = size - tailLen;
        const tail = await readAt(fh, tailStart, tailLen);
        let e = -1;
        for (let i = tail.length - 22; i >= 0; i -= 1) {
            if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
                e = i;
                break;
            }
        }
        if (e < 0) throw new Error("not a zip (no end of central directory)");
        const eocdPos = tailStart + e;
        let count = tail.readUInt16LE(e + 10);
        let cdSize = tail.readUInt32LE(e + 12);
        let cdOffset = tail.readUInt32LE(e + 16);
        let cdEnd = eocdPos; // the directory always ends where the (zip64) end record starts
        if (e >= 20 && tail.readUInt32LE(e - 20) === SIG_LOCATOR64) {
            const locatorPos = eocdPos - 20;
            const declared = Number(tail.readBigUInt64LE(e - 20 + 8));
            // the declared spot, else right before the locator (a record without extensible data), as with cdOffset
            let recPos = -1;
            for (const at of [declared, locatorPos - 56]) {
                if (at < 0 || at + 56 > locatorPos) continue;
                const sig = await readAt(fh, at, 4);
                if (sig.length === 4 && sig.readUInt32LE(0) === SIG_EOCD64) {
                    recPos = at;
                    break;
                }
            }
            if (recPos < 0) {
                for (let i = e - 20 - 56; i >= 0; i -= 1) {
                    if (tail.readUInt32LE(i) === SIG_EOCD64) {
                        recPos = tailStart + i;
                        break;
                    }
                }
            }
            if (recPos < 0) throw new Error("zip64 end record not found");
            const rec = await readAt(fh, recPos, 56);
            count = Number(rec.readBigUInt64LE(32));
            cdSize = Number(rec.readBigUInt64LE(40));
            cdOffset = Number(rec.readBigUInt64LE(48));
            cdEnd = recPos;
        } else if (count === U16 || cdSize === U32 || cdOffset === U32) {
            throw new Error("zip64 archive without a zip64 end record");
        }
        if (cdSize > MAX_DIRECTORY_BYTES) throw new Error(`central directory too big (${cdSize} bytes)`);
        // Some packers write a wrong directory offset (data glued in front): the real start is cdEnd - cdSize,
        // and every local header offset moves by the same amount.
        const actual = cdEnd - cdSize;
        if (actual < 0) throw new Error("central directory size larger than the archive");
        const head = cdOffset + 4 <= size ? await readAt(fh, cdOffset, 4) : Buffer.alloc(0);
        const shift = count === 0 || (head.length === 4 && head.readUInt32LE(0) === SIG_CENTRAL) ? 0 : actual - cdOffset;
        const cd = await readAt(fh, cdOffset + shift, cdSize);
        if (cd.length < cdSize) throw new Error("archive is truncated (central directory)");
        const entries = parseCentral(cd, count, shift);
        return makeReader(fh, size, entries);
    } catch (error) {
        await fh.close();
        throw error;
    }
}

function makeReader(fh, size, entries) {
    let closed = false;

    async function dataStart(entry) {
        if (entry.encrypted) throw new Error(`${entry.name}: encrypted`);
        if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: compression method ${entry.method} not supported`);
        if (!(entry.localOffset >= 0) || entry.localOffset + 30 > size) throw new Error(`${entry.name}: bad local header offset`);
        const local = await readAt(fh, entry.localOffset, 30);
        if (local.length < 30 || local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`${entry.name}: bad local header`);
        const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (start + entry.compressedSize > size) throw new Error(`${entry.name}: archive is truncated`);
        return start;
    }

    function checkCap(entry, maxBytes) {
        if (entry.size > maxBytes) throw new Error(`${entry.name}: ${entry.size} bytes is over the ${maxBytes} byte cap`);
        if (entry.method === 0 && entry.compressedSize !== entry.size) throw new Error(`${entry.name}: stored sizes disagree`);
    }

    // Small entries (charts) into memory.
    async function readEntry(entry, { maxBytes = 64 * 1024 * 1024 } = {}) {
        checkCap(entry, maxBytes);
        const start = await dataStart(entry);
        const raw = await readAt(fh, start, entry.compressedSize);
        if (raw.length < entry.compressedSize) throw new Error(`${entry.name}: archive is truncated`);
        let data;
        if (entry.method === 0) data = raw;
        else {
            try {
                data = inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(maxBytes, entry.size + 1)) });
            } catch (error) {
                throw new Error(`${entry.name}: ${error?.code === "ERR_BUFFER_TOO_LARGE" ? "inflates past its declared size" : "damaged deflate data"}`);
            }
        }
        if (data.length !== entry.size) throw new Error(`${entry.name}: size ${data.length} != declared ${entry.size}`);
        if (crc32(data) !== entry.crc32) throw new Error(`${entry.name}: CRC mismatch`);
        return data;
    }

    // Any entry streamed to `target` (written as target.part, renamed when size and CRC check out).
    async function extractEntry(entry, target, { maxBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
        checkCap(entry, maxBytes);
        const start = await dataStart(entry);
        await mkdir(path.dirname(target), { recursive: true });
        const part = `${target}.part`;
        let written = 0;
        let crc = 0;
        const guard = new Transform({
            transform(chunk, _enc, done) {
                written += chunk.length;
                if (written > entry.size) return done(new Error(`${entry.name}: inflates past its declared size`));
                crc = crc32(chunk, crc);
                done(null, chunk);
            },
        });
        async function* compressed() {
            let pos = start;
            let left = entry.compressedSize;
            while (left > 0) {
                const n = Math.min(CHUNK, left);
                const buf = await readAt(fh, pos, n);
                if (!buf.length) throw new Error(`${entry.name}: archive is truncated`);
                pos += buf.length;
                left -= buf.length;
                yield buf;
            }
        }
        try {
            await pipeline(Readable.from(compressed()), entry.method === 8 ? createInflateRaw() : new PassThrough(), guard, createWriteStream(part));
            if (written !== entry.size) throw new Error(`${entry.name}: size ${written} != declared ${entry.size}`);
            if (crc !== entry.crc32) throw new Error(`${entry.name}: CRC mismatch`);
            await rename(part, target);
            return written;
        } catch (error) {
            await rm(part, { force: true });
            throw error;
        }
    }

    async function close() {
        if (closed) return;
        closed = true;
        await fh.close();
    }

    return { entries, size, readEntry, extractEntry, close };
}

// Every file entry whose name passes `filter(name, entry)` into destDir (names made safe; unsafe ones skipped).
// → { extracted: [{ name, file, size }], skipped: [{ name, reason }] }
export async function extractZip(file, destDir, { filter = () => true, maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
    const zip = await openZip(file);
    const extracted = [];
    const skipped = [];
    try {
        for (const entry of zip.entries) {
            if (entry.isDirectory || !filter(entry.name, entry)) continue;
            const target = safeJoin(destDir, entry.name);
            if (!target) {
                skipped.push({ name: entry.name, reason: "unsafe path" });
                continue;
            }
            try {
                const size = await zip.extractEntry(entry, target, { maxBytes: maxEntryBytes });
                extracted.push({ name: entry.name, file: target, size });
            } catch (error) {
                skipped.push({ name: entry.name, reason: String(error?.message ?? error) });
            }
        }
    } finally {
        await zip.close();
    }
    return { extracted, skipped };
}
