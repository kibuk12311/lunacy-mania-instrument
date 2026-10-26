// The create tab's channels in main (mapgen v3): generate-map checks everything it is sent, resolves a lock against
// the store, forwards progress, keeps the map in the store and writes no file; detect-timing goes to the worker.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerCreateIpc } from "../app/createIpc.js";
import { createGeneratedStore } from "../app/generatedStore.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const osuWithRows = (times) => `osu file format v14\n\n[HitObjects]\n${times.map((t, i) => `${64 + 128 * (i % 4)},192,${t},1,0,0:0:0:0:`).join("\n")}\n`;

// A valid request, changed by `over` (request fields) and `top` (top-level fields).
function request({ over = {}, top = {} } = {}) {
    return {
        jobId: "job-1",
        audioPath: "C:/songs/song.mp3",
        title: "Song",
        durationMs: 120_000,
        envelope: { values: new Float32Array(8), energy: new Float32Array(8), hopSec: 0.0116, frameOffsetSec: 0.01 },
        timing: { sections: [{ timeMs: 312, bpm: 174, meter: 4 }], bpm: 174, offsetMs: 312 },
        ...top,
        request: {
            range: { lo: 12.5, hi: 14.5 },
            patterns: [{ name: "Jumpstream", share: 0.7 }, { name: "Chordjack", share: 0.3 }],
            mix: "sections", stamina: 0.5, burst: 0.3, seed: 3,
            ...over,
        },
    };
}

const PARTS = [
    { startMs: 0, endMs: 1500, kind: "intro" },
    { startMs: 1500, endMs: 5000, kind: "drop" },
    { startMs: 5000, endMs: 120_000, kind: "outro" },
];

// The styles per model choice, as app/modelStyles.js answers them (0.9.5): the classic model has none.
const STYLES_BY_SIZE = {
    auto: [],
    xgb3: [{ key: "mapperA", name: "Mapper A", user: null, maps: 40 }],
    s: [{ key: "mapperA", name: "Mapper A", user: null, maps: 40 }, { key: "u:77", name: null, user: "77", maps: 12 }],
    m: [{ key: "mapperA", name: "Mapper A", user: null, maps: 40 }],
    l: [],
};
const fakeCatalog = (by = STYLES_BY_SIZE) => ({ calls: 0, async bySize() { this.calls += 1; if (by instanceof Error) throw by; return by; } });

function setup({ answer, styleCatalog = fakeCatalog() } = {}) {
    const handlers = {};
    const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; }, on: (channel, fn) => { handlers[channel] = fn; } };
    const sent = [];
    const event = { sender: { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false } };
    const calls = { generate: [], timing: [] };
    const generatorClient = {
        async generate(payload, onProgress) {
            calls.generate.push(payload);
            onProgress?.({ phase: "prepare", i: 1, n: 3 });
            onProgress?.({ phase: "partSearch", i: 2, n: 3, kind: "drop" });
            if (answer) return answer(payload);
            return {
                kind: "generated", osuText: osuWithRows([1000, 2000, 3000, 4000, 6000]), version: "Gamma mid Jumpstream",
                result: { kind: "ok", numeric: 13.1, label: "Gamma mid" }, reachable: true, noteCount: 5, patternScore: 0.8,
                offset: -1.25, engine: "learned", modelInfo: { kind: "xgb-v1", grid: "q4", maps: 6326 },
            };
        },
        async detectTiming(payload) {
            calls.timing.push(payload);
            return { kind: "timing", timing: { sections: [{ timeMs: 10, bpm: 128, meter: 4 }], bpm: 128, offsetMs: 10 }, modelInfo: { kind: "rules", grid: "q4", maps: 0 } };
        },
    };
    const generatedStore = createGeneratedStore();
    const logs = [];
    registerCreateIpc({ ipcMain, generatorClient, generatedStore, log: (line) => logs.push(line), styleCatalog });
    const generate = (req) => handlers["generate-map"](event, req);
    const detect = (req) => handlers["detect-timing"](event, req);
    return { handlers, generate, detect, sent, calls, generatedStore, logs };
}

test("registers generate-map, detect-timing, generator-info and the ratings channels, and nothing else", () => {
    const { handlers } = setup();
    assert.deepEqual(Object.keys(handlers).sort(), ["detect-timing", "generate-map", "generator-info", "rate-variant", "ratings-export", "ratings-summary"]);
});

test("a good request goes to the worker and comes back as a stored id, with no file", async () => {
    const { generate, calls, generatedStore } = setup();
    const answer = await generate(request());
    assert.equal(answer.ok, true);
    assert.match(answer.id, UUID);
    assert.equal(answer.file, undefined);
    assert.equal(answer.engine, "learned");
    assert.deepEqual(answer.modelInfo, { kind: "xgb-v1", grid: "q4", maps: 6326 });
    assert.equal(answer.version, "Gamma mid Jumpstream");
    assert.equal(answer.result.numeric, 13.1);
    assert.equal(answer.reachable, true);
    assert.deepEqual(answer.range, { lo: 12.5, hi: 14.5 });
    assert.equal(answer.noteCount, 5);
    assert.equal(answer.patternScore, 0.8);
    assert.equal(answer.knob, -1.25);
    assert.equal(answer.planSeed, 3);
    assert.equal(answer.noteSeed, 3);
    assert.deepEqual(answer.issues, []);
    assert.deepEqual(answer.parts, []);
    assert.deepEqual(answer.retries, { blocks: 0, dan: null });
    assert.deepEqual(answer.grid, { 4: 1, 3: 0, 6: 0, 8: 0 });
    assert.ok(Number.isInteger(answer.ms) && answer.ms >= 0);
    assert.ok(answer.osuText.includes("[HitObjects]"));

    const [payload] = calls.generate;
    assert.deepEqual(payload.meta, { title: "Song", audioFilename: "audio.mp3" });
    assert.deepEqual(payload.timing, { sections: [{ timeMs: 312, bpm: 174, meter: 4 }], bpm: 174, offsetMs: 312 });
    assert.equal(payload.durationMs, 120_000);
    assert.equal(payload.request.seed, 3);
    assert.equal("lock" in payload.request, false);
    assert.equal("locked" in payload, false);

    const stored = generatedStore.get(answer.id);
    assert.equal(stored.osuText, answer.osuText);
    assert.equal(stored.audioPath, "C:/songs/song.mp3");
    assert.equal(stored.title, "Song");
    assert.equal(stored.version, "Gamma mid Jumpstream");
    assert.equal(stored.knob, -1.25);
    assert.equal(stored.engine, "learned");
    assert.deepEqual(stored.timing.sections, [{ timeMs: 312, bpm: 174, meter: 4 }]);
});

