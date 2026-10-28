// Test zips: entries stored or deflated (node:zlib), optionally with bytes glued in front and the directory offset
// left as if they were not there (as some .osz packers write), or a data descriptor flag.
import { crc32, deflateRawSync } from "node:zlib";

export function makeZip(entries, { prefix = Buffer.alloc(0), keepDeclaredOffset = false, utf8Flag = true } = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data, method = 8 } of entries) {
        const nameBuf = Buffer.from(name, "utf8");
        const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const packed = method === 8 ? deflateRawSync(body) : body;
        const crc = crc32(body);
        const flags = utf8Flag ? 0x0800 : 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, packed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(body.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset + (keepDeclaredOffset ? 0 : prefix.length), 42);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + packed.length;
    }
    const centralSize = centrals.reduce((s, b) => s + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset + (keepDeclaredOffset ? 0 : prefix.length), 16);
    return new Uint8Array(Buffer.concat([prefix, ...locals, ...centrals, end]));
}
