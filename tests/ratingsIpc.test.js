// The ratings channels (app/ratingsIpc.js, addendum §2.7 / U1): registering does no I/O and calls no dep; bad tags and
// unknown ids are refused; a rating copies the variant's critic features (no audio, no chart text); the personal model
// is never fitted on the main thread: one fit-personal job goes to the worker 2 s after the last rating; the model it
// answers is kept (also for the next session) and handed to generate-map only when it is active; the export never
// overwrites. Then the whole path with the real generator jobs and personal.js.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { registerRatingsIpc, checkRating, audioKeyOf, RATING_TAGS, FIT_DEBOUNCE_MS } from "../app/ratingsIpc.js";
import { createGeneratedStore } from "../app/generatedStore.js";
import { createGeneratorJobs } from "../app/generatorJobs.js";
import { createWorkerClient } from "../app/workerClient.js";
import { CRITIC_FEATURES } from "../src/gen/criticFeatures.js";
import { t } from "../src/i18n/i18n.js";
import { stripComments } from "./helpers/source.js";

// timers the test runs by hand
function manualTimers() {
    const timers = new Map();
    let next = 0;
    return {
        timers,
        setTimer: (fn, ms) => { next += 1; timers.set(next, { fn, ms }); return next; },
        clearTimer: (id) => { timers.delete(id); },
        async runAll() {
            const list = [...timers.values()];
            timers.clear();
            for (const { fn } of list) fn();
        },
    };
}

let clock = 1_000_000;
async function setup({ fit = null, paths = null } = {}) {
    const dir = paths ? null : await mkdtemp(path.join(tmpdir(), "ratings-ipc-"));
    const handlers = {};
    const fits = [];
    const generatedStore = createGeneratedStore();
    const generatorClient = {
        async fitPersonal(payload) {
            fits.push(payload);
            return fit ? fit(payload) : { kind: "personal", personal: null };
        },
    };
    const timers = manualTimers();
    const deps = {
        ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
        generatedStore, generatorClient, log() {},
        paths: paths ?? { userData: path.join(dir, "user"), docsDir: path.join(dir, "docs") },
    };
    const ratings = registerRatingsIpc(deps, { ...timers, now: () => (clock += 1000) });
    const rate = (raw) => handlers["rate-variant"]({}, raw);
    return { dir, handlers, fits, generatedStore, timers, ratings, rate, deps };
}

// a stored variant as createIpc's generate-map puts it, with a critic feature vector of the critic's length
const storedVariant = (store, { features = CRITIC_FEATURES.map((_, k) => k % 7), osuText = "osu file format v14\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:" } = {}) => store.put({
    osuText, version: "Gamma mid Jumpstream", title: "Song", audioPath: "C:/songs/song.mp3",
    timing: { sections: [{ timeMs: 0, bpm: 174, meter: 4 }] }, parts: [], knob: 0, planSeed: 1, noteSeed: 2, engine: "learned",
    result: { numeric: 13.0, label: "Gamma mid", top3: [{ name: "Jumpstream", share: 0.7 }, { name: "Handstream", share: 0.2 }] },
    range: { lo: 12.5, hi: 13.5 },
    critic: { kind: "heuristic", score: -0.1, human: null, fun: null, play: -0.1, personal: null, style: null, picked: 2, of: 12, analysed: 3, ms: 600, features },
    style: null, candidates: 12,
});

test("checkRating: the id, a vote of 1, -1 or 0, at most 4 known tags, each once", () => {
    assert.equal(checkRating({ id: "x", vote: 1, tags: ["fun"] }), null);
    assert.equal(checkRating({ id: "x", vote: 0 }), null);
    assert.equal(checkRating(null), "request");
    assert.equal(checkRating({ id: "", vote: 1 }), "id");
    assert.equal(checkRating({ id: "x".repeat(65), vote: 1 }), "id");
    assert.equal(checkRating({ id: "x", vote: 2 }), "vote");
    assert.equal(checkRating({ id: "x", vote: 1, tags: ["fun", "fun"] }), "tags");
    assert.equal(checkRating({ id: "x", vote: 1, tags: ["nope"] }), "tags");
    assert.equal(checkRating({ id: "x", vote: -1, tags: RATING_TAGS.slice(0, 5) }), "tags");
});

test("registering with stub deps does no I/O and calls no dep", () => {
    const calls = [];
    const stub = (name) => new Proxy(function stubbed() {}, {
        get(_target, key) {
            if (key === Symbol.toPrimitive) return () => `stub:${name}`;
            if (typeof key === "symbol" || key === "then") return undefined;
            return stub(`${name}.${key}`);
        },
        apply() { calls.push(name); return stub(`${name}()`); },
    });
    const handled = [];
    const deps = new Proxy({ ipcMain: { handle: (c) => handled.push(c) } }, { get: (target, key) => (key in target ? target[key] : stub(String(key))) });
    const timers = manualTimers();
    const ratings = registerRatingsIpc(deps, timers);
    assert.deepEqual(handled.sort(), ["rate-variant", "ratings-export", "ratings-summary"]);
    assert.deepEqual(calls, []);
    assert.equal(timers.timers.size, 0, "no timer started");
    assert.equal(typeof ratings.personal, "function");
});

