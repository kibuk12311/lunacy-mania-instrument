// The generated-map store in main (mapgen v3): ids are the only handle for saving and locking.
import test from "node:test";
import assert from "node:assert/strict";
import { createGeneratedStore } from "../app/generatedStore.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const entry = (n) => ({ osuText: `osu ${n}`, version: `v${n}`, title: "Song", audioPath: "a.mp3" });

test("put gives a fresh uuid, get and has find the entry", () => {
    const store = createGeneratedStore();
    const a = store.put(entry(1));
    const b = store.put(entry(2));
    assert.match(a, UUID);
    assert.notEqual(a, b);
    assert.equal(store.get(a).osuText, "osu 1");
    assert.equal(store.has(b), true);
});

test("unknown ids are not there", () => {
    const store = createGeneratedStore();
    store.put(entry(1));
    for (const id of ["nope", "", undefined, null, 42, {}]) {
        assert.equal(store.get(id), null, String(id));
        assert.equal(store.has(id), false, String(id));
    }
});

test("the oldest entry is dropped past the limit", () => {
    const store = createGeneratedStore({ max: 3 });
    const ids = [1, 2, 3, 4].map((n) => store.put(entry(n)));
    assert.equal(store.has(ids[0]), false);
    assert.deepEqual(ids.slice(1).map((id) => store.get(id).version), ["v2", "v3", "v4"]);
});

test("reading an entry makes it the newest", () => {
    const store = createGeneratedStore({ max: 3 });
    const [a, b, c] = [1, 2, 3].map((n) => store.put(entry(n)));
    store.get(a);
    const d = store.put(entry(4));
    assert.deepEqual([a, b, c, d].map((id) => store.has(id)), [true, false, true, true]);
});

test("the default limit is 24", () => {
    const store = createGeneratedStore();
    const ids = Array.from({ length: 25 }, (_, n) => store.put(entry(n)));
    assert.equal(store.has(ids[0]), false);
    assert.equal(store.has(ids[1]), true);
    assert.equal(store.has(ids[24]), true);
});
