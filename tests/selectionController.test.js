import test from "node:test";
import assert from "node:assert/strict";
import { createSelectionController } from "../app/selectionController.js";
import { setLang, getLang } from "../src/i18n/i18n.js";
import { cacheKey } from "../src/core/cache.js";

function memoryCache() {
    const m = new Map();
    return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
}

const flush = () => new Promise((r) => setImmediate(r));

function setup({ analyze, files = { A: "text-A", B: "text-B" } } = {}) {
    const views = [];
    let clock = 0;
    const current = { checksum: null };
    const calls = [];
    const controller = createSelectionController({
        fetchOsu: async () => files[current.checksum],
        analyze: analyze ?? (async (text, rate) => { calls.push([text, rate]); return { kind: "ok", text, rate }; }),
        cache: memoryCache(),
        now: () => clock,
        onView: (v) => views.push(v),
    });
    const frame = (checksum, rate = 1, state = "songselect") => {
        current.checksum = checksum;
        controller.onFrame({ state, checksum, rate, mods: [] });
    };
    return { controller, views, calls, frame, advance: (ms) => { clock += ms; controller.tick(); }, last: () => views.at(-1) };
}

test("latest selection wins when an older analysis finishes later", async () => {
    const pending = {};
    const { frame, last } = setup({
        analyze: (text) => new Promise((resolve) => { pending[text] = () => resolve({ kind: "ok", text }); }),
    });
    frame("A");
    await flush();
    frame("B");
    await flush();
    pending["text-B"]();
    await flush();
    pending["text-A"]();
    await flush();
    assert.equal(last().screen, "result");
    assert.equal(last().result.text, "text-B");
});

test("rate change re-analyses the same chart", async () => {
    const { frame, calls } = setup();
    frame("A", 1);
    await flush();
    frame("A", 1.5);
    await flush();
    assert.deepEqual(calls, [["text-A", 1], ["text-A", 1.5]]);
});

test("returning to a chart uses the cache", async () => {
    const { frame, calls, last } = setup();
    frame("A");
    await flush();
    frame("B");
    await flush();
    frame("A");
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(last().result.text, "text-A");
});

test("playing keeps the last result and does not analyse", async () => {
    const { frame, calls, last } = setup();
    frame("A");
    await flush();
    frame("B", 1, "playing");
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(last().result.text, "text-A");
});

test("10 s without a beatmap while connected shows the update hint", async () => {
    const { controller, frame, advance, last } = setup();
    controller.onTosuStatus("connected");
    frame(null, 1, "songselect");
    advance(9000);
    assert.notEqual(last()?.screen, "osu-updated");
    advance(1000);
    assert.equal(last().screen, "osu-updated");
});

test("tosu down before any frame shows waiting", () => {
    const { controller, last } = setup();
    controller.onTosuStatus("down");
    assert.deepEqual(last(), { screen: "waiting-osu" });
});

test("tosu failure is shown with its reason", () => {
    const { controller, last } = setup();
    controller.onTosuFailed("порт занят");
    assert.deepEqual(last(), { screen: "tosu-failed", reason: "порт занят" });
});

test("fetch failure becomes an error result", async () => {
    const { frame, last } = setup({ files: {} });
    frame("missing");
    await flush();
    assert.equal(last().screen, "result");
    assert.equal(last().result.kind, "error");
});

test("a failed fetch is retried on a later frame after 2 s", async () => {
    let attempts = 0;
    const views = [];
    let clock = 0;
    const c = createSelectionController({
        fetchOsu: async () => { attempts += 1; if (attempts === 1) throw new Error("tosu вернул 500"); return "text-A"; },
        analyze: async (text) => ({ kind: "ok", text }),
        cache: memoryCache(),
        now: () => clock,
        onView: (v) => views.push(v),
    });
    const frame = { state: "songselect", checksum: "A", rate: 1, mods: [] };
    c.onFrame(frame);
    await flush();
    assert.equal(views.at(-1).result.kind, "error");
    clock = 1000;
    c.onFrame(frame);
    await flush();
    assert.equal(attempts, 1);
    clock = 2500;
    c.onFrame(frame);
    await flush();
    assert.equal(attempts, 2);
    assert.equal(views.at(-1).result.text, "text-A");
});

