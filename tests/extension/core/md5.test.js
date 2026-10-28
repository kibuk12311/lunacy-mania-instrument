// shared/md5.js against node:crypto: empty input, block edges, a real-size .osu, strings as UTF-8.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { md5Hex } from "../../../extension/shared/md5.js";
import { makeChart } from "../../fixtures/makeChart.js";

const node = (data) => createHash("md5").update(data).digest("hex");

test("md5Hex equals node:crypto on every length around the 64-byte blocks and on random data", () => {
    for (let n = 0; n <= 200; n += 1) {
        const bytes = new Uint8Array(randomBytes(n));
        assert.equal(md5Hex(bytes), node(bytes), `length ${n}`);
    }
    const big = new Uint8Array(randomBytes(1_000_003));
    assert.equal(md5Hex(big), node(big));
});

test("md5Hex of a chart's bytes is osu!'s checksum; strings count as UTF-8", () => {
    const text = makeChart({ kind: "jumpstream", seconds: 30 });
    const bytes = new TextEncoder().encode(text);
    assert.equal(md5Hex(bytes), node(Buffer.from(text, "utf8")));
    assert.equal(md5Hex("Версия ★"), node(Buffer.from("Версия ★", "utf8")));
    assert.equal(md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e");
    assert.equal(md5Hex(bytes.buffer), md5Hex(bytes), "an ArrayBuffer too");
});