test("generating writes no file anywhere near the maps folder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "create-ipc-"));
    const handlers = {};
    const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} };
    const generatorClient = { generate: async () => ({ kind: "generated", osuText: "osu", version: "v", result: { kind: "ok", numeric: 1 } }) };
    registerCreateIpc({ ipcMain, generatorClient, generatedStore: createGeneratedStore(), log() {}, paths: { mapsDir: dir, docsDir: dir } });
    const answer = await handlers["generate-map"]({ sender: { send() {} } }, request());
    assert.equal(answer.ok, true);
    assert.deepEqual(await readdir(dir), []);
});

test("the old {bpm, offsetMs} timing becomes one section", async () => {
    const { generate, calls } = setup();
    const answer = await generate(request({ top: { timing: { bpm: 180, offsetMs: 400 } } }));
    assert.equal(answer.ok, true);
    assert.deepEqual(calls.generate[0].timing, { sections: [{ timeMs: 400, bpm: 180, meter: 4 }], bpm: 180, offsetMs: 400 });
});

test("several sections keep their order and the mirrors follow the first", async () => {
    const { generate, calls } = setup();
    const sections = [{ timeMs: 100, bpm: 140, meter: 4 }, { timeMs: 20_000.4, bpm: 180.5, meter: 3 }];
    await generate(request({ top: { timing: { sections } } }));
    assert.deepEqual(calls.generate[0].timing, { sections, bpm: 140, offsetMs: 100 });
});

test("progress goes to the window with the job id", async () => {
    const { generate, sent } = setup();
    await generate(request());
    assert.deepEqual(sent, [
        { channel: "generate-progress", payload: { jobId: "job-1", phase: "prepare", i: 1, n: 3 } },
        { channel: "generate-progress", payload: { jobId: "job-1", phase: "partSearch", i: 2, n: 3, kind: "drop" } },
    ]);
});

test("a window that is gone does not break the job", async () => {
    const handlers = {};
    const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} };
    const generatorClient = { generate: async (_p, onProgress) => { onProgress({ phase: "search", i: 1, n: 1 }); return { kind: "generated", osuText: "o", version: "v", result: {} }; } };
    registerCreateIpc({ ipcMain, generatorClient, generatedStore: createGeneratedStore(), log() {} });
    const destroyed = { sender: { isDestroyed: () => true, send() { throw new Error("destroyed"); } } };
    assert.equal((await handlers["generate-map"](destroyed, request())).ok, true);
    const throwing = { sender: { send() { throw new Error("gone"); } } };
    assert.equal((await handlers["generate-map"](throwing, request())).ok, true);
});