test("a deterministic analysis error is not re-analysed on every frame", async () => {
    let analyses = 0;
    let clock = 0;
    const views = [];
    const c = createSelectionController({
        fetchOsu: async () => "text-A",
        analyze: async () => { analyses += 1; return { kind: "error", message: "ни один калькулятор не смог посчитать карту" }; },
        cache: memoryCache(), now: () => clock, onView: (v) => views.push(v),
    });
    const frame = { state: "songselect", checksum: "A", rate: 1, mods: [] };
    for (let i = 0; i < 5; i += 1) {
        c.onFrame(frame);
        await flush();
        clock += 3000;
    }
    assert.equal(analyses, 1);
});

test("stale selection is dropped before analysis", async () => {
    const analysed = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const files = { A: "text-A", B: "text-B" };
    let currentChecksum = null;
    const c = createSelectionController({
        fetchOsu: async () => { const t = files[currentChecksum]; await gate; return t; },
        analyze: async (text) => { analysed.push(text); return { kind: "ok", text }; },
        cache: memoryCache(), onView: () => {},
    });
    currentChecksum = "A";
    c.onFrame({ state: "songselect", checksum: "A", rate: 1, mods: [] });
    currentChecksum = "B";
    c.onFrame({ state: "songselect", checksum: "B", rate: 1, mods: [] });
    release();
    await flush();
    await flush();
    assert.deepEqual(analysed, ["text-B"]);
});

test("result comes back after the update hint when the same map returns", async () => {
    const { controller, frame, advance, last } = setup();
    controller.onTosuStatus("connected");
    frame("A");
    await flush();
    frame(null);
    advance(10000);
    assert.equal(last().screen, "osu-updated");
    frame("A");
    await flush();
    assert.equal(last().screen, "result");
    assert.equal(last().result.text, "text-A");
});

test("transient errors back off instead of retrying every 2 s forever", async () => {
    let attempts = 0;
    let clock = 0;
    const c = createSelectionController({
        fetchOsu: async () => { attempts += 1; throw new Error("tosu вернул 500"); },
        analyze: async () => ({ kind: "ok" }),
        cache: memoryCache(), now: () => clock, onView: () => {},
    });
    const frame = { state: "songselect", checksum: "A", rate: 1, mods: [] };
    for (let t = 0; t <= 60000; t += 500) {
        clock = t;
        c.onFrame(frame);
        await flush();
    }
    assert.ok(attempts >= 3 && attempts <= 7, `attempts ${attempts}`);
});

test("after a language switch an error is worked out again in the new language, a result is not", async () => {
    let analyses = 0;
    const views = [];
    const files = { A: "text-A", B: "text-B" };
    let selected = "A";
    const c = createSelectionController({
        fetchOsu: async () => files[selected],
        analyze: async (text) => {
            analyses += 1;
            if (text === "text-B") return { kind: "ok", text };
            return { kind: "error", message: getLang() === "en" ? "no calculator could rate this map" : "ни один калькулятор не смог посчитать карту" };
        },
        cache: memoryCache(), onView: (v) => views.push(v),
    });
    const frame = (checksum) => { selected = checksum; c.onFrame({ state: "songselect", checksum, rate: 1, mods: [] }); };
    try {
        frame("A");
        await flush();
        assert.equal(views.at(-1).result.message, "ни один калькулятор не смог посчитать карту");
        setLang("en");
        frame("A");
        await flush();
        assert.equal(views.at(-1).result.message, "no calculator could rate this map");
        frame("A");
        await flush();
        assert.equal(analyses, 2, "once per language");

        frame("B");
        await flush();
        setLang("ru");
        frame("B");
        await flush();
        assert.equal(analyses, 3, "a finished result needs no new run");
        assert.equal(views.at(-1).result.text, "text-B");
    } finally {
        setLang("ru");
    }
});

