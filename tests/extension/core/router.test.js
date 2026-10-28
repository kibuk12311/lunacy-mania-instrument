// background/router.js with fakes: rule R1, validation, the .osu and result caches (checksum, 24 h), concurrent asks
// sharing one fetch and one analysis, errors, and the lm:fetch port end to end through shared/client.js and the
// fake chrome (JSON-only messaging, base64 chunks ≤ 1 MiB, progress, cancel). Also offscreen.js's R1 listener.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRouter, toId, validateAnalyze } from "../../../extension/background/router.js";
import { createAnalysisHost } from "../../../extension/background/analysisHost.js";
import { createCache, memoryBackend } from "../../../extension/background/cache.js";
import { createClient } from "../../../extension/shared/client.js";
import { md5Hex } from "../../../extension/shared/md5.js";
import { readOsuMeta } from "../../../extension/shared/osuMeta.js";
import { CHUNK_BYTES, base64ToBytes } from "../../../extension/shared/transfer.js";
import { ERR, MSG, OFFSCREEN_TARGET, PORT_FETCH } from "../../../extension/shared/protocol.js";
import { makeChart } from "../../fixtures/makeChart.js";
import { createFakeChrome } from "../helpers/fakeChrome.js";

const CHART = makeChart({ kind: "jumpstream", seconds: 30 });
const CHART_MD5 = md5Hex(new TextEncoder().encode(CHART));
const delay = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function setup({ osuText = () => CHART, analyzeAnswer, now: nowFn, opened } = {}) {
    const calls = { osu: [], analyze: [], open: [] };
    let t = 1_000_000;
    const now = nowFn ?? (() => t);
    const fetchers = {
        async fetchOsu(id) {
            calls.osu.push(id);
            await delay(2);
            const text = osuText(id);
            if (text instanceof Error) return { ok: false, error: { code: text.message } };
            return { ok: true, beatmapId: id, text, md5: md5Hex(new TextEncoder().encode(text)), fetchedAt: now() };
        },
        async openPreview(setId, { signal }) {
            calls.open.push({ what: "preview", setId, signal });
            return opened ? opened("preview", setId, signal) : { ok: false, error: { code: ERR.NOT_FOUND, status: 404 } };
        },
        async openOsz(setId, { signal, noVideo }) {
            calls.open.push({ what: "osz", setId, signal, noVideo });
            return opened ? opened("osz", setId, signal) : { ok: false, error: { code: ERR.LOGIN } };
        },
    };
    const runner = {
        async run({ text, rate }) {
            calls.analyze.push({ text, rate });
            await delay(2);
            return analyzeAnswer ? analyzeAnswer(text, rate) : { ok: true, result: { kind: "ok", label: "Gamma low", numeric: 12.6, confidence: "high", confidenceLevel: "high", rate } };
        },
        reset() {},
    };
    const backend = memoryBackend();
    const cache = createCache({ backend, now });
    const router = createRouter({
        fetchers, cache, host: createAnalysisHost({ runner }), readOsuMeta, now,
        relabel: (r, lang) => (r.kind === "ok" ? { ...r, label: `${r.label} (${lang})` } : r),
        analyzer: { fingerprint: "fp0123456789abcd", appVersion: "0.10.3" }, version: "0.1.0", runtimeId: "lmfakeextensionid",
    });
    return { router, calls, backend, cache, advance: (ms) => (t += ms) };
}

// sends one message straight to router.onMessage → { returned, answer }
function ask(router, message, sender = { id: "lmfakeextensionid" }) {
    return new Promise((resolve) => {
        let answered = false;
        const returned = router.onMessage(message, sender, (answer) => {
            answered = true;
            resolve({ returned, answer });
        });
        if (returned !== true) setTimeout(() => resolve({ returned, answer: answered ? "answered anyway" : undefined }), 10);
    });
}

test("toId and validateAnalyze", () => {
    assert.equal(toId(5), 5);
    assert.equal(toId("12"), 12);
    assert.equal(toId(0), null);
    assert.equal(toId(-1), null);
    assert.equal(toId(1.5), null);
    assert.equal(toId("1e3"), null);
    assert.equal(toId(null), null);
    assert.deepEqual(validateAnalyze({ beatmapId: "7", rate: 1.2000001, lang: "ru", priority: "high", checksum: CHART_MD5.toUpperCase() }),
        { beatmapId: 7, checksum: CHART_MD5, rate: 1.2, lang: "ru", priority: "high" });
    assert.deepEqual(validateAnalyze({ beatmapId: 7, lang: "de", priority: "urgent", checksum: "nope" }),
        { beatmapId: 7, checksum: null, rate: 1, lang: "en", priority: "normal" });
    assert.equal(validateAnalyze({ beatmapId: 0 }).error.code, ERR.BAD_REQUEST);
    assert.equal(validateAnalyze({ beatmapId: 1, rate: 2.5 }).error.code, ERR.BAD_REQUEST);
    assert.equal(validateAnalyze({ beatmapId: 1, rate: 0.4 }).error.code, ERR.BAD_REQUEST);
    assert.equal(validateAnalyze({ beatmapId: 1, rate: "fast" }).error.code, ERR.BAD_REQUEST);
});