// [what the window sent, the field the message names]
const BAD = [
    ["not an object", () => null, "request"],
    ["no audio path", () => request({ top: { audioPath: "" } }), "audioPath"],
    ["no duration", () => request({ top: { durationMs: 0 } }), "durationMs"],
    ["no envelope", () => request({ top: { envelope: null } }), "envelope"],
    ["envelope without hop", () => request({ top: { envelope: { values: new Float32Array(2) } } }), "envelope"],
    ["a bad job id", () => request({ top: { jobId: 7 } }), "jobId"],
    ["no timing", () => request({ top: { timing: null } }), "timing"],
    ["no sections", () => request({ top: { timing: { sections: [] } } }), "timing.sections"],
    ["257 sections", () => request({ top: { timing: { sections: Array.from({ length: 257 }, (_, i) => ({ timeMs: i * 100, bpm: 120, meter: 4 })) } } }), "timing.sections"],
    ["unsorted sections", () => request({ top: { timing: { sections: [{ timeMs: 500, bpm: 120, meter: 4 }, { timeMs: 500, bpm: 130, meter: 4 }] } } }), "timing.sections[1].timeMs"],
    ["a section before the song", () => request({ top: { timing: { sections: [{ timeMs: -1, bpm: 120, meter: 4 }] } } }), "timing.sections[0].timeMs"],
    ["a section after the song", () => request({ top: { timing: { sections: [{ timeMs: 0, bpm: 120, meter: 4 }, { timeMs: 120_000, bpm: 120, meter: 4 }] } } }), "timing.sections[1].timeMs"],
    ["bpm 39", () => request({ top: { timing: { sections: [{ timeMs: 0, bpm: 39, meter: 4 }] } } }), "timing.sections[0].bpm"],
    ["bpm 401", () => request({ top: { timing: { sections: [{ timeMs: 0, bpm: 401, meter: 4 }] } } }), "timing.sections[0].bpm"],
    ["meter 0", () => request({ top: { timing: { sections: [{ timeMs: 0, bpm: 120, meter: 0 }] } } }), "timing.sections[0].meter"],
    ["meter 17", () => request({ top: { timing: { sections: [{ timeMs: 0, bpm: 120, meter: 17 }] } } }), "timing.sections[0].meter"],
    ["meter 3.5", () => request({ top: { timing: { sections: [{ timeMs: 0, bpm: 120, meter: 3.5 }] } } }), "timing.sections[0].meter"],
    ["no request", () => ({ ...request(), request: null }), "request"],
    ["no range or target", () => request({ over: { range: undefined } }), "request.range"],
    ["range upside down", () => request({ over: { range: { lo: 14, hi: 13 } } }), "request.range"],
    ["range past 21", () => request({ over: { range: { lo: 20, hi: 21.5 } } }), "request.range"],
    ["no patterns", () => request({ over: { patterns: [] } }), "request.patterns"],
    ["an unknown pattern", () => request({ over: { patterns: [{ name: "Rolls", share: 1 }] } }), "request.patterns[0].name"],
    ["a negative share", () => request({ over: { patterns: [{ name: "Stream", share: -1 }] } }), "request.patterns[0].share"],
    ["a kind of another family", () => request({ over: { patterns: [{ name: "Stream", share: 1, flavours: ["Gluts"] }] } }), "request.patterns[0].flavours"],
    ["an unknown kind", () => request({ over: { patterns: [{ name: "Stream", share: 1, flavours: ["Bursts"] }] } }), "request.patterns[0].flavours"],
    ["the same kind twice", () => request({ over: { patterns: [{ name: "Stream", share: 1, flavours: ["Rolls", "Rolls"] }] } }), "request.patterns[0].flavours"],
    ["kinds not a list", () => request({ over: { patterns: [{ name: "Stream", share: 1, flavours: "Rolls" }] } }), "request.patterns[0].flavours"],
    ["a kind of another family in a part", () => request({ over: { parts: [{ startMs: 0, endMs: 4000, kind: "drop", patterns: [{ name: "Jack", share: 1, flavours: ["Rolls"] }] }] } }), "request.parts[0].patterns[0].flavours"],
    ["an unknown mix", () => request({ over: { mix: "random" } }), "request.mix"],
    ["stamina 2", () => request({ over: { stamina: 2 } }), "request.stamina"],
    ["burst -0.1", () => request({ over: { burst: -0.1 } }), "request.burst"],
    ["a fractional seed", () => request({ over: { seed: 1.5 } }), "request.seed"],
    ["a text plan seed", () => request({ over: { planSeed: "1" } }), "request.planSeed"],
    ["a fractional note seed", () => request({ over: { noteSeed: 0.5 } }), "request.noteSeed"],
    ["snaps without 1/4", () => request({ over: { snaps: [3, 6] } }), "request.snaps"],
    ["snaps with 1/12", () => request({ over: { snaps: [4, 12] } }), "request.snaps"],
    ["the same snap twice", () => request({ over: { snaps: [4, 4] } }), "request.snaps"],
    ["normalizeSv not a flag", () => request({ over: { normalizeSv: "yes" } }), "request.normalizeSv"],
    ["parts not a list", () => request({ over: { parts: {} } }), "request.parts"],
    ["25 parts", () => request({ over: { parts: Array.from({ length: 25 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 1000, kind: "part" })) } }), "request.parts"],
    ["a part that ends before it starts", () => request({ over: { parts: [{ startMs: 5000, endMs: 4000, kind: "part" }] } }), "request.parts[0]"],
    ["an unknown part kind", () => request({ over: { parts: [{ startMs: 0, endMs: 4000, kind: "chorus" }] } }), "request.parts[0].kind"],
    ["a part range below 0", () => request({ over: { parts: [{ startMs: 0, endMs: 4000, kind: "drop", range: { lo: -0.5, hi: 3 } }] } }), "request.parts[0].range"],
    ["a part range past 21", () => request({ over: { parts: [{ startMs: 0, endMs: 4000, kind: "drop", range: { lo: 20, hi: 22 } }] } }), "request.parts[0].range"],
    ["a part range upside down", () => request({ over: { parts: [{ startMs: 0, endMs: 4000, kind: "drop", range: { lo: 5, hi: 5 } }] } }), "request.parts[0].range"],
    ["9 parts with their own dan", () => request({ over: { parts: Array.from({ length: 9 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 1000, kind: "part", range: { lo: 3, hi: 4 } })) } }), "request.parts"],
    ["an unknown pattern in a part", () => request({ over: { parts: [{ startMs: 0, endMs: 4000, kind: "drop", patterns: [{ name: "Gluts", share: 1 }] }] } }), "request.parts[0].patterns[0].name"],
    ["empty not a flag", () => request({ over: { parts: [{ startMs: 0, endMs: 4000, kind: "break", empty: 1 }] } }), "request.parts[0].empty"],
    ["a fractional part seed", () => request({ over: { parts: [{ startMs: 0, endMs: 4000, kind: "drop", seed: 0.5 }] } }), "request.parts[0].seed"],
    ["a lock without an id", () => request({ over: { parts: PARTS, lock: { parts: [1] } } }), "request.lock"],
    ["a lock on a part that is not there", () => request({ over: { parts: PARTS, lock: { fromId: "x", parts: [3] } } }), "request.lock.parts"],
    ["a lock without parts", () => request({ over: { lock: { fromId: "x", parts: [0] } } }), "request.lock.parts"],
    ["a lock index that is not an integer", () => request({ over: { parts: PARTS, lock: { fromId: "x", parts: [0.5] } } }), "request.lock.parts"],
];

for (const [name, make, what] of BAD) {
    test(`bad request: ${name}`, async () => {
        const { generate, calls } = setup();
        const answer = await generate(make());
        assert.equal(answer.ok, false);
        assert.equal(answer.code, "badRequest");
        assert.ok(answer.message.includes(what), `${answer.message} should name ${what}`);
        assert.equal(calls.generate.length, 0);
    });
}

