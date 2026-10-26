import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCache, cacheKey } from "../src/core/cache.js";

test("cache key depends on rate", () => {
    assert.notEqual(cacheKey("same text", 1), cacheKey("same text", 1.5));
    assert.equal(cacheKey("same text", 1), cacheKey("same text", 1.0));
});

test("disk cache survives re-creation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "кеш "));
    const a = createCache({ dir });
    await a.set("k1", { kind: "too-short" });
    const b = createCache({ dir });
    assert.deepEqual(await b.get("k1"), { kind: "too-short" });
    assert.equal(await b.get("missing"), undefined);
});

test("memory cache evicts beyond max", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "кеш "));
    const c = createCache({ dir, max: 2 });
    await c.set("a", 1);
    await c.set("b", 2);
    await c.set("c", 3);
    assert.equal(c.memorySize(), 2);
    assert.equal(await c.get("a"), 1);
});