test("R1: only its own types, never targeted messages, true only when it answers", async () => {
    const { router } = setup();
    for (const message of [null, "lm:analyze", {}, { type: "lm:unknown" }, { type: "lm:job", target: OFFSCREEN_TARGET },
        { type: MSG.ANALYZE, target: OFFSCREEN_TARGET, beatmapId: 1 }, { type: "close", source: "lunacy-mania-player" }, { type: "toString" }]) {
        const { returned, answer } = await ask(router, message);
        assert.equal(returned, undefined, JSON.stringify(message));
        assert.equal(answer, undefined);
    }
    const foreign = await ask(router, { type: MSG.INFO }, { id: "someone-else" });
    assert.equal(foreign.returned, undefined, "another extension's message");
    const info = await ask(router, { type: MSG.INFO });
    assert.equal(info.returned, true);
    assert.deepEqual(info.answer, { ok: true, version: "0.1.0", analyzer: { fingerprint: "fp0123456789abcd", appVersion: "0.10.3" } });
});

test("analyze: validation errors keep beatmapId and rate; the answer has meta, worded result, analyzer", async () => {
    const { router, calls } = setup();
    const bad = (await ask(router, { type: MSG.ANALYZE, beatmapId: "x", rate: 1 })).answer;
    assert.deepEqual(bad.error.code, ERR.BAD_REQUEST);
    assert.equal(bad.ok, false);
    assert.equal((await ask(router, { type: MSG.ANALYZE, beatmapId: 3, rate: 3 })).answer.rate, 3);
    assert.equal(calls.osu.length, 0);

    const { answer } = await ask(router, { type: MSG.ANALYZE, beatmapId: 3, rate: 1.2, lang: "ru", priority: "high" });
    assert.equal(answer.ok, true);
    assert.equal(answer.beatmapId, 3);
    assert.equal(answer.rate, 1.2);
    assert.equal(answer.cached, false);
    assert.equal(answer.result.label, "Gamma low (ru)");
    assert.equal(answer.result.rate, 1.2);
    assert.equal(answer.meta.keys, 4);
    assert.equal(answer.meta.mode, 3);
    assert.deepEqual(answer.analyzer, { fingerprint: "fp0123456789abcd", appVersion: "0.10.3" });
    assert.deepEqual(calls.analyze.map((c) => c.rate), [1.2]);
});

test("concurrent asks for one key share one fetch and one analysis; the next ask is cached", async () => {
    const { router, calls, backend } = setup();
    const answers = await Promise.all([1, 2, 3].map(() => ask(router, { type: MSG.ANALYZE, beatmapId: 5, rate: 1, lang: "en" })));
    assert.ok(answers.every((a) => a.answer.ok));
    assert.equal(calls.osu.length, 1);
    assert.equal(calls.analyze.length, 1);
    assert.ok(backend.stores.results.has(`fp0123456789abcd|${CHART_MD5}|1.00`), "the result key: fingerprint|md5|rate");
    const again = (await ask(router, { type: MSG.ANALYZE, beatmapId: 5, rate: 1, lang: "ru" })).answer;
    assert.equal(again.cached, true);
    assert.equal(again.result.label, "Gamma low (ru)");
    assert.equal(calls.analyze.length, 1);
    // another rate of the same .osu: no new fetch, a new analysis
    await ask(router, { type: MSG.ANALYZE, beatmapId: 5, rate: 1.5 });
    assert.equal(calls.osu.length, 1);
    assert.equal(calls.analyze.length, 2);
});

test("the cached .osu counts while its md5 is the checksum, or (no checksum) for 24 h", async () => {
    let version = 1;
    const texts = { 1: CHART, 2: makeChart({ kind: "stream", seconds: 30 }) };
    const { router, calls, advance } = setup({ osuText: () => texts[version] });
    await ask(router, { type: MSG.ANALYZE, beatmapId: 9, checksum: CHART_MD5 });
    await ask(router, { type: MSG.ANALYZE, beatmapId: 9, checksum: CHART_MD5 });
    assert.equal(calls.osu.length, 1, "checksum matches");
    advance(23 * 60 * 60 * 1000);
    await ask(router, { type: MSG.ANALYZE, beatmapId: 9 });
    assert.equal(calls.osu.length, 1, "fresh enough without a checksum");
    advance(2 * 60 * 60 * 1000);
    await ask(router, { type: MSG.ANALYZE, beatmapId: 9 });
    assert.equal(calls.osu.length, 2, "older than a day without a checksum");
    version = 2;
    const updated = (await ask(router, { type: MSG.ANALYZE, beatmapId: 9, checksum: md5Hex(new TextEncoder().encode(texts[2])) })).answer;
    assert.equal(calls.osu.length, 3, "the map changed on osu!");
    assert.equal(updated.meta.title, "Synthetic stream");
    const osu = (await ask(router, { type: MSG.OSU, beatmapId: 9 })).answer;
    assert.equal(osu.ok, true);
    assert.equal(osu.text, texts[2]);
    assert.equal(osu.meta.title, "Synthetic stream");
    assert.equal(calls.osu.length, 3);
});