test("the good optional fields pass", async () => {
    const { generate, calls } = setup();
    const parts = [
        { startMs: 0, endMs: 30_000, kind: "intro", range: { lo: 0, hi: 4 }, patterns: [{ name: "Stream", share: 1 }], seed: 9 },
        { startMs: 30_000, endMs: 60_000, kind: "break", empty: true },
        { startMs: 60_000, endMs: 120_000, kind: "drop", range: { lo: 20.5, hi: 21 } },
    ];
    const answer = await generate(request({ over: { snaps: [4, 3, 6, 8], normalizeSv: false, planSeed: 5, noteSeed: 6, parts } }));
    assert.equal(answer.ok, true);
    assert.equal(answer.planSeed, 5);
    assert.equal(answer.noteSeed, 6);
    assert.deepEqual(calls.generate[0].request.parts, parts);
    assert.deepEqual(calls.generate[0].request.snaps, [4, 3, 6, 8]);
});

test("kinds (flavours) of each family pass through, and the answer carries their scores and the kinds found", async () => {
    const { generate, calls } = setup();
    const patterns = [{ name: "Stream", share: 0.5, flavours: ["Rolls", "Trills"] }, { name: "Jack", share: 0.5, flavours: [] }];
    const parts = [{ startMs: 0, endMs: 30_000, kind: "drop", patterns: [{ name: "Chordjack", share: 1, flavours: ["Quadstream"] }] }];
    const answer = await generate(request({ over: { patterns, parts } }));
    assert.equal(answer.ok, true);
    assert.deepEqual(calls.generate[0].request.patterns, patterns);
    assert.deepEqual(calls.generate[0].request.parts, parts);
    assert.ok(Array.isArray(answer.flavours));
    assert.equal("flavourScore" in answer, false, "a worker answer without kinds has no kind score");
});

test("the old single target still works", async () => {
    const { generate, calls } = setup();
    const answer = await generate(request({ over: { range: undefined, target: 13.2 } }));
    assert.equal(answer.ok, true);
    assert.equal(calls.generate[0].request.target, 13.2);
    assert.equal(answer.range, null);
});

async function baseMap(setupResult, over = {}) {
    const answer = await setupResult.generate(request({ over: { parts: PARTS, planSeed: 41, ...over } }));
    assert.equal(answer.ok, true);
    return answer.id;
}

test("a lock sends the base map's rows inside the locked parts, its knob and its plan seed", async () => {
    const s = setup();
    const fromId = await baseMap(s);
    const answer = await s.generate(request({ over: { parts: PARTS, noteSeed: 77, lock: { fromId, parts: [1] } } }));
    assert.equal(answer.ok, true);
    const payload = s.calls.generate[1];
    assert.equal("lock" in payload.request, false);
    assert.deepEqual(payload.locked, {
        rows: [{ t: 2000, mask: 2 }, { t: 3000, mask: 4 }, { t: 4000, mask: 8 }],
        ranges: [[1500, 5000]],
        knob: -1.25,
        planSeed: 41,
    });
    assert.equal(payload.request.noteSeed, 77);
});

test("a lock tolerates half a millisecond on sections and one on part edges", async () => {
    const s = setup();
    const fromId = await baseMap(s);
    const nudged = PARTS.map((p, i) => (i === 1 ? { ...p, startMs: p.startMs + 1, endMs: p.endMs - 1 } : p));
    const answer = await s.generate(request({
        top: { timing: { sections: [{ timeMs: 312.4, bpm: 174 + 5e-7, meter: 4 }] } },
        over: { parts: nudged, lock: { fromId, parts: [1] } },
    }));
    assert.equal(answer.ok, true);
});

// [what changed between the base map and the locked request]
const CHANGED = [
    ["an id the store does not know", (fromId) => request({ over: { parts: PARTS, lock: { fromId: `${fromId}x`, parts: [1] } } })],
    ["another song", (fromId) => request({ top: { audioPath: "C:/songs/other.mp3" }, over: { parts: PARTS, lock: { fromId, parts: [1] } } })],
    ["the offset moved by 1 ms", (fromId) => request({ top: { timing: { sections: [{ timeMs: 313, bpm: 174, meter: 4 }] } }, over: { parts: PARTS, lock: { fromId, parts: [1] } } })],
    ["the BPM changed", (fromId) => request({ top: { timing: { sections: [{ timeMs: 312, bpm: 174.01, meter: 4 }] } }, over: { parts: PARTS, lock: { fromId, parts: [1] } } })],
    ["a section was added", (fromId) => request({ top: { timing: { sections: [{ timeMs: 312, bpm: 174, meter: 4 }, { timeMs: 60_000, bpm: 180, meter: 4 }] } }, over: { parts: PARTS, lock: { fromId, parts: [1] } } })],
    ["the meter changed", (fromId) => request({ top: { timing: { sections: [{ timeMs: 312, bpm: 174, meter: 3 }] } }, over: { parts: PARTS, lock: { fromId, parts: [1] } } })],
    ["the locked part moved by 2 ms", (fromId) => request({ over: { parts: PARTS.map((p, i) => (i === 1 ? { ...p, endMs: p.endMs + 2 } : i === 2 ? { ...p, startMs: p.startMs + 2 } : p)), lock: { fromId, parts: [1] } } })],
];

for (const [name, make] of CHANGED) {
    test(`lock refused when ${name}`, async () => {
        const s = setup();
        const fromId = await baseMap(s);
        const answer = await s.generate(make(fromId));
        assert.equal(answer.ok, false);
        assert.equal(answer.code, "timingChanged");
        assert.equal(typeof answer.message, "string");
        assert.ok(answer.message.length > 0);
        assert.equal(s.calls.generate.length, 1);
    });
}

