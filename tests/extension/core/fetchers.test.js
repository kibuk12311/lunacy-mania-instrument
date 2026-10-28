// background/fetchers.js with a fake fetch (no network): the requests it makes, the .osu with md5 and the 429
// retry, the preview, and every answer osu! can give the .osz download (logged out, limit, html, zip, foreign host).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ERR } from "../../../extension/shared/protocol.js";
import { md5Hex } from "../../../extension/shared/md5.js";
import {
    createFetchers, dispositionName, isPpyUrl, oszUrl, osuUrl, previewUrl, readError, retryAfterMs,
} from "../../../extension/background/fetchers.js";
import { makeChart } from "../../fixtures/makeChart.js";
import { makeZip } from "../fixtures/zip.js";

function respond(body, { status = 200, headers = {}, url } = {}) {
    const response = new Response(body, { status, headers });
    Object.defineProperty(response, "url", { value: url });
    return response;
}

// routes: (url, init) → Response | Error to throw; records every call
function fakeFetch(route) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        calls.push({ url, init });
        if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
        const out = await route(url, init, calls.length);
        if (out instanceof Error) throw out;
        return out;
    };
    return { fetch, calls };
}

const collect = async (pieces) => {
    const parts = [];
    for await (const p of pieces) parts.push(Buffer.from(p));
    return Buffer.concat(parts);
};

test("URLs and helpers", () => {
    assert.equal(osuUrl(4961226), "https://osu.ppy.sh/osu/4961226");
    assert.equal(previewUrl(2316993), "https://b.ppy.sh/preview/2316993.mp3");
    assert.equal(oszUrl(2316993), "https://osu.ppy.sh/beatmapsets/2316993/download?noVideo=1");
    assert.equal(oszUrl(2316993, false), "https://osu.ppy.sh/beatmapsets/2316993/download");
    assert.ok(isPpyUrl("https://osu.ppy.sh/x") && isPpyUrl("https://bm1.ppy.sh/d/1") && isPpyUrl("https://ppy.sh/"));
    assert.ok(!isPpyUrl("https://evilppy.sh/") && !isPpyUrl("http://osu.ppy.sh/") && !isPpyUrl("https://ppy.sh.example.com/") && !isPpyUrl("nonsense"));
    assert.equal(retryAfterMs("3"), 3000);
    assert.equal(retryAfterMs("120"), 10_000);
    assert.equal(retryAfterMs(null), 2000);
    assert.equal(retryAfterMs(new Date(5000).toUTCString(), 1000), 4000);
    assert.equal(dispositionName('attachment; filename="2316993 Dan pack.osz"'), "2316993 Dan pack.osz");
    assert.equal(dispositionName("attachment; filename*=UTF-8''%D0%94%D0%B0%D0%BD.osz; filename=\"x.osz\""), "Дан.osz");
    assert.equal(dispositionName(null), null);
});

test("fetchOsu: no cookies, md5 of the bytes, UTF-8 text, 404, html, network errors", async () => {
    const text = `${makeChart({ seconds: 10 })}\r\n// Версия`;
    const bytes = Buffer.from(text, "utf8");
    const { fetch, calls } = fakeFetch((url) => {
        if (url.endsWith("/osu/1")) return respond(bytes, { headers: { "content-type": "text/plain;charset=UTF-8" }, url });
        if (url.endsWith("/osu/2")) return respond("", { status: 404, url });
        if (url.endsWith("/osu/3")) return respond("<html>challenge</html>", { headers: { "content-type": "text/html" }, url });
        if (url.endsWith("/osu/4")) return new TypeError("Failed to fetch");
        if (url.endsWith("/osu/5")) return respond("", { status: 200, url });
        return respond("", { status: 500, url });
    });
    const f = createFetchers({ fetch, md5Hex, now: () => 42 });
    const ok = await f.fetchOsu(1);
    assert.equal(ok.ok, true);
    assert.equal(ok.text, text);
    assert.equal(ok.md5, createHash("md5").update(bytes).digest("hex"));
    assert.equal(ok.fetchedAt, 42);
    assert.equal(calls[0].url, "https://osu.ppy.sh/osu/1");
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal((await f.fetchOsu(2)).error.code, ERR.NOT_FOUND);
    assert.equal((await f.fetchOsu(3)).error.code, ERR.HTTP);
    assert.equal((await f.fetchOsu(4)).error.code, ERR.NETWORK);
    assert.equal((await f.fetchOsu(5)).error.code, ERR.NOT_FOUND);
    const other = await f.fetchOsu(6);
    assert.deepEqual([other.error.code, other.error.status], [ERR.HTTP, 500]);
});