test("errors: a failed .osu, a failed analysis, error results are not cached, cache clear", async () => {
    let fail = true;
    const { router, calls, backend } = setup({
        osuText: (id) => (id === 404 ? new Error(ERR.NOT_FOUND) : CHART),
        analyzeAnswer: () => (fail ? { ok: true, result: { kind: "error", message: "none of the calculators could rate this map" } } : { ok: false, code: ERR.TIMEOUT, message: "slow" }),
    });
    const missing = (await ask(router, { type: MSG.ANALYZE, beatmapId: 404 })).answer;
    assert.deepEqual(missing, { ok: false, beatmapId: 404, rate: 1, error: { code: ERR.NOT_FOUND } });
    assert.equal((await ask(router, { type: MSG.OSU, beatmapId: 404 })).answer.error.code, ERR.NOT_FOUND);
    const errorResult = (await ask(router, { type: MSG.ANALYZE, beatmapId: 1 })).answer;
    assert.equal(errorResult.ok, true);
    assert.equal(errorResult.result.kind, "error");
    assert.equal(backend.stores.results.size, 0, "an error result is not kept");
    fail = false;
    const timedOut = (await ask(router, { type: MSG.ANALYZE, beatmapId: 1 })).answer;
    assert.deepEqual(timedOut.error, { code: ERR.TIMEOUT, message: "slow" });
    assert.equal(calls.analyze.length, 2);
    assert.deepEqual((await ask(router, { type: MSG.CACHE_CLEAR })).answer, { ok: true });
    assert.equal(backend.stores.osu.size, 0);
});

// a body of n bytes in uneven pieces
async function* piecesOf(bytes, size = 300_000) {
    for (let i = 0; i < bytes.length; i += size) {
        await delay(0);
        yield bytes.subarray(i, i + size);
    }
}

test("the lm:fetch port through client.js: chunks ≤ 1 MiB, progress, the bytes intact; errors by code", async () => {
    const body = new Uint8Array(randomBytes(CHUNK_BYTES * 2 + 12_345));
    const { router, calls } = setup({
        opened: (what, setId) => (setId === 1
            ? { ok: true, contentType: what === "preview" ? "audio/ogg" : "application/x-osu-beatmap-archive", total: body.length, fileName: `${setId}.${what === "preview" ? "mp3" : "osz"}`, pieces: piecesOf(body) }
            : { ok: false, error: { code: what === "osz" ? ERR.LOGIN : ERR.NOT_FOUND, status: 404 } }),
    });
    const fake = createFakeChrome();
    fake.chrome.runtime.onConnect.addListener(router.onConnect);
    const client = createClient(fake.chrome.runtime);

    const progress = [];
    const preview = await client.getPreview({ setId: 1, onProgress: (p) => progress.push(p) });
    assert.equal(preview.ok, true);
    assert.equal(preview.contentType, "audio/ogg");
    assert.deepEqual(preview.bytes, body);
    assert.ok(progress.length >= 3 && progress.at(-1).received === body.length && progress.at(-1).total === body.length);
    const background = fake.ports[0];
    assert.equal(background.name, PORT_FETCH);
    assert.deepEqual(background.posted[0], { type: "get", what: "preview", setId: 1 });

    const osz = await client.getOsz({ setId: 1 });
    assert.equal(osz.ok, true);
    assert.equal(osz.fileName, "1.osz");
    assert.deepEqual(osz.bytes, body);
    assert.equal(calls.open.at(-1).noVideo, true);
    assert.deepEqual(fake.ports[1].posted[0], { type: "get", what: "osz", setId: 1, noVideo: true });

    assert.deepEqual(await client.getOsz({ setId: 2 }), { ok: false, error: { code: ERR.LOGIN, status: 404 } });
    assert.deepEqual((await client.getPreview({ setId: 2 })).error.code, ERR.NOT_FOUND);
    assert.equal((await client.getPreview({ setId: -4 })).error.code, ERR.BAD_REQUEST);
});