test("a lock on a base map with fewer parts is refused", async () => {
    const s = setup();
    const fromId = await baseMap(s, { parts: PARTS.slice(0, 2).map((p, i) => (i === 1 ? { ...p, endMs: 120_000 } : p)) });
    const answer = await s.generate(request({ over: { parts: PARTS, lock: { fromId, parts: [2] } } }));
    assert.equal(answer.code, "timingChanged");
});

test("the parts the generator reports are the ones a lock is checked against", async () => {
    const reported = [
        { index: 0, startMs: 0, endMs: 1600, kind: "intro" },
        { index: 1, startMs: 1600, endMs: 5000, kind: "drop" },
        { index: 2, startMs: 5000, endMs: 120_000, kind: "outro" },
    ];
    const s = setup({ answer: () => ({ kind: "generated", osuText: osuWithRows([1000, 2000]), version: "v", result: { kind: "ok", numeric: 13 }, parts: reported }) });
    const fromId = await baseMap(s);
    assert.equal((await s.generate(request({ over: { parts: PARTS, lock: { fromId, parts: [1] } } }))).code, "timingChanged");
    const moved = PARTS.map((p, i) => (i === 0 ? { ...p, endMs: 1600 } : i === 1 ? { ...p, startMs: 1600 } : p));
    const answer = await s.generate(request({ over: { parts: moved, lock: { fromId, parts: [1] } } }));
    assert.equal(answer.ok, true);
    assert.deepEqual(s.calls.generate.at(-1).locked.rows, [{ t: 2000, mask: 2 }]);
});

test("a failed generation stores nothing and says why", async () => {
    const s = setup({ answer: () => ({ kind: "error", message: "boom" }) });
    const answer = await s.generate(request());
    assert.deepEqual(answer, { ok: false, code: "failed", message: "boom" });
});

test("a worker that throws is still an answer", async () => {
    const handlers = {};
    const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} };
    const generatorClient = { generate: async () => { throw new Error("worker gone"); }, detectTiming: async () => { throw new Error("worker gone"); } };
    registerCreateIpc({ ipcMain, generatorClient, generatedStore: createGeneratedStore(), log() {} });
    const sender = { sender: { send() {} } };
    assert.deepEqual(await handlers["generate-map"](sender, request()), { ok: false, code: "failed", message: "worker gone" });
    const timing = await handlers["detect-timing"](sender, { envelope: { values: [1], hopSec: 0.01 } });
    assert.equal(timing.ok, false);
    assert.equal(timing.message, "worker gone");
});

test("the generator's report fields pass through, issues capped at 50", async () => {
    const stats = { notes: 10, rows: 8, sizeShares: [1, 0, 0, 0], leftShare: 0.5, colShares: [0.25, 0.25, 0.25, 0.25], maxJack: { all: 2, streamy: 1 }, peakNps: 9, forced: 0 };
    const issues = Array.from({ length: 60 }, (_, i) => ({ t: i, kind: "jack", col: 0, n: 3 }));
    const parts = [{ index: 0, startMs: 0, endMs: 120_000, kind: "part", families: ["Stream"], wanted: null, empty: false, locked: false, noteCount: 10, patternScore: 0.9, dan: null, inRange: null, issues: 0, retried: 0 }];
    const s = setup({ answer: () => ({
        kind: "generated", osuText: "o", version: "v", result: { kind: "ok", numeric: 13 }, reachable: false, noteCount: 10, patternScore: 0.5,
        knob: 0.5, planSeed: 8, noteSeed: 9, stats, issues, parts, retries: { blocks: 2, dan: "low" }, grid: { 4: 0.9, 3: 0.1, 6: 0, 8: 0 },
        range: { lo: 1, hi: 2 }, engine: "rules", modelInfo: { kind: "rules", grid: "q4", maps: 0 },
    }) });
    const answer = await s.generate(request());
    assert.equal(answer.issues.length, 50);
    assert.deepEqual(answer.stats, stats);
    assert.deepEqual(answer.parts, parts);
    assert.deepEqual(answer.retries, { blocks: 2, dan: "low" });
    assert.deepEqual(answer.grid, { 4: 0.9, 3: 0.1, 6: 0, 8: 0 });
    assert.deepEqual([answer.knob, answer.planSeed, answer.noteSeed], [0.5, 8, 9]);
    assert.deepEqual(answer.range, { lo: 1, hi: 2 });
    assert.equal(answer.engine, "rules");
});

test("detect-timing sends the envelope, the fine onsets and the hint to the worker", async () => {
    const { detect, calls } = setup();
    const envelope = { values: new Float32Array(4), hopSec: 0.0116, frameOffsetSec: 0 };
    const fine = { values: new Float32Array(16), hopSec: 32 / 22050 };
    const hint = { sections: [{ timeMs: 10, bpm: 128, meter: 4 }], bpm: 128, offsetMs: 10 };
    const answer = await detect({ envelope, fine, hint });
    assert.deepEqual(answer, { ok: true, timing: { sections: [{ timeMs: 10, bpm: 128, meter: 4 }], bpm: 128, offsetMs: 10 }, modelInfo: { kind: "rules", grid: "q4", maps: 0 } });
    assert.equal(calls.timing[0].envelope, envelope);
    assert.equal(calls.timing[0].fine, fine);
    assert.deepEqual(calls.timing[0].hint, hint);
});

test("detect-timing without fine onsets or a hint", async () => {
    const { detect, calls } = setup();
    assert.equal((await detect({ envelope: { values: [0, 1], hopSec: 0.01 } })).ok, true);
    assert.equal(calls.timing[0].fine, null);
    assert.equal(calls.timing[0].hint, null);
});