test("fetchOsu: 429 waits Retry-After (at most 10 s) and tries once more, then rate-limited", async () => {
    const waits = [];
    let n = 0;
    const { fetch } = fakeFetch((url) => {
        n += 1;
        if (url.endsWith("/osu/7") && n === 1) return respond("", { status: 429, headers: { "retry-after": "60" }, url });
        if (url.endsWith("/osu/7")) return respond("osu file format v14", { url });
        return respond("", { status: 429, headers: { "retry-after": "1" }, url });
    });
    const f = createFetchers({ fetch, md5Hex, sleep: async (ms) => waits.push(ms) });
    assert.equal((await f.fetchOsu(7)).ok, true);
    const limited = await f.fetchOsu(8);
    assert.deepEqual([limited.error.code, limited.error.status], [ERR.RATE_LIMITED, 429]);
    assert.deepEqual(waits, [10_000, 1000]);
});

test("fetchOsu: a stalled request or body gives up after the timeout (a network error, not the analysis timeout) and frees its slot", async () => {
    // like a real fetch: the signal rejects the request and errors a body being read
    const abortError = () => new DOMException("aborted", "AbortError");
    const { fetch, calls } = fakeFetch((url, init) => {
        if (url.endsWith("/osu/1") || url.endsWith("/osu/2")) {
            return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(abortError()), { once: true }));
        }
        if (url.endsWith("/osu/3")) {
            const body = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("osu file format v14 "));
                    init.signal.addEventListener("abort", () => controller.error(abortError()), { once: true });
                },
            });
            return respond(body, { url });
        }
        return respond("osu file format v14", { url });
    });
    const f = createFetchers({ fetch, md5Hex, osuTimeoutMs: 30 });
    const stalled = [f.fetchOsu(1), f.fetchOsu(2), f.fetchOsu(3)];
    const later = f.fetchOsu(4);
    const answers = await Promise.all(stalled);
    for (const a of answers) assert.deepEqual(a, { ok: false, error: { code: ERR.NETWORK, message: ".osu: no answer in 0 s" } });
    assert.ok(calls.every((c) => c.init.signal instanceof AbortSignal));
    assert.equal((await later).ok, true, "the slots came free");
});

test("fetchOsu: at most two requests in flight", async () => {
    let active = 0;
    let most = 0;
    const { fetch } = fakeFetch(async (url) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return respond("osu file format v14", { url });
    });
    const f = createFetchers({ fetch, md5Hex });
    const all = await Promise.all([1, 2, 3, 4, 5].map((id) => f.fetchOsu(id)));
    assert.ok(all.every((r) => r.ok));
    assert.equal(most, 2);
});

test("openPreview: no cookies, the bytes in pieces, 404, a foreign host", async () => {
    const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(5000, 3)]);
    const { fetch, calls } = fakeFetch((url) => {
        if (url.includes("/preview/1.mp3")) return respond(ogg, { headers: { "content-type": "audio/ogg", "content-length": String(ogg.length) }, url });
        if (url.includes("/preview/2.mp3")) return respond("", { status: 404, url });
        return respond(ogg, { url: "https://cdn.example.com/x.mp3" });
    });
    const f = createFetchers({ fetch, md5Hex });
    const ok = await f.openPreview(1);
    assert.equal(ok.ok, true);
    assert.equal(ok.contentType, "audio/ogg");
    assert.equal(ok.total, ogg.length);
    assert.ok((await collect(ok.pieces)).equals(ogg));
    assert.equal(calls[0].url, "https://b.ppy.sh/preview/1.mp3");
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal((await f.openPreview(2)).error.code, ERR.NOT_FOUND);
    assert.equal((await f.openPreview(3)).error.code, ERR.HOST);
    assert.equal(f.streamPreview, f.openPreview);
});