test("the port's messages: meta first, chunks of at most 1 MiB, done last; cancel and disconnect abort the fetch", async () => {
    const body = new Uint8Array(randomBytes(CHUNK_BYTES + 10));
    let stall = null;
    const { router, calls } = setup({
        opened: (what, setId, signal) => {
            if (setId === 1) return { ok: true, contentType: "audio/ogg", total: null, fileName: "1.mp3", pieces: piecesOf(body, 100_000) };
            return {
                ok: true, contentType: "x", total: 10, fileName: "x",
                pieces: (async function* slow() {
                    yield new Uint8Array(5);
                    await new Promise((resolve, reject) => {
                        stall = resolve;
                        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                    });
                })(),
            };
        },
    });
    // the background end, watched directly
    const port = makePortPair();
    router.onConnect(port.background);
    port.client.post({ type: "get", what: "preview", setId: 1 });
    for (let i = 0; i < 200 && port.client.received.at(-1)?.type !== "done"; i += 1) await delay(10);
    const seen = port.client.received;
    assert.equal(seen[0].type, "meta");
    assert.deepEqual(seen[0], { type: "meta", contentType: "audio/ogg", total: null, fileName: "1.mp3" });
    assert.equal(seen.at(-1).type, "done");
    assert.equal(seen.at(-1).received, body.length);
    const chunks = seen.filter((m) => m.type === "chunk").map((m) => base64ToBytes(m.data));
    assert.deepEqual(chunks.map((c) => c.length), [CHUNK_BYTES, 10]);
    assert.ok(seen.some((m) => m.type === "progress"));
    port.client.post({ type: "get", what: "preview", setId: 1 });
    await delay(20);
    assert.equal(calls.open.length, 1, "one download per port");

    const second = makePortPair();
    router.onConnect(second.background);
    second.client.post({ type: "get", what: "osz", setId: 2 });
    await delay(10);
    second.client.post({ type: "cancel" });
    await delay(10);
    assert.equal(calls.open[1].signal.aborted, true);
    assert.ok(!second.client.received.some((m) => m.type === "done" || m.type === "error"), "nothing after a cancel");

    const third = makePortPair();
    router.onConnect(third.background);
    third.client.post({ type: "get", what: "osz", setId: 3 });
    await delay(10);
    third.client.disconnect();
    await delay(10);
    assert.equal(calls.open[2].signal.aborted, true);
    stall?.();

    // ports of another name are not ours
    const other = makePortPair("something-else");
    router.onConnect(other.background);
    other.client.post({ type: "get", what: "preview", setId: 1 });
    await delay(10);
    assert.equal(calls.open.length, 3);
});

// A pair of plain port ends (no JSON round trip), for watching what the background posts.
function makePortPair(name = PORT_FETCH) {
    const listeners = { message: [], disconnect: [] };
    const received = [];
    const background = {
        name,
        sender: { id: "lmfakeextensionid" },
        postMessage: (m) => received.push(JSON.parse(JSON.stringify(m))),
        disconnect() {},
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
        onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    };
    return {
        background,
        client: {
            received,
            post: (m) => listeners.message.forEach((fn) => fn(m, background)),
            disconnect: () => listeners.disconnect.forEach((fn) => fn(background)),
        },
    };
}

test("offscreen.js follows R1: only target lm-offscreen and its own types", async () => {
    const fake = createFakeChrome();
    const made = [];
    globalThis.chrome = fake.chrome;
    globalThis.Worker = class extends EventTarget {
        constructor(url, options) {
            super();
            made.push({ url: String(url), options });
        }
        postMessage({ id, rate }) {
            setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: { id, ok: true, result: { kind: "ok", rate } } })), 0);
        }
        terminate() {}
    };
    try {
        await import("../../../extension/offscreen/offscreen.js");
        const [listener] = fake.chrome.runtime.onMessage.listeners;
        const call = (message) => new Promise((resolve) => {
            const returned = listener(message, { id: fake.chrome.runtime.id }, (answer) => resolve({ returned, answer }));
            if (returned !== true) setTimeout(() => resolve({ returned }), 10);
        });
        for (const message of [{ type: "lm:job" }, { type: MSG.ANALYZE, beatmapId: 1 }, { target: OFFSCREEN_TARGET, type: "lm:other" }, null]) {
            assert.equal((await call(message)).returned, undefined, JSON.stringify(message));
        }
        assert.equal(made.length, 0, "no worker until a job");
        const job = await call({ target: OFFSCREEN_TARGET, type: "lm:job", jobId: 1, text: "x", rate: 1.3 });
        assert.equal(job.returned, true);
        assert.deepEqual(job.answer, { ok: true, result: { kind: "ok", rate: 1.3 } });
        assert.equal(made.length, 1);
        assert.match(made[0].url, /analysis\/worker\.js$/);
        assert.deepEqual(made[0].options, { type: "module" });
    } finally {
        delete globalThis.chrome;
        delete globalThis.Worker;
    }
});