test("detect-timing refuses what it cannot use", async () => {
    const { detect, calls } = setup();
    for (const [req, what] of [
        [null, "request"],
        [{}, "envelope"],
        [{ envelope: { values: [1], hopSec: 0 } }, "envelope"],
        [{ envelope: { values: [1], hopSec: 0.01 }, fine: { values: "x", hopSec: 0.001 } }, "fine"],
        [{ envelope: { values: [1], hopSec: 0.01 }, hint: { sections: [{ timeMs: 0, bpm: 500, meter: 4 }] } }, "hint.sections[0].bpm"],
    ]) {
        const answer = await detect(req);
        assert.equal(answer.ok, false);
        assert.equal(answer.code, "badRequest");
        assert.ok(answer.message.includes(what), `${answer.message} should name ${what}`);
    }
    assert.equal(calls.timing.length, 0);
});

test("detect-timing passes a worker error on", async () => {
    const handlers = {};
    const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} };
    const generatorClient = { detectTiming: async () => ({ kind: "error", message: "the calculation took too long", transient: true }) };
    registerCreateIpc({ ipcMain, generatorClient, generatedStore: createGeneratedStore(), log() {} });
    const answer = await handlers["detect-timing"]({}, { envelope: { values: [1], hopSec: 0.01 } });
    assert.deepEqual(answer, { ok: false, message: "the calculation took too long" });
});

test("registering calls nothing", () => {
    let touched = 0;
    const trap = new Proxy({}, { get: () => { touched += 1; return () => {}; } });
    registerCreateIpc({ ipcMain: { handle() {}, on() {} }, generatorClient: trap, generatedStore: trap, log: () => { touched += 1; } });
    assert.equal(touched, 0);
});

// ---- wave 3 (P-ml1): stems, candidates, style, repeats, modelSize; personal and the deadline; generator-info ----

const stemsOf = (frames = 8, over = {}) => {
    const curve = () => new Float32Array(frames).fill(0.25);
    return { v: 1, hopSec: 0.0116, frameOffsetSec: 0.01, frames, kick: curve(), snare: curve(), hat: curve(), harm: curve(), percShare: curve(), chroma: new Uint8Array(frames * 12), timbre: new Uint8Array(frames * 12), ...over };
};
const BIG = 400_000; // 44 bytes a frame: more than 16 MB in all
const ML_BAD = [
    ["stems not an object", () => request({ top: { stems: 5 } }), "stems"],
    ["stems of another version", () => request({ top: { stems: stemsOf(8, { v: 2 }) } }), "stems.v"],
    ["stems 3 frames off the envelope", () => request({ top: { stems: stemsOf(11) } }), "stems.frames"],
    ["a stem curve of the wrong length", () => request({ top: { stems: stemsOf(8, { kick: new Float32Array(7) }) } }), "stems.kick"],
    ["a stem curve that is not a Float32Array", () => request({ top: { stems: stemsOf(8, { hat: Array(8).fill(0) }) } }), "stems.hat"],
    ["chroma of the wrong length", () => request({ top: { stems: stemsOf(8, { chroma: new Uint8Array(12) }) } }), "stems.chroma"],
    ["stems over 16 MB", () => request({ top: { envelope: { values: new Float32Array(BIG), hopSec: 0.0116, frameOffsetSec: 0.01 }, stems: stemsOf(BIG) } }), "stems"],
    ["0 candidates", () => request({ over: { candidates: 0 } }), "request.candidates"],
    ["21 candidates", () => request({ over: { candidates: 21 } }), "request.candidates"],
    ["fractional candidates", () => request({ over: { candidates: 2.5 } }), "request.candidates"],
    ["candidates as text", () => request({ over: { candidates: "3" } }), "request.candidates"],
    ["a style no model has", () => request({ over: { style: "nobody" } }), "request.style"],
    ["a style that is not text", () => request({ over: { style: 3 } }), "request.style"],
    ["repeats not a flag", () => request({ over: { repeats: 1 } }), "request.repeats"],
    ["an unknown model size", () => request({ over: { modelSize: "xl" } }), "request.modelSize"],
    ["a model size in capitals", () => request({ over: { modelSize: "L" } }), "request.modelSize"],
];

for (const [name, make, what] of ML_BAD) {
    test(`bad request: ${name}`, async () => {
        const { generate, calls } = setup();
        const answer = await generate(make());
        assert.equal(answer.ok, false);
        assert.equal(answer.code, "badRequest");
        assert.ok(answer.message.includes(what), `${answer.message} should name ${what}`);
        assert.equal(calls.generate.length, 0);
    });
}

test("good stems go to the worker at the top level; within 2 frames of the envelope is fine", async () => {
    const { generate, calls } = setup();
    for (const frames of [6, 8, 10]) {
        const stems = stemsOf(frames);
        const answer = await generate(request({ top: { stems } }));
        assert.equal(answer.ok, true, answer.message);
        assert.equal(calls.generate.at(-1).stems, stems);
    }
    await generate(request({ top: { stems: null } }));
    assert.equal("stems" in calls.generate.at(-1), false);
    await generate(request());
    assert.equal("stems" in calls.generate.at(-1), false);
});

test("candidates 1..20, repeats, a null style and every model size pass", async () => {
    const { generate, calls } = setup();
    for (const over of [{ candidates: 1 }, { candidates: 20 }, { repeats: true }, { repeats: false }, { style: null },
        ...["auto", "xgb3", "s", "m", "l"].map((modelSize) => ({ modelSize }))]) {
        const answer = await generate(request({ over }));
        assert.equal(answer.ok, true, `${JSON.stringify(over)}: ${answer.message}`);
        const [[key, value]] = Object.entries(over);
        assert.equal(calls.generate.at(-1).request[key], value);
    }
});

