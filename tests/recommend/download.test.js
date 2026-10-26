import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDownloader, MIRRORS, oszName } from "../../src/recommend/download.js";
import { setLang } from "../../src/i18n/i18n.js";

const zip = (n = 5000) => Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(n - 4, 7)]);

// fetch that answers per URL prefix: a Buffer → 200 with that body, a number → that status, an Error → network failure.
function fakeFetch(routes, calls = []) {
    return async (url, options) => {
        calls.push({ url, options });
        const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
        const answer = key ? routes[key] : 404;
        if (answer instanceof Error) throw answer;
        if (typeof answer === "number") return new Response("nope", { status: answer });
        return new Response(answer, { status: 200, headers: { "content-length": String(answer.length) } });
    };
}

const dirFor = () => mkdtemp(path.join(tmpdir(), "скачать "));

test("mirrors build their URLs from the set id only", () => {
    assert.deepEqual(MIRRORS.map((m) => m.url(358342)), [
        "https://osu.direct/api/d/358342",
        "https://beatconnect.io/b/358342/",
        "https://dl.sayobot.cn/beatmaps/download/novideo/358342",
    ]);
});

test("file name: set id, artist and title, safe for Windows", () => {
    assert.equal(oszName(358342, "UNDEAD CORPORATION", "The Empress"), "358342 UNDEAD CORPORATION - The Empress.osz");
    assert.equal(oszName(1, 'a/b:c', 'd?"e*'), "1 a_b_c - d__e_.osz");
    assert.equal(oszName(7, "", ""), "7.osz");
});

test("downloads from the first mirror that answers, reports progress, keeps no temp files", async () => {
    const dir = await dirFor();
    const calls = [];
    const body = zip(300000);
    const progress = [];
    const d = createDownloader({ dir, fetchImpl: fakeFetch({ "https://osu.direct": 503, "https://beatconnect.io": body }, calls) });
    const r = await d.download({ beatmapsetId: 358342, artist: "UNDEAD CORPORATION", title: "The Empress", onProgress: (p) => progress.push(p) });
    assert.equal(r.file, path.join(dir, "358342 UNDEAD CORPORATION - The Empress.osz"));
    assert.equal(r.mirror, "beatconnect.io");
    assert.equal(r.reused, false);
    assert.deepEqual(await readFile(r.file), body);
    assert.deepEqual(await readdir(dir), ["358342 UNDEAD CORPORATION - The Empress.osz"]);
    assert.deepEqual(calls.map((c) => new URL(c.url).host), ["osu.direct", "beatconnect.io"]);
    assert.ok(calls.every((c) => /^lunacy-mania /.test(c.options.headers["user-agent"])));
    assert.ok(progress.length >= 1);
    assert.equal(progress.at(-1).received, body.length);
    assert.equal(progress.at(-1).total, body.length);
    assert.ok(progress.every((p, i) => i === 0 || p.received >= progress[i - 1].received));
});

test("a mirror that sends something other than a zip is skipped", async () => {
    const dir = await dirFor();
    const d = createDownloader({ dir, fetchImpl: fakeFetch({
        "https://osu.direct": Buffer.from("<html>cloudflare says hi</html>".padEnd(3000, " ")),
        "https://beatconnect.io": new Error("ECONNRESET"),
        "https://dl.sayobot.cn": zip(),
    }) });
    const r = await d.download({ beatmapsetId: 5, artist: "a", title: "b" });
    assert.equal(r.mirror, "dl.sayobot.cn");
    assert.deepEqual(await readdir(dir), ["5 a - b.osz"]);
});

test("all mirrors failing is one Russian error and leaves nothing behind", async () => {
    const dir = await dirFor();
    const d = createDownloader({ dir, fetchImpl: fakeFetch({ "https://osu.direct": 404, "https://beatconnect.io": 500, "https://dl.sayobot.cn": new Error("timeout") }) });
    await assert.rejects(d.download({ beatmapsetId: 9, artist: "a", title: "b" }), /не удалось скачать карту ни с одного зеркала/);
    assert.deepEqual(await readdir(dir), []);
});