test("bad tags are refused with create.err.badRating; an unknown id gives app.gen.unknownId; nothing is written", async () => {
    const { rate, dir } = await setup();
    const bad = await rate({ id: "x", vote: 1, tags: ["nope"] });
    assert.deepEqual(bad, { ok: false, code: "badRating", message: t("create.err.badRating", { what: "tags" }) });
    const unknown = await rate({ id: "not-there", vote: -1, tags: [] });
    assert.deepEqual(unknown, { ok: false, code: "unknownId", message: t("app.gen.unknownId") });
    assert.deepEqual(await readdir(dir), [], "no store file for refused ratings");
});

test("a rating copies the variant's critic features, version, range and families, and a hash of the song's path", async () => {
    const { rate, generatedStore, deps, handlers } = await setup();
    const id = storedVariant(generatedStore);
    assert.deepEqual(await rate({ id, vote: -1, tags: ["tooJacky", "boring"] }), { ok: true, n: 1 });
    const disk = JSON.parse(await readFile(path.join(deps.paths.userData, "ratings.json"), "utf8"));
    const [e] = disk.entries;
    assert.equal(e.id, id);
    assert.equal(e.vote, -1);
    assert.deepEqual(e.tags, ["tooJacky", "boring"]);
    assert.equal(e.version, "Gamma mid Jumpstream");
    assert.deepEqual(e.range, { lo: 12.5, hi: 13.5 });
    assert.deepEqual(e.families, ["Jumpstream", "Handstream"]);
    assert.equal(e.modelKind, "learned");
    assert.equal(e.criticKind, "heuristic");
    assert.equal(e.features.length, CRITIC_FEATURES.length);
    assert.deepEqual(disk.nameSets, [CRITIC_FEATURES]);
    assert.equal(e.audioKey, audioKeyOf("C:/songs/song.mp3"));
    assert.match(e.audioKey, /^[0-9a-f]{12}$/);
    const text = JSON.stringify(disk);
    assert.ok(!text.includes("C:/songs") && !text.includes("HitObjects"), "no path and no chart text in the file");
    assert.deepEqual(await handlers["ratings-summary"]({}), { ok: true, n: 1, up: 0, down: 1, active: false, auc: null });
    // changing the vote, then taking it back
    assert.deepEqual(await rate({ id, vote: 1, tags: ["fun"] }), { ok: true, n: 1 });
    assert.deepEqual(await rate({ id, vote: 0, tags: [] }), { ok: true, n: 0 });
});

test("a variant the generated store forgot can still be re-rated; a critic of another length keeps the vote only", async () => {
    const { rate, generatedStore, deps } = await setup();
    const id = storedVariant(generatedStore);
    await rate({ id, vote: 1, tags: [] });
    for (let i = 0; i < 30; i += 1) generatedStore.put({ osuText: "", version: "", audioPath: "x" }); // the LRU drops it
    assert.equal(generatedStore.has(id), false);
    assert.deepEqual(await rate({ id, vote: -1, tags: ["awkward"] }), { ok: true, n: 1 });
    const odd = storedVariant(generatedStore, { features: [1, 2, 3] });
    assert.deepEqual(await rate({ id: odd, vote: 1, tags: [] }), { ok: true, n: 2 });
    const disk = JSON.parse(await readFile(path.join(deps.paths.userData, "ratings.json"), "utf8"));
    assert.deepEqual(disk.entries.map((e) => [e.vote, e.features.length]), [[-1, CRITIC_FEATURES.length], [1, 0]]);
});