test("a style is checked against the styles of the model picked (modelSize), not of the model that last ran", async () => {
    const answer = () => ({ kind: "generated", osuText: "o", version: "v", result: {}, modelInfo: { kind: "nn-v2", styles: [{ key: "mapperC", name: "C", maps: 1 }] } });
    const { generate, calls } = setup({ answer });
    const code = async (over) => (await generate(request({ over }))).code ?? "ok";
    assert.equal(await code({ style: "mapperA" }), "badRequest", "no modelSize: the classic model, which has no styles");
    assert.equal(await code({ style: "mapperA", modelSize: "auto" }), "badRequest");
    assert.equal(await code({ style: "mapperA", modelSize: "xgb3" }), "ok");
    assert.equal(calls.generate.at(-1).request.style, "mapperA");
    assert.equal(await code({ style: "u:77", modelSize: "xgb3" }), "badRequest", "XGBoost v3 here has no u:77");
    assert.equal(await code({ style: "u:77", modelSize: "s" }), "ok");
    // the worker last named mapperC: that does not make it a style of any model choice
    assert.equal(await code({ style: "mapperC", modelSize: "s" }), "badRequest");
    assert.equal(await code({ style: null, modelSize: "auto" }), "ok");
});

test("when the model files cannot be read, the styles of the model that last answered are the fallback", async () => {
    const handlers = {};
    const generatorClient = {
        generate: async () => ({ kind: "generated", osuText: "o", version: "v", result: {} }),
        detectTiming: async () => ({ kind: "timing", timing: { sections: [{ timeMs: 0, bpm: 120, meter: 4 }], bpm: 120, offsetMs: 0 }, modelInfo: { kind: "xgb-v3", styles: [{ key: "s1", name: "S1", maps: 9 }] } }),
    };
    registerCreateIpc({ ipcMain: { handle: (c, fn) => { handlers[c] = fn; }, on() {} }, generatorClient, generatedStore: createGeneratedStore(), log() {}, styleCatalog: fakeCatalog(new Error("no disk")) });
    assert.equal((await handlers["generate-map"]({ sender: { send() {} } }, request({ over: { style: "s1", modelSize: "xgb3" } }))).code, "badRequest");
    await handlers["detect-timing"]({}, { envelope: { values: [1], hopSec: 0.01 } });
    assert.equal((await handlers["generate-map"]({ sender: { send() {} } }, request({ over: { style: "s1", modelSize: "xgb3" } }))).ok, true);
});

test("the answer names the style the map was made with, or the one asked for that the model which ran did not use", async () => {
    let used = "u:77";
    const { generate, generatedStore } = setup({ answer: () => ({ kind: "generated", osuText: "o", version: "v", result: {}, ...(used ? { style: used } : {}) }) });
    const made = await generate(request({ over: { style: "u:77", modelSize: "s" } }));
    assert.equal(made.ok, true, made.message);
    assert.deepEqual(made.style, { key: "u:77", name: null, user: "77" });
    assert.equal(made.styleAsked, null);
    assert.equal(generatedStore.get(made.id).style, "u:77");
    // the nn-v2 model had no stems and the classic model ran: no style in the worker's answer
    used = null;
    const fell = await generate(request({ over: { style: "mapperA", modelSize: "s" } }));
    assert.equal(fell.style, null);
    assert.deepEqual(fell.styleAsked, { key: "mapperA", name: "Mapper A", user: null });
    assert.equal(generatedStore.get(fell.id).style, null);
    const plain = await generate(request());
    assert.equal(plain.style, null);
    assert.equal(plain.styleAsked, null);
});

test("the renderer's personal model, deadline and critic weights are ignored; main adds personal: null and the deadline", async () => {
    const { generate, calls } = setup();
    const personal = { v: 1, names: ["x"], w: [9], b: 9, n: 99, weight: 1 };
    const answer = await generate(request({ top: { personal, deadlineMs: 1 }, over: { personal, deadlineMs: 1, critic: { wF: 9 }, blend: { wP: 0 } } }));
    assert.equal(answer.ok, true);
    const [payload] = calls.generate;
    assert.equal(payload.personal, null);
    assert.equal(payload.deadlineMs, 4000);
    for (const key of ["personal", "deadlineMs", "critic", "blend"]) assert.equal(key in payload.request, false, key);
});

test("the critic and the structure pass through; the critic's features stay in the store", async () => {
    const critic = { kind: "critic-v1", score: 1.2, human: 0.8, fun: 0.1, play: -0.2, personal: null, style: null, picked: 3, of: 12, analysed: 4, ms: 900, features: [1, 2, 3] };
    const structure = { phrases: [{ startMs: 0, bars: 8 }], repeats: [] };
    const { generate, generatedStore } = setup({ answer: () => ({ kind: "generated", osuText: "o", version: "v", result: {}, critic, structure }) });
    const answer = await generate(request({ over: { candidates: 12, style: null } }));
    assert.equal(answer.ok, true);
    assert.equal("features" in answer.critic, false);
    assert.equal(answer.critic.picked, 3);
    assert.deepEqual(answer.structure, structure);
    const stored = generatedStore.get(answer.id);
    assert.deepEqual(stored.critic.features, [1, 2, 3]);
    assert.equal(stored.candidates, 12);
    assert.equal(stored.style, null);
    const plain = await setup().generate(request());
    assert.equal("critic" in plain, false);
    assert.equal("structure" in plain, false);
});