test("too big a file is refused", async () => {
    const dir = await dirFor();
    const d = createDownloader({ dir, maxBytes: 10000, fetchImpl: fakeFetch({ "https://osu.direct": zip(20000), "https://beatconnect.io": 404, "https://dl.sayobot.cn": 404 }) });
    await assert.rejects(d.download({ beatmapsetId: 9, artist: "a", title: "b" }), /не удалось скачать/);
    assert.deepEqual(await readdir(dir), []);
});

test("an already downloaded set is reused without a request", async () => {
    const dir = await dirFor();
    await writeFile(path.join(dir, "3 a - b.osz"), zip());
    const calls = [];
    const d = createDownloader({ dir, fetchImpl: fakeFetch({}, calls) });
    const r = await d.download({ beatmapsetId: 3, artist: "a", title: "b" });
    assert.equal(r.reused, true);
    assert.equal(calls.length, 0);
});

test("two clicks on the same set share one download", async () => {
    const dir = await dirFor();
    const calls = [];
    const d = createDownloader({ dir, fetchImpl: fakeFetch({ "https://osu.direct": zip() }, calls) });
    const [a, b] = await Promise.all([1, 2].map(() => d.download({ beatmapsetId: 4, artist: "a", title: "b" })));
    assert.equal(a.file, b.file);
    assert.equal(calls.length, 1);
});

test("two tabs downloading the same set at once get one mirror download; only the first hears progress", async () => {
    const dir = await dirFor();
    const calls = [];
    const d = createDownloader({ dir, fetchImpl: fakeFetch({ "https://osu.direct": zip(600000) }, calls) });
    const heard = { picks: 0, marathon: 0 };
    const picks = d.download({ beatmapsetId: 6, artist: "a", title: "b", onProgress: () => { heard.picks += 1; } });
    const marathon = d.download({ beatmapsetId: 6, artist: "a", title: "b", onProgress: () => { heard.marathon += 1; } });
    assert.equal(picks, marathon, "the same promise");
    const [a, b] = await Promise.all([picks, marathon]);
    assert.equal(a.file, b.file);
    assert.equal(calls.length, 1);
    assert.ok(heard.picks >= 1);
    assert.equal(heard.marathon, 0);
    // once finished, the next call finds the file on disk
    assert.equal((await d.download({ beatmapsetId: 6, artist: "a", title: "b" })).reused, true);
    assert.equal(calls.length, 1);
});

test("a bad set id is refused before any request", async () => {
    const calls = [];
    const d = createDownloader({ dir: await dirFor(), fetchImpl: fakeFetch({}, calls) });
    for (const id of [0, -1, 1.5, "12", null, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(d.download({ beatmapsetId: id, artist: "a", title: "b" }), /неверный номер карты/);
    }
    assert.equal(calls.length, 0);
});

test("in English a failed download and a bad id are explained in English", async () => {
    const dir = await dirFor();
    const d = createDownloader({ dir, fetchImpl: fakeFetch({
        "https://osu.direct": 404,
        "https://beatconnect.io": Buffer.from("<html>".padEnd(3000, " ")),
        "https://dl.sayobot.cn": new Error("timeout"),
    }) });
    setLang("en");
    try {
        const error = await d.download({ beatmapsetId: 9, artist: "a", title: "b" }).then(() => null, (e) => e);
        assert.equal(error.message, "couldn't download the map from any mirror — try again later or open the map's page");
        assert.deepEqual(error.details, ["osu.direct answered with 404", "beatconnect.io sent something that isn't an .osz", "timeout"]);
        await assert.rejects(d.download({ beatmapsetId: 0, artist: "a", title: "b" }), { message: "invalid map id" });
    } finally {
        setLang("ru");
    }
    assert.deepEqual(await readdir(dir), []);
});