test("ratings never fit on the main thread: one fit-personal job 2 s after the last rating; the model is kept and used when active", async () => {
    const active = { v: 1, names: ["a"], w: [0.5], b: 0, mean: [0], std: [1], n: 14, positives: 7, negatives: 7, looAuc: 0.71, weight: 0.26, active: true };
    const { rate, generatedStore, fits, timers, ratings, handlers, deps } = await setup({ fit: () => ({ kind: "personal", personal: active }) });
    const ids = [storedVariant(generatedStore), storedVariant(generatedStore), storedVariant(generatedStore)];
    await rate({ id: ids[0], vote: 1, tags: [] });
    await rate({ id: ids[1], vote: -1, tags: ["tooDense"] });
    await rate({ id: ids[2], vote: 1, tags: ["comfy"] });
    assert.equal(fits.length, 0, "nothing is fitted while ratings come in");
    assert.equal(timers.timers.size, 1, "one debounced fit waits");
    assert.equal([...timers.timers.values()][0].ms, FIT_DEBOUNCE_MS);
    assert.equal(FIT_DEBOUNCE_MS, 2000);
    assert.equal(ratings.personal(), null);
    await timers.runAll();
    await ratings.idle();
    assert.equal(fits.length, 1, "one job for the three ratings");
    const [job] = fits;
    assert.deepEqual(job.entries.map((e) => [e.vote, e.tags]), [[1, []], [-1, ["tooDense"]], [1, ["comfy"]]]);
    assert.equal(job.entries[0].names, job.entries[1].names, "the names go once, shared");
    assert.deepEqual(Object.keys(job.entries[0]).sort(), ["features", "names", "tags", "vote"], "only what the fit needs");
    assert.equal(ratings.personal(), active);
    assert.deepEqual(await handlers["ratings-summary"]({}), { ok: true, n: 3, up: 2, down: 1, active: true, auc: 0.71 });

    // the next session starts with the kept model: personal() reads the store in the background on its first call
    const next = await setup({ paths: deps.paths });
    assert.equal(next.ratings.personal(), null);
    await next.handlers["ratings-summary"]({});
    assert.deepEqual(next.ratings.personal(), active);

    // an inactive model is kept for the summary but never handed to the generator
    const inactive = { ...active, active: false, weight: 0, looAuc: 0.52 };
    const weak = await setup({ fit: () => ({ kind: "personal", personal: inactive }) });
    await weak.rate({ id: storedVariant(weak.generatedStore), vote: 1, tags: [] });
    await weak.timers.runAll();
    await weak.ratings.idle();
    assert.equal(weak.ratings.personal(), null);
    assert.deepEqual(await weak.handlers["ratings-summary"]({}), { ok: true, n: 1, up: 1, down: 0, active: false, auc: 0.52 });
});

test("ratingsIpc.js never calls fitPersonal itself: the fit is a job for the worker", () => {
    const source = stripComments(readFileSync(new URL("../app/ratingsIpc.js", import.meta.url), "utf8"));
    assert.ok(!/import\s*\{[^}]*fitPersonal[^}]*\}/.test(source), "fitPersonal is not imported");
    assert.ok(/generatorClient/.test(source) && /\.fitPersonal\(/.test(source));
});

test("the export: a new file in docsDir each time, never over an old one; nothing rated yet: refused, no file", async () => {
    const { rate, generatedStore, handlers, deps } = await setup();
    const empty = await handlers["ratings-export"]({});
    assert.equal(empty.ok, false);
    assert.equal(empty.code, "empty");
    assert.equal(empty.message, t("create.ml.exportEmpty"));
    await rate({ id: storedVariant(generatedStore), vote: 1, tags: ["human"] });
    const first = await handlers["ratings-export"]({});
    const second = await handlers["ratings-export"]({});
    assert.equal(first.ok, true);
    assert.equal(path.dirname(first.file), deps.paths.docsDir);
    assert.notEqual(first.file, second.file);
    const body = JSON.parse(await readFile(first.file, "utf8"));
    assert.equal(body.kind, "lunacy-ratings");
    assert.equal(body.entries.length, 1);
    assert.equal((await readdir(deps.paths.docsDir)).length, 2);
});

test("the worker client sends fit-personal as its own job kind", async () => {
    const w = new EventEmitter();
    w.posted = [];
    w.postMessage = (msg) => { w.posted.push(msg); setImmediate(() => w.emit("message", { id: msg.id, result: { kind: "personal", personal: null } })); };
    w.kill = () => {};
    const client = createWorkerClient({ spawn: () => w, timeoutMs: 1000, generateTimeoutMs: 1000 });
    const out = await client.fitPersonal({ entries: [] });
    assert.deepEqual(out, { kind: "personal", personal: null });
    assert.equal(w.posted[0].kind, "fit-personal");
    assert.deepEqual(w.posted[0].payload, { entries: [] });
    client.dispose();
});

test("end to end: ratings → the real fit-personal job → an active model for generate-map", async () => {
    const jobs = createGeneratorJobs({ readModel: async () => { throw new Error("none"); }, analyze: () => ({}), devModels: null });
    const { rate, generatedStore, timers, ratings, handlers } = await setup({ fit: (payload) => jobs.run("fit-personal", payload) });
    // liked maps have a high first feature, disliked ones a low one; 16 votes, 8 of each
    const signal = CRITIC_FEATURES.indexOf("map_density_energy_corr");
    for (let i = 0; i < 16; i += 1) {
        const vote = i % 2 ? 1 : -1;
        const features = CRITIC_FEATURES.map((_, k) => (k === signal ? vote * 0.6 + 0.01 * i : ((k * 31 + i * 17) % 13) / 13));
        await rate({ id: storedVariant(generatedStore, { features }), vote, tags: vote < 0 ? ["offMusic"] : ["human"] });
    }
    await timers.runAll();
    await ratings.idle();
    const model = ratings.personal();
    assert.ok(model, "the model is active");
    assert.equal(model.n, 16);
    assert.ok(model.looAuc >= 0.6, `auc ${model.looAuc}`);
    assert.ok(model.w[model.names.indexOf("map_density_energy_corr")] > 0);
    const summary = await handlers["ratings-summary"]({});
    assert.equal(summary.active, true);
    assert.equal(summary.n, 16);
});
