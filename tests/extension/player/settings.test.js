import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, STORAGE_KEY, clampSettings, loadSettings, saveSettings, snapRate, memoryStorage } from "../../../extension/player/settings.js";
import { RATES } from "../../../extension/shared/rates.js";

test("defaults: D F J K, downscroll, speed 24, 1.0×, offset 0, volume 0.6", () => {
    assert.equal(STORAGE_KEY, "lm.player.v1");
    assert.deepEqual(clampSettings(undefined), { keys: ["KeyD", "KeyF", "KeyJ", "KeyK"], downscroll: true, speed: 24, rate: 1, offsetMs: 0, volume: 0.6 });
    assert.deepEqual(clampSettings("junk"), clampSettings({}));
    assert.deepEqual({ ...DEFAULTS, keys: [...DEFAULTS.keys] }, clampSettings({}));
});

test("clamping and snapping", () => {
    const s = clampSettings({ keys: ["KeyA", "KeyA", "KeyB", "KeyC"], downscroll: "no", speed: 99, rate: 1.23, offsetMs: -1000, volume: 3 });
    assert.deepEqual(s, { keys: ["KeyD", "KeyF", "KeyJ", "KeyK"], downscroll: true, speed: 40, rate: 1.25, offsetMs: -300, volume: 1 });
    assert.equal(clampSettings({ speed: 2 }).speed, 10);
    assert.equal(clampSettings({ speed: 17.6 }).speed, 18);
    assert.equal(clampSettings({ offsetMs: 300.4 }).offsetMs, 300);
    assert.equal(clampSettings({ offsetMs: "12" }).offsetMs, 12);
    assert.equal(clampSettings({ offsetMs: null }).offsetMs, 0);
    assert.equal(clampSettings({ volume: -1 }).volume, 0);
    assert.equal(clampSettings({ downscroll: false }).downscroll, false);
    assert.deepEqual(clampSettings({ keys: ["KeyS", "KeyD", "KeyK", "KeyL"] }).keys, ["KeyS", "KeyD", "KeyK", "KeyL"]);
    assert.equal(snapRate(0.1), 0.8);
    assert.equal(snapRate(1.9), 1.5);
    assert.equal(snapRate("abc"), null);
    for (const r of RATES) assert.equal(snapRate(r), r);
});

test("load and save through a chrome.storage.local-like store", async () => {
    const store = memoryStorage({ [STORAGE_KEY]: { speed: 30, rate: 1.1, keys: ["KeyS", "KeyD", "KeyK", "KeyL"] } });
    const s = await loadSettings(store);
    assert.equal(s.speed, 30);
    assert.equal(s.rate, 1.1);
    assert.deepEqual(s.keys, ["KeyS", "KeyD", "KeyK", "KeyL"]);
    const saved = await saveSettings(store, { ...s, offsetMs: 999 });
    assert.equal(saved.offsetMs, 300);
    assert.equal(store.data[STORAGE_KEY].offsetMs, 300);
    // broken storage: defaults, and saving does not throw
    const broken = { get: async () => { throw new Error("context invalidated"); }, set: async () => { throw new Error("x"); } };
    assert.deepEqual(await loadSettings(broken), clampSettings({}));
    assert.equal((await saveSettings(broken, { speed: 12 })).speed, 12);
    assert.deepEqual(await loadSettings(null), clampSettings({}));
});
