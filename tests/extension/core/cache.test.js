// background/cache.js with the memory backend: .osu and results round trips, the LRU caps (bytes for .osu, count
// for results), the memory layer in front, clear, a failing backend.
import test from "node:test";
import assert from "node:assert/strict";
import { Lru, createCache, memoryBackend } from "../../../extension/background/cache.js";

const clock = (start = 1_000_000) => {
    let t = start;
    return { now: () => t, advance: (ms) => (t += ms) };
};

test("Lru keeps the most recently used", () => {
    const lru = new Lru(2);
    lru.set("a", 1);
    lru.set("b", 2);
    assert.equal(lru.get("a"), 1);
    lru.set("c", 3);
    assert.equal(lru.get("b"), undefined);
    assert.equal(lru.get("a"), 1);
    assert.equal(lru.size, 2);
});

test(".osu entries and results round trip through the backend", async () => {
    const backend = memoryBackend();
    const time = clock();
    const cache = createCache({ backend, now: time.now });
    assert.equal(await cache.getOsu(5), null);
    await cache.putOsu({ beatmapId: 5, md5: "m5", text: "osu file format v14", fetchedAt: 123 });
    const hit = await cache.getOsu(5);
    assert.equal(hit.md5, "m5");
    assert.equal(hit.text, "osu file format v14");
    assert.equal(hit.fetchedAt, 123);
    assert.equal(hit.size, 19);
    await cache.putResult("fp|m5|1.00", { kind: "ok", numeric: 12.6 });
    assert.deepEqual(await cache.getResult("fp|m5|1.00"), { kind: "ok", numeric: 12.6 });
    assert.equal(await cache.getResult("fp|m5|1.20"), null);

    // a new cache over the same backend (the service worker woke up again) finds them
    const again = createCache({ backend, now: time.now });
    assert.equal((await again.getOsu("5")).md5, "m5");
    assert.deepEqual(await again.getResult("fp|m5|1.00"), { kind: "ok", numeric: 12.6 });
    assert.deepEqual(await again.stats(), { osuEntries: 1, osuBytes: 19, results: 1 });

    await again.clear();
    assert.equal(await again.getOsu(5), null);
    assert.equal(await again.getResult("fp|m5|1.00"), null);
    assert.equal(backend.stores.osu.size + backend.stores.results.size, 0);
});

test("the .osu store keeps at most its bytes, dropping the least recently used", async () => {
    const backend = memoryBackend();
    const time = clock();
    const cache = createCache({ backend, now: time.now, osuCapBytes: 250, memOsu: 1 });
    for (const id of [1, 2]) {
        await cache.putOsu({ beatmapId: id, md5: `m${id}`, text: "x".repeat(100) });
        time.advance(60 * 60 * 1000);
    }
    await cache.getOsu(1); // used again: 2 is now the oldest
    time.advance(60 * 60 * 1000);
    await cache.putOsu({ beatmapId: 3, md5: "m3", text: "y".repeat(100) });
    assert.deepEqual([...backend.stores.osu.keys()].sort(), [1, 3]);
    assert.equal(await cache.getOsu(2), null);
    assert.equal((await cache.stats()).osuBytes, 200);
});

test("the results store keeps at most its count", async () => {
    const backend = memoryBackend();
    const time = clock();
    const cache = createCache({ backend, now: time.now, resultCap: 3, memResults: 2 });
    for (let i = 0; i < 5; i += 1) {
        await cache.putResult(`k${i}`, { i });
        time.advance(1000);
    }
    assert.deepEqual([...backend.stores.results.keys()].sort(), ["k2", "k3", "k4"]);
    assert.equal(await cache.getResult("k0"), null);
    assert.deepEqual(await cache.getResult("k2"), { i: 2 });
});

test("a failing backend leaves the memory layer working and reports the errors", async () => {
    const errors = [];
    const broken = new Proxy({}, { get: () => async () => { throw new Error("IndexedDB is gone"); } });
    const cache = createCache({ backend: broken, onError: (what) => errors.push(what) });
    await cache.putOsu({ beatmapId: 9, md5: "m9", text: "abc" });
    assert.equal((await cache.getOsu(9)).md5, "m9");
    await cache.putResult("k", { kind: "too-short" });
    assert.deepEqual(await cache.getResult("k"), { kind: "too-short" });
    assert.equal(await cache.getResult("other"), null);
    assert.ok(errors.length >= 3, errors.join(","));
});