test("generator-info: the model files there, the sizes, the critic, and the styles the worker last named; no file written", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gen-info-"));
    await writeFile(path.join(dir, "mapper-nn2-m.json"), "{}");
    // the styles per choice come from the catalog
    await writeFile(path.join(dir, "critic.json"), "{}");
    const before = process.env.LUNACY_MODEL_DIR;
    process.env.LUNACY_MODEL_DIR = dir;
    try {
        const styles = [{ key: "mapperA", name: "Mapper A", maps: 40 }];
        const first = await setup().handlers["generator-info"]({});
        assert.equal(first.ok, true);
        assert.equal(first.modelInfo.sizes.m, true);
        assert.equal(first.modelInfo.critic, "critic-v1");
        assert.ok(first.modelInfo.engines.includes("neural"));
        assert.deepEqual(first.modelInfo.styles, []);
        assert.deepEqual(first.modelInfo.modelSizes, ["auto", "xgb3", "s", "m", "l"]);
        assert.deepEqual(first.modelInfo.stylesBySize, STYLES_BY_SIZE);
        const { generate, handlers } = setup({ answer: () => ({ kind: "generated", osuText: "o", version: "v", result: {}, modelInfo: { kind: "nn-v2", grid: "snap-v2", maps: 5, styles } }) });
        await generate(request());
        const after = await handlers["generator-info"]({});
        assert.deepEqual(after.modelInfo.styles, styles);
        assert.equal(after.modelInfo.kind, "nn-v2");
        assert.deepEqual((await readdir(dir)).sort(), ["critic.json", "mapper-nn2-m.json"]);
    } finally {
        if (before === undefined) delete process.env.LUNACY_MODEL_DIR;
        else process.env.LUNACY_MODEL_DIR = before;
    }
});

test("generator-info's stylesBySize reads the model files once: per choice, named from XGBoost v3, cached in userData", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gen-styles-"));
    const userData = await mkdtemp(path.join(tmpdir(), "gen-styles-ud-"));
    await writeFile(path.join(dir, "mapper-xgb3.json"), JSON.stringify({ kind: "xgb-v3", pattern: { a: [1, 2] }, styles: [{ key: "n:abc", name: "Abc", maps: 3 }, { key: "u:7", name: "u:7", maps: 9 }] }));
    await writeFile(path.join(dir, "mapper-nn2-s.json"), JSON.stringify({ kind: "nn-v2", styles: [{ key: "n:abc", name: "n:abc", maps: 3 }, { key: "n:zed", name: "n:zed", maps: 1 }] }));
    const before = process.env.LUNACY_MODEL_DIR;
    process.env.LUNACY_MODEL_DIR = dir;
    try {
        const handlers = {};
        registerCreateIpc({ ipcMain: { handle: (c, fn) => { handlers[c] = fn; }, on() {} }, generatorClient: {}, generatedStore: createGeneratedStore(), log() {}, paths: { userData, docsDir: userData } });
        const { modelInfo } = await handlers["generator-info"]({}, { gpu: false });
        assert.deepEqual(modelInfo.stylesBySize.xgb3, [{ key: "u:7", name: null, user: "7", maps: 9 }, { key: "n:abc", name: "Abc", user: null, maps: 3 }]);
        assert.deepEqual(modelInfo.stylesBySize.s, [{ key: "n:abc", name: "Abc", user: null, maps: 3 }, { key: "n:zed", name: "zed", user: null, maps: 1 }]);
        assert.deepEqual(modelInfo.stylesBySize.auto, []);
        assert.ok((await readdir(userData)).includes("model-styles.json"));
        assert.deepEqual((await readdir(dir)).sort(), ["mapper-nn2-s.json", "mapper-xgb3.json"]);
        // the request is checked against the same lists
        const generatorClient = { generate: async () => ({ kind: "generated", osuText: "o", version: "v", result: {}, style: "n:zed" }) };
        const h2 = {};
        registerCreateIpc({ ipcMain: { handle: (c, fn) => { h2[c] = fn; }, on() {} }, generatorClient, generatedStore: createGeneratedStore(), log() {}, paths: { userData, docsDir: userData } });
        const send = { sender: { send() {} } };
        assert.equal((await h2["generate-map"](send, request({ over: { style: "n:zed", modelSize: "xgb3" } }))).code, "badRequest");
        const made = await h2["generate-map"](send, request({ over: { style: "n:zed", modelSize: "s" } }));
        assert.equal(made.ok, true, made.message);
        assert.deepEqual(made.style, { key: "n:zed", name: "zed", user: null });
    } finally {
        if (before === undefined) delete process.env.LUNACY_MODEL_DIR;
        else process.env.LUNACY_MODEL_DIR = before;
    }
});

test("the ratings channels (app/ratingsIpc.js): a summary of nothing; an unknown id, bad votes and an empty export are refused without writing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ratings-"));
    const handlers = {};
    registerCreateIpc({ ipcMain: { handle: (c, fn) => { handlers[c] = fn; }, on() {} }, generatorClient: {}, generatedStore: createGeneratedStore(), log() {}, paths: { userData: dir, docsDir: dir } });
    assert.deepEqual(await handlers["ratings-summary"]({}), { ok: true, n: 0, up: 0, down: 0, active: false, auc: null });
    const rated = await handlers["rate-variant"]({}, { id: "x", vote: 1, tags: ["fun"] });
    assert.equal(rated.ok, false);
    assert.equal(rated.code, "unknownId");
    assert.equal((await handlers["rate-variant"]({}, { id: "x", vote: 2, tags: [] })).code, "badRating");
    assert.equal((await handlers["rate-variant"]({}, { id: "x", vote: 1, tags: ["fun", "human", "comfy", "boring", "awkward"] })).code, "badRating");
    assert.equal((await handlers["rate-variant"]({}, { id: "x", vote: 1, tags: ["nope"] })).code, "badRating");
    assert.equal((await handlers["rate-variant"]({}, null)).code, "badRating");
    assert.equal((await handlers["ratings-export"]({})).ok, false);
    assert.deepEqual(await readdir(dir), []);
});
