// shared/transfer.js: base64 round trips of any bytes, and the chunker's exact piece sizes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CHUNK_BYTES, base64Chunks, base64ToBytes, bytesToBase64, concatBytes, createChunker } from "../../../extension/shared/transfer.js";

test("bytesToBase64 / base64ToBytes round trip and equal Buffer's base64", () => {
    for (const n of [0, 1, 2, 3, 4, 0x7fff, 0x8000, 0x8001, 300_001]) {
        const bytes = new Uint8Array(randomBytes(n));
        const text = bytesToBase64(bytes);
        assert.equal(text, Buffer.from(bytes).toString("base64"));
        assert.deepEqual(base64ToBytes(text), bytes);
    }
    assert.deepEqual(base64ToBytes(""), new Uint8Array(0));
});

test("the chunker gives pieces of exactly the size asked, the rest on flush, nothing lost", () => {
    const chunker = createChunker(10);
    const input = new Uint8Array(randomBytes(57));
    const out = [];
    for (let i = 0; i < input.length; i += 7) out.push(...chunker.push(input.subarray(i, i + 7)));
    assert.ok(out.every((p) => p.length === 10));
    assert.equal(out.length, 5);
    assert.equal(chunker.held, 7);
    out.push(chunker.flush());
    assert.equal(chunker.held, 0);
    assert.equal(chunker.flush().length, 0);
    assert.deepEqual(concatBytes(out), input);
});

test("base64Chunks: at most 1 MiB of bytes per piece", () => {
    assert.equal(CHUNK_BYTES, 1024 * 1024);
    const bytes = new Uint8Array(randomBytes(CHUNK_BYTES * 2 + 5));
    const pieces = [...base64Chunks(bytes)];
    assert.equal(pieces.length, 3);
    assert.deepEqual(concatBytes(pieces.map(base64ToBytes)), bytes);
    assert.ok(pieces.every((p) => base64ToBytes(p).length <= CHUNK_BYTES));
});
