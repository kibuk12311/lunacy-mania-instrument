// Streaming tar reader (ustar, pax "x"/"g" headers, GNU "L"/"K" long names) for tools that read big downloaded shards.
// Nothing is buffered beyond the entry the caller asks to read: an entry that is not read is skipped as it streams.
//
//   for await (const entry of readTar(response.body)) {
//       entry.name, entry.type ("file" | "directory" | "symlink" | "link" | "other"), entry.size,
//       entry.headerOffset (where this entry's first header, pax/long-name included, starts in the stream),
//       entry.endOffset (first byte after its padded data: where the next entry starts)
//       await entry.read()  → Buffer with the data (only once, only before the loop moves on)
//   }
//
// The input is a web ReadableStream, a Node stream or any async iterable of Uint8Array chunks. Data comes from
// untrusted downloads: headers are checksum-checked, sizes are bounded, and names are returned as-is (callers
// must not build output paths from them; see safeTarName).

const BLOCK = 512;
const DEFAULT_MAX_META = 1 << 20; // pax / long-name payloads
const DEFAULT_MAX_ENTRY = 512 * 1024 * 1024; // read() refuses anything larger

// Pull-based byte reader over an async iterator of chunks.
class ByteReader {
    constructor(source) {
        const it = source?.[Symbol.asyncIterator] ? source[Symbol.asyncIterator]()
            : typeof source?.getReader === "function" ? readerIterator(source.getReader())
                : source?.[Symbol.iterator] && !(source instanceof Uint8Array) && typeof source !== "string"
                    ? source[Symbol.iterator]() // a plain array of chunks (tests, small buffers)
                    : null;
        if (!it) throw new TypeError("readTar: expected a ReadableStream or an async iterable of chunks");
        this.it = it;
        this.chunks = [];
        this.buffered = 0;
        this.ended = false;
        this.position = 0; // bytes handed out so far
    }

    async fill(n) {
        while (this.buffered < n && !this.ended) {
            const { value, done } = await this.it.next();
            if (done) { this.ended = true; break; }
            if (!value?.length) continue;
            const buf = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            this.chunks.push(buf);
            this.buffered += buf.length;
        }
        return this.buffered >= n;
    }

    // Exactly n bytes, or null at a clean end of stream; a short tail throws.
    async read(n) {
        if (n === 0) return Buffer.alloc(0);
        if (!(await this.fill(n))) {
            if (this.buffered === 0) return null;
            throw new Error(`tar: stream ended inside a block (${this.buffered} of ${n} bytes)`);
        }
        let out;
        if (this.chunks[0].length >= n) {
            out = this.chunks[0].subarray(0, n);
            if (out.length === this.chunks[0].length) this.chunks.shift();
            else this.chunks[0] = this.chunks[0].subarray(n);
        } else {
            out = Buffer.allocUnsafe(n);
            let off = 0;
            while (off < n) {
                const c = this.chunks[0];
                const take = Math.min(c.length, n - off);
                c.copy(out, off, 0, take);
                off += take;
                if (take === c.length) this.chunks.shift();
                else this.chunks[0] = c.subarray(take);
            }
        }
        this.buffered -= n;
        this.position += n;
        return out;
    }

    async skip(n) {
        while (n > 0) {
            if (!this.buffered && !(await this.fill(1))) throw new Error("tar: stream ended inside an entry");
            const c = this.chunks[0];
            const take = Math.min(c.length, n);
            if (take === c.length) this.chunks.shift();
            else this.chunks[0] = c.subarray(take);
            this.buffered -= take;
            this.position += take;
            n -= take;
        }
    }

    async close() {
        this.chunks = [];
        this.buffered = 0;
        try { await this.it.return?.(); } catch { /* the stream may already be broken */ }
    }
}

function readerIterator(reader) {
    return {
        next: () => reader.read(),
        return: async () => { try { await reader.cancel(); } catch { /* ignore */ } return { done: true }; },
    };
}

const pad = (n) => (BLOCK - (n % BLOCK)) % BLOCK;

function cstr(buf, start, len) {
    const field = buf.subarray(start, start + len);
    const end = field.indexOf(0);
    return (end < 0 ? field : field.subarray(0, end)).toString("utf8");
}

// Octal, or GNU base-256 (high bit set) for sizes over 8 GB.
export function parseNumber(buf, start, len) {
    const field = buf.subarray(start, start + len);
    if (field[0] & 0x80) {
        if (field[0] & 0x40) throw new Error("tar: negative number field");
        let v = field[0] & 0x3f;
        for (let i = 1; i < field.length; i++) v = v * 256 + field[i];
        if (!Number.isSafeInteger(v)) throw new Error("tar: number field too large");
        return v;
    }
    const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
    if (!text) return 0;
    if (!/^[0-7]+$/.test(text)) throw new Error(`tar: bad octal field "${text.slice(0, 20)}"`);
    return parseInt(text, 8);
}

function checksumOk(header) {
    const stored = parseNumber(header, 148, 8);
    let unsigned = 0;
    let signed = 0;
    for (let i = 0; i < BLOCK; i++) {
        const b = i >= 148 && i < 156 ? 0x20 : header[i];
        unsigned += b;
        signed += b > 127 ? b - 256 : b;
    }
    return stored === unsigned || stored === signed;
}

