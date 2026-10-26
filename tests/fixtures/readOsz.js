// Reads an .osz (zip) for tests: name → Buffer, from the central directory (stored and deflated entries).
import { inflateRawSync } from "node:zlib";

export function readOsz(buffer) {
    const buf = Buffer.from(buffer);
    let end = buf.length - 22;
    while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
    if (end < 0) throw new Error("no end of central directory");
    const count = buf.readUInt16LE(end + 10);
    let at = buf.readUInt32LE(end + 16);
    const files = new Map();
    for (let i = 0; i < count; i += 1) {
        if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central entry ${i}`);
        const method = buf.readUInt16LE(at + 10);
        const size = buf.readUInt32LE(at + 20);
        const nameLength = buf.readUInt16LE(at + 28);
        const extraLength = buf.readUInt16LE(at + 30);
        const commentLength = buf.readUInt16LE(at + 32);
        const local = buf.readUInt32LE(at + 42);
        const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
        const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(dataAt, dataAt + size);
        files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
        at += 46 + nameLength + extraLength + commentLength;
    }
    return files;
}

// the .osu texts of an .osz, by entry name
export const osuTexts = (files) => new Map([...files].filter(([name]) => name.endsWith(".osu")).map(([name, data]) => [name, data.toString("utf8")]));