test("openOsz: with the user's cookies; logged out → login, 429 → limit, html/not PK → not-zip, PK → bytes", async () => {
    const osz = Buffer.from(makeZip([{ name: "a.osu", data: makeChart({ seconds: 5 }) }]));
    const setPage = (id) => `https://osu.ppy.sh/beatmapsets/${id}`;
    const { fetch, calls } = fakeFetch((url) => {
        const id = Number(/beatmapsets\/(\d+)/.exec(url)[1]);
        switch (id) {
            case 1: return respond(osz, { headers: { "content-type": "application/x-osu-beatmap-archive", "content-disposition": 'attachment; filename="1 A - B.osz"' }, url: "https://bm1.ppy.sh/d/1?fs=x" });
            case 2: return respond("<!doctype html><meta http-equiv=refresh>", { headers: { "content-type": "text/html; charset=UTF-8" }, url: setPage(2) });
            case 3: return respond("", { status: 429, url });
            case 4: return respond("", { status: 401, url });
            case 5: return respond("", { status: 404, url });
            case 6: return respond("", { status: 451, url });
            case 7: return respond("<html>maintenance</html>", { headers: { "content-type": "text/html" }, url: "https://osu.ppy.sh/home" });
            case 8: return respond(Buffer.from("not a zip but some bytes"), { headers: { "content-type": "application/octet-stream" }, url: "https://bm1.ppy.sh/d/8" });
            case 9: return respond(osz, { url: "https://files.example.net/9.osz" });
            case 10: return new TypeError("Failed to fetch");
            case 11: return respond(osz, { headers: { "content-length": String(400 * 1024 * 1024) }, url: "https://bm1.ppy.sh/d/11" });
            case 12: return respond(Buffer.from("not a zip"), { url: setPage(12) });
            case 13: return respond("", { status: 503, url });
            default: return respond("", { status: 500, url });
        }
    });
    const f = createFetchers({ fetch, md5Hex });
    const ok = await f.openOsz(1);
    assert.equal(ok.ok, true);
    assert.equal(ok.fileName, "1 A - B.osz");
    assert.ok((await collect(ok.pieces)).equals(osz));
    assert.equal(calls[0].url, "https://osu.ppy.sh/beatmapsets/1/download?noVideo=1");
    assert.equal(calls[0].init.credentials, "include");
    assert.equal(calls[0].init.redirect, "follow");
    const code = async (id) => (await f.openOsz(id)).error;
    assert.equal((await code(2)).code, ERR.LOGIN);
    assert.equal((await code(3)).code, ERR.LIMIT);
    assert.equal((await code(4)).code, ERR.LOGIN);
    assert.equal((await code(5)).code, ERR.NOT_FOUND);
    assert.equal((await code(6)).code, ERR.DISABLED);
    assert.equal((await code(7)).code, ERR.NOT_ZIP);
    assert.equal((await code(8)).code, ERR.NOT_ZIP);
    assert.equal((await code(9)).code, ERR.HOST);
    assert.equal((await code(10)).code, ERR.NETWORK);
    assert.equal((await code(11)).code, ERR.TOO_BIG);
    assert.equal((await code(12)).code, ERR.LOGIN);
    assert.deepEqual(await code(13), { code: ERR.HTTP, status: 503 });
    const withVideo = await f.openOsz(1, { noVideo: false });
    assert.equal(withVideo.ok, true);
    assert.equal(calls.at(-1).url, "https://osu.ppy.sh/beatmapsets/1/download");
});

test("openOsz: a body that grows past the cap while streaming stops with too-big; an abort is cancelled", async () => {
    const head = Buffer.from([0x50, 0x4b, 3, 4]);
    const stream = (n, size) => new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(head));
            for (let i = 0; i < n; i += 1) controller.enqueue(new Uint8Array(size));
            controller.close();
        },
    });
    const { fetch } = fakeFetch((url) => respond(stream(4, 1024 * 1024), { url: "https://bm1.ppy.sh/d/1" }));
    const { OSZ_CAP_BYTES } = await import("../../../extension/background/fetchers.js");
    assert.equal(OSZ_CAP_BYTES, 300 * 1024 * 1024);
    const f = createFetchers({ fetch, md5Hex });
    const opened = await f.openOsz(1);
    assert.equal(opened.ok, true);
    const got = await collect(opened.pieces);
    assert.equal(got.length, 4 + 4 * 1024 * 1024);

    const small = createFetchers({ fetch, md5Hex, caps: { osz: 2 * 1024 * 1024 } });
    const capped = await small.openOsz(1);
    assert.equal(capped.ok, true, "no Content-Length: the cap is met while streaming");
    await assert.rejects(collect(capped.pieces), (e) => readError(e, ".osz").error.code === ERR.TOO_BIG);

    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await f.openOsz(1, { signal: aborted.signal })).error.code, ERR.CANCELLED);
});