// "%d key=value\n" records; the length counts the whole record.
export function parsePax(buf) {
    const out = {};
    let p = 0;
    while (p < buf.length) {
        const space = buf.indexOf(0x20, p);
        if (space < 0) break;
        const len = Number(buf.subarray(p, space).toString("latin1"));
        if (!Number.isInteger(len) || len <= space - p || p + len > buf.length) break;
        const record = buf.subarray(space + 1, p + len - 1).toString("utf8"); // drop the trailing "\n"
        const eq = record.indexOf("=");
        if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
        p += len;
    }
    return out;
}

const TYPES = { "0": "file", "\0": "file", "7": "file", "5": "directory", "2": "symlink", "1": "link" };

/**
 * @param {ReadableStream|AsyncIterable<Uint8Array>} source
 * @param {{ baseOffset?: number, skipBytes?: number, maxMetaSize?: number, maxEntrySize?: number }} [options]
 *   baseOffset: added to every reported offset (the stream was opened with a Range request at that byte);
 *   skipBytes: bytes to drop first (a server that ignored the Range request sent the file from byte 0);
 *   allowMissingEnd: accept a stream that stops at an entry boundary without the zero blocks (by default that
 *   throws, so a connection cut cleanly between entries is not mistaken for the whole archive).
 */
export async function* readTar(source, options = {}) {
    const { baseOffset = 0, skipBytes = 0, maxMetaSize = DEFAULT_MAX_META, maxEntrySize = DEFAULT_MAX_ENTRY, allowMissingEnd = false } = options;
    const reader = new ByteReader(source);
    const at = () => baseOffset + reader.position; // skipped bytes count: offsets stay absolute
    let globalPax = {};
    try {
        if (skipBytes > 0) await reader.skip(skipBytes);
        let pending = {}; // overrides for the next real entry from pax "x" / GNU "L"/"K"
        let chainStart = null;
        for (;;) {
            const headerOffset = at();
            const header = await reader.read(BLOCK);
            if (!header) { // the stream ended where a header should be
                if (allowMissingEnd) return;
                throw new Error(`tar: stream ended at byte ${headerOffset} without the end-of-archive marker`);
            }
            if (header.every((b) => b === 0)) return; // end of archive
            if (!checksumOk(header)) throw new Error(`tar: bad header checksum at byte ${headerOffset}`);
            if (chainStart === null) chainStart = headerOffset;
            const flag = String.fromCharCode(header[156]);
            const magic = header.subarray(257, 263).toString("latin1");
            let size = parseNumber(header, 124, 12);

            if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
                if (size > maxMetaSize) throw new Error(`tar: ${flag} header of ${size} bytes is too large`);
                const body = (await reader.read(size)) ?? Buffer.alloc(0);
                if (body.length < size) throw new Error("tar: stream ended inside a header");
                await reader.skip(pad(size));
                if (flag === "x") Object.assign(pending, parsePax(body));
                else if (flag === "g") globalPax = { ...globalPax, ...parsePax(body) };
                else if (flag === "L") pending.path = cstr(body, 0, body.length);
                else pending.linkpath = cstr(body, 0, body.length);
                continue;
            }

            const meta = { ...globalPax, ...pending };
            pending = {};
            let name = cstr(header, 0, 100);
            if (magic === "ustar\0") { // POSIX: the prefix field holds the leading directories
                const prefix = cstr(header, 345, 155);
                if (prefix) name = `${prefix}/${name}`;
            }
            if (meta.path) name = meta.path;
            if (meta.size !== undefined) {
                const s = Number(meta.size);
                if (!Number.isSafeInteger(s) || s < 0) throw new Error(`tar: bad pax size "${meta.size}"`);
                size = s;
            }
            const type = TYPES[flag] ?? "other";
            if ("123456".includes(flag)) size = 0; // links, devices, directories, fifos carry no data
            const dataOffset = at();
            const entry = {
                name,
                type,
                size,
                linkname: meta.linkpath ?? cstr(header, 157, 100),
                mtime: Number(meta.mtime ?? parseNumber(header, 136, 12)),
                headerOffset: chainStart,
                dataOffset,
                endOffset: dataOffset + size + pad(size),
            };
            chainStart = null;
            let consumed = false;
            entry.read = async () => {
                if (consumed) throw new Error("tar: entry already read or skipped");
                if (size > maxEntrySize) throw new Error(`tar: entry "${name}" is ${size} bytes, over the ${maxEntrySize} cap`);
                consumed = true;
                const data = (await reader.read(size)) ?? Buffer.alloc(0);
                if (data.length < size) throw new Error("tar: stream ended inside an entry");
                // copy out so the caller does not pin the network chunk it came in
                return Buffer.from(data);
            };
            yield entry;
            if (!consumed) { consumed = true; await reader.skip(size); }
            await reader.skip(pad(size));
        }
    } finally {
        await reader.close();
    }
}

// A name from a download that is safe to use as a relative path: no "..", no absolute or drive paths, no NUL.
export function safeTarName(name) {
    if (typeof name !== "string" || !name || name.includes("\0")) return null;
    const unified = name.replace(/\\/g, "/");
    if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
    const parts = unified.split("/").filter((p) => p && p !== ".");
    if (!parts.length || parts.some((p) => p === ".." || p.includes(":"))) return null;
    return parts.join("/");
}
