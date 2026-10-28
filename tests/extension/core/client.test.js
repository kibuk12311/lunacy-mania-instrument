// shared/client.js against the fake chrome: answers pass through, it never rejects, a dead context is ERR.CONTEXT,
// nobody listening is ERR.CONTEXT, a port closed without an answer is tried once more, an abort cancels a download.
import test from "node:test";
import assert from "node:assert/strict";
import { createClient, errorOf } from "../../../extension/shared/client.js";
import { ERR, MSG, PORT_FETCH } from "../../../extension/shared/protocol.js";
import { createFakeChrome } from "../helpers/fakeChrome.js";

test("analyze, getOsu, info: the background's answers, the request as the protocol names it", async () => {
    const fake = createFakeChrome();
    fake.answer(MSG.ANALYZE, (m) => ({ ok: true, beatmapId: m.beatmapId, rate: m.rate, cached: false, meta: {}, result: { kind: "too-short" }, analyzer: {} }));
    fake.answer(MSG.OSU, (m) => ({ ok: true, beatmapId: m.beatmapId, text: "osu file format v14", md5: "x", meta: {} }));
    fake.answer(MSG.INFO, () => ({ ok: true, version: "0.1.0", analyzer: { fingerprint: "f", appVersion: "0.10.3" } }));
    const client = createClient(fake.chrome.runtime);
    const answer = await client.analyze({ beatmapId: 4961226, checksum: "18e40e4ddcbd746c9577e25e73f04d4a", rate: 1.2, lang: "ru", priority: "high" });
    assert.equal(answer.ok, true);
    assert.deepEqual(fake.sent[0], { type: MSG.ANALYZE, beatmapId: 4961226, checksum: "18e40e4ddcbd746c9577e25e73f04d4a", rate: 1.2, lang: "ru", priority: "high" });
    await client.analyze({ beatmapId: 1 });
    assert.deepEqual(fake.sent[1], { type: MSG.ANALYZE, beatmapId: 1, checksum: null, rate: 1, lang: "en", priority: "normal" });
    assert.equal((await client.getOsu({ beatmapId: 2 })).text, "osu file format v14");
    assert.equal((await client.info()).version, "0.1.0");
});

test("never rejects: invalidated context and no receiver are ERR.CONTEXT, with beatmapId and rate kept", async () => {
    const fake = createFakeChrome();
    const client = createClient(fake.chrome.runtime);
    const nobody = await client.analyze({ beatmapId: 5, rate: 1.1 });
    assert.deepEqual([nobody.ok, nobody.beatmapId, nobody.rate, nobody.error.code], [false, 5, 1.1, ERR.CONTEXT]);
    fake.invalidate();
    const dead = await client.analyze({ beatmapId: 5 });
    assert.equal(dead.error.code, ERR.CONTEXT);
    assert.equal((await client.getOsu({ beatmapId: 5 })).error.code, ERR.CONTEXT);
    assert.equal((await client.getPreview({ setId: 1 })).error.code, ERR.CONTEXT);
    assert.equal((await client.info()).error.code, ERR.CONTEXT);
    // no chrome at all (the module's default client in Node)
    assert.equal((await createClient(() => undefined).analyze({ beatmapId: 1 })).error.code, ERR.CONTEXT);
    assert.equal(errorOf(new Error("Extension context invalidated.")).code, ERR.CONTEXT);
    assert.equal(errorOf({ message: "Failed to fetch" }).code, ERR.NETWORK);
});

test("a port closed before the answer (the service worker went away) is asked once more", async () => {
    let n = 0;
    const runtime = {
        id: "x",
        lastError: undefined,
        sendMessage(message, callback) {
            n += 1;
            setTimeout(() => {
                if (n === 1) {
                    runtime.lastError = { message: "The message port closed before a response was received." };
                    callback(undefined);
                    runtime.lastError = undefined;
                } else callback({ ok: true, version: "0.1.0" });
            }, 0);
        },
    };
    const answer = await createClient(runtime).info();
    assert.deepEqual(answer, { ok: true, version: "0.1.0" });
    assert.equal(n, 2);
});

// a promise, or a failure after `ms` (a bound, so a missing event fails the test instead of hanging it)
function within(promise, what, ms = 5000) {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no ${what} in ${ms} ms`)), ms); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test("downloads: an aborted signal cancels and tells the background; a dropped port is an error", async () => {
    const fake = createFakeChrome();
    const seen = [];
    let closedFirst;
    const firstClosed = new Promise((r) => { closedFirst = r; });
    fake.chrome.runtime.onConnect.addListener((port) => {
        assert.equal(port.name, PORT_FETCH);
        port.onDisconnect.addListener(() => closedFirst());
        port.onMessage.addListener((m) => {
            seen.push(m);
            if (m.type === "get" && m.setId === 1) port.postMessage({ type: "meta", contentType: "audio/ogg", total: 100, fileName: "1.mp3" });
            if (m.type === "get" && m.setId === 2) setTimeout(() => port.disconnect(), 5);
        });
    });
    const client = createClient(fake.chrome.runtime);
    const controller = new AbortController();
    const progress = [];
    let gotMeta;
    const metaSeen = new Promise((r) => { gotMeta = r; });
    const pending = client.getPreview({ setId: 1, signal: controller.signal, onProgress: (p) => { progress.push(p); gotMeta(); } });
    // wait for the meta to arrive (an event, not a fixed sleep: a loaded machine may need more than a few ms)
    await within(metaSeen, "the meta message");
    controller.abort();
    assert.deepEqual(await pending, { ok: false, error: { code: ERR.CANCELLED } });
    // the background's end of the port sees the close; anything posted before it has been delivered by then
    await within(firstClosed, "the port closing");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen.map((m) => m.type), ["get"], "the cancel went out before the port closed or the port closed");
    assert.deepEqual(progress, [{ received: 0, total: 100 }]);

    const early = new AbortController();
    early.abort();
    assert.equal((await client.getOsz({ setId: 1, signal: early.signal })).error.code, ERR.CANCELLED);
    const dropped = await client.getOsz({ setId: 2 });
    assert.equal(dropped.ok, false);
    assert.equal(dropped.error.code, ERR.NETWORK);
});
