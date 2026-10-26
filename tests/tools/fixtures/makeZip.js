// Zips written byte by byte for the tests of tools/lib/zip.mjs and the Etterna fetcher: stored or deflated
// entries, optional ZIP64 records, junk glued in front (a wrong directory offset), raw name bytes.
import { crc32, deflateRawSync } from "node:zlib";

// entries: [{ name (string or Buffer), data, method = 8, utf8 = true, crc, size, descriptor }]
// opts: { zip64 = false, prefix = Buffer (bytes glued in front without fixing any offset) }
export function makeZip(entries, { zip64 = false, prefix = null } = {}) {
    const chunks = [];
    const centrals = [];
    let offset = 0;
    const push = (buf) => {
        chunks.push(buf);
        offset += buf.length;
    };
    for (const e of entries) {
        const nameBuf = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, "utf8");
        const body = Buffer.from(e.data ?? "");
        const method = e.method ?? 8;
        const packed = method === 8 ? deflateRawSync(body) : body;
        const crc = e.crc ?? crc32(body);
        const size = e.size ?? body.length;
        const flags = (e.utf8 === false ? 0 : 0x800) | (e.descriptor ? 0x8 : 0);
        const localOffset = offset;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(zip64 ? 45 : 20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(e.descriptor ? 0 : crc, 14);
        local.writeUInt32LE(e.descriptor ? 0 : packed.length, 18);
        local.writeUInt32LE(e.descriptor ? 0 : size, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        push(Buffer.concat([local, nameBuf, packed]));
        if (e.descriptor) {
            const dd = Buffer.alloc(16);
            dd.writeUInt32LE(0x08074b50, 0);
            dd.writeUInt32LE(crc, 4);
            dd.writeUInt32LE(packed.length, 8);
            dd.writeUInt32LE(size, 12);
            push(dd);
        }
        let extra = Buffer.alloc(0);
        if (zip64) {
            extra = Buffer.alloc(28);
            extra.writeUInt16LE(0x0001, 0);
            extra.writeUInt16LE(24, 2);
            extra.writeBigUInt64LE(BigInt(size), 4);
            extra.writeBigUInt64LE(BigInt(packed.length), 12);
            extra.writeBigUInt64LE(BigInt(localOffset), 20);
        }
        if (e.extra) extra = Buffer.concat([extra, e.extra]);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(zip64 ? 45 : 20, 4);
        central.writeUInt16LE(zip64 ? 45 : 20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20);
        central.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(extra.length, 30);
        central.writeUInt32LE(zip64 ? 0xffffffff : localOffset, 42);
        centrals.push(Buffer.concat([central, nameBuf, extra]));
    }
    const cdOffset = offset;
    const cd = Buffer.concat(centrals);
    push(cd);
    if (zip64) {
        const rec = Buffer.alloc(56);
        const recOffset = offset;
        rec.writeUInt32LE(0x06064b50, 0);
        rec.writeBigUInt64LE(44n, 4);
        rec.writeUInt16LE(45, 12);
        rec.writeUInt16LE(45, 14);
        rec.writeBigUInt64LE(BigInt(entries.length), 24);
        rec.writeBigUInt64LE(BigInt(entries.length), 32);
        rec.writeBigUInt64LE(BigInt(cd.length), 40);
        rec.writeBigUInt64LE(BigInt(cdOffset), 48);
        push(rec);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0);
        loc.writeBigUInt64LE(BigInt(recOffset), 8);
        loc.writeUInt32LE(1, 16);
        push(loc);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
    eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
    eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
    eocd.writeUInt32LE(zip64 ? 0xffffffff : cdOffset, 16);
    push(eocd);
    return Buffer.concat(prefix ? [prefix, ...chunks] : chunks);
}
