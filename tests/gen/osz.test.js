import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { buildOsz } from "../../src/gen/osz.js";
import { envelopeFromTransfer, envelopeToTransfer } from "../../src/audio/onset.js";

function readZip(buf) {
    const files = {};
    let p = 0;
    while (buf.readUInt32LE(p) === 0x04034b50) {
        const method = buf.readUInt16LE(p + 8);
        const crc = buf.readUInt32LE(p + 14);
        const size = buf.readUInt32LE(p + 18);
        const nameLen = buf.readUInt16LE(p + 26);
        const extraLen = buf.readUInt16LE(p + 28);
        const name = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
        const data = buf.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size);
        files[name] = { method, crc, data };
        p += 30 + nameLen + extraLen + size;
    }
    return { files, centralAt: p };
}

test("osz is a stored zip with valid CRCs and UTF-8 names", () => {
    const osu = Buffer.from("osu file format v14\r\n", "utf8");
    const audio = Buffer.from([1, 2, 3, 4, 5]);
    const zip = buildOsz([{ name: "Песня [Gamma mid].osu", data: osu }, { name: "audio.mp3", data: audio }]);
    const { files, centralAt } = readZip(zip);
    assert.deepEqual(Object.keys(files), ["Песня [Gamma mid].osu", "audio.mp3"]);
    assert.equal(files["audio.mp3"].method, 0);
    assert.equal(files["audio.mp3"].crc, crc32(audio));
    assert.deepEqual(files["Песня [Gamma mid].osu"].data, osu);
    assert.equal(zip.readUInt32LE(centralAt), 0x02014b50);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});

test("envelope survives transfer between processes", () => {
    const env = { values: new Float32Array([0, 0.5, 1]), hopSec: 0.01, frameTimeSec: (f) => f * 0.01 + 0.03 };
    const back = envelopeFromTransfer(structuredClone(envelopeToTransfer(env)));
    assert.equal(back.frameTimeSec(2), env.frameTimeSec(2));
    assert.deepEqual(Array.from(back.values), [0, 0.5, 1]);
});