test("the map file error is in English when the app is", async () => {
    const views = [];
    const c = createSelectionController({ fetchOsu: async () => "", analyze: async () => ({ kind: "ok" }), cache: memoryCache(), onView: (v) => views.push(v) });
    setLang("en");
    try {
        c.onFrame({ state: "songselect", checksum: "A", rate: 1, mods: [] });
        await flush();
        assert.deepEqual(views.at(-1), { screen: "result", result: { kind: "error", message: "couldn't get the map file", transient: true } });
    } finally {
        setLang("ru");
    }
});

// ---- onResult: the "result" hook for the tabs (fresh results only) ----

function withResults({ analyze, files = { A: "text-A", B: "text-B" } } = {}) {
    const results = [];
    const views = [];
    let clock = 0;
    const current = { checksum: null };
    const controller = createSelectionController({
        fetchOsu: async () => files[current.checksum],
        analyze: analyze ?? (async (text, rate) => ({ kind: "ok", text, rate })),
        cache: memoryCache(),
        now: () => clock,
        onView: (v) => views.push(v),
        onResult: (r) => results.push(r),
    });
    const frame = (checksum, rate = 1, state = "songselect") => {
        current.checksum = checksum;
        controller.onFrame({ state, checksum, rate, mods: [] });
    };
    return { controller, results, views, frame, advance: (ms) => { clock += ms; controller.tick(); } };
}

test("onResult gets every fresh result once, cache hits and errors included", async () => {
    const { frame, results, views } = withResults({
        analyze: async (text, rate) => (text === "text-B" ? { kind: "error", message: "не рис" } : { kind: "ok", text, rate }),
    });
    frame("A", 1.2);
    await flush();
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], { key: cacheKey("text-A", 1.2), text: "text-A", rate: 1.2, result: { kind: "ok", text: "text-A", rate: 1.2 } });
    frame("B");
    await flush();
    frame("A", 1.2); // from the cache
    await flush();
    assert.deepEqual(results.map((r) => [r.text, r.result.kind]), [["text-A", "ok"], ["text-B", "error"], ["text-A", "ok"]]);
    assert.equal(results[2].key, cacheKey("text-A", 1.2));
    assert.equal(views.at(-1).key, cacheKey("text-A", 1.2));
});

test("a request overtaken by a newer selection does not call onResult", async () => {
    const pending = {};
    const { frame, results } = withResults({
        analyze: (text) => new Promise((resolve) => { pending[text] = () => resolve({ kind: "ok", text }); }),
    });
    frame("A");
    await flush();
    frame("B");
    await flush();
    pending["text-A"]();
    await flush();
    assert.equal(results.length, 0);
    pending["text-B"]();
    await flush();
    assert.deepEqual(results.map((r) => r.text), ["text-B"]);
});

test("showing the same result again does not call onResult", async () => {
    const { controller, frame, results, advance } = withResults();
    controller.onTosuStatus("connected");
    frame("A");
    await flush();
    frame("A");
    await flush();
    frame(null);
    advance(10000);
    frame("A"); // back from the update hint: the kept result is shown again
    await flush();
    assert.equal(results.length, 1);
});

test("the result view carries the key; a file that could not be read has none", async () => {
    const { frame, views, results } = withResults({ files: { A: "text-A" } });
    frame("A", 1.5);
    await flush();
    assert.deepEqual(views.at(-1), { screen: "result", result: { kind: "ok", text: "text-A", rate: 1.5 }, key: cacheKey("text-A", 1.5) });
    frame("missing");
    await flush();
    assert.equal("key" in views.at(-1), false);
    assert.equal(results.at(-1).key, null);
    assert.equal(results.at(-1).result.kind, "error");
});

test("an onResult that throws does not break the controller", async () => {
    const views = [];
    const c = createSelectionController({
        fetchOsu: async () => "text-A", analyze: async (text) => ({ kind: "ok", text }), cache: memoryCache(),
        onView: (v) => views.push(v), onResult: () => { throw new Error("boom"); },
    });
    c.onFrame({ state: "songselect", checksum: "A", rate: 1, mods: [] });
    await flush();
    assert.equal(views.at(-1).screen, "result");
});
