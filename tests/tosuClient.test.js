import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { parseFrame, connectTosu } from "../app/tosuClient.js";
import { setLang } from "../src/i18n/i18n.js";

const frames = JSON.parse(await readFile(new URL("./fixtures/tosu-v2-frames.json", import.meta.url), "utf8"));

test("song select without mods", () => {
    assert.deepEqual(parseFrame(frames.songSelectNoMod), { state: "songselect", checksum: "aaa111", rate: 1, mods: [], client: null });
});

test("song select with DT uses tosu rate", () => {
    const f = parseFrame(frames.songSelectDT);
    assert.equal(f.rate, 1.5);
    assert.deepEqual(f.mods, ["DT"]);
});

test("HT without explicit rate falls back to 0.75", () => {
    const f = parseFrame(frames.playingHT);
    assert.equal(f.state, "playing");
    assert.equal(f.rate, 0.75);
});

test("NC from mod name string gives 1.5 and results state", () => {
    const f = parseFrame(frames.resultsNC);
    assert.equal(f.state, "results");
    assert.equal(f.rate, 1.5);
});

test("empty checksum becomes null in menu", () => {
    const f = parseFrame(frames.menuNoBeatmap);
    assert.equal(f.state, "menu");
    assert.equal(f.checksum, null);
});

function waitFor(predicate) {
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve();
            }
        }, 20);
    });
}

test("connectTosu reports down and reconnects", async () => {
    let server = new WebSocketServer({ port: 0, path: "/websocket/v2" });
    const port = server.address().port;
    const statuses = [];
    const received = [];
    server.on("connection", (ws) => ws.send(JSON.stringify(frames.songSelectNoMod)));

    const client = connectTosu({ port, retryMs: 100, onFrame: (f) => received.push(f), onStatus: (s) => statuses.push(s) });
    await waitFor(() => received.length === 1);
    assert.equal(received[0].checksum, "aaa111");
    assert.ok(statuses.includes("connected"));

    await new Promise((r) => { for (const c of server.clients) c.terminate(); server.close(r); });
    await waitFor(() => statuses.at(-1) === "down");

    server = new WebSocketServer({ port, path: "/websocket/v2" });
    await waitFor(() => statuses.at(-1) === "connected");
    client.close();
    await new Promise((r) => server.close(r));
});

// Electron's WebSocket fires "error" but never "close" when the port is refused.
class ErrorOnlySocket extends EventTarget {
    static created = 0;
    constructor() {
        super();
        ErrorOnlySocket.created += 1;
        setTimeout(() => this.dispatchEvent(new Event("error")), 5);
    }
    close() {}
}

test("reconnects when a socket only reports error (Electron behaviour)", async () => {
    ErrorOnlySocket.created = 0;
    const statuses = [];
    const client = connectTosu({ port: 1, retryMs: 20, WebSocketImpl: ErrorOnlySocket, onFrame: () => {}, onStatus: (s) => statuses.push(s) });
    await waitFor(() => ErrorOnlySocket.created >= 3);
    client.close();
    assert.ok(statuses.includes("down"));
});

class HangingSocket extends EventTarget {
    static created = 0;
    constructor() { super(); HangingSocket.created += 1; }
    close() {}
}

test("gives up on a connection that never opens", async () => {
    HangingSocket.created = 0;
    const client = connectTosu({ port: 1, retryMs: 10, connectTimeoutMs: 30, WebSocketImpl: HangingSocket, onFrame: () => {} });
    await waitFor(() => HangingSocket.created >= 2);
    client.close();
});

test("fetchCurrentOsu gives up on a server that never answers", async () => {
    const { createServer } = await import("node:http");
    const { fetchCurrentOsu } = await import("../app/tosuClient.js");
    const server = createServer(() => {});
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const t0 = Date.now();
    await assert.rejects(fetchCurrentOsu(server.address().port, { timeoutMs: 200 }));
    assert.ok(Date.now() - t0 < 2000);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
});

test("current beatmap path joins tosu's Songs folder and the map's relative path", async () => {
    const { createServer } = await import("node:http");
    const { fetchCurrentBeatmapPath } = await import("../app/tosuClient.js");
    const server = createServer((_q, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ folders: { songs: String.raw`A:\Games\osu!\Songs\ `.trim() }, directPath: { beatmapFile: String.raw`123 Песня\a (b) [c].osu` } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    assert.equal(await fetchCurrentBeatmapPath(server.address().port), String.raw`A:\Games\osu!\Songs\123 Песня\a (b) [c].osu`);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
});

test("tosu without a running osu! gives a plain-language reason", async () => {
    const { createServer } = await import("node:http");
    const { fetchCurrentBeatmapPath } = await import("../app/tosuClient.js");
    const server = createServer((_q, res) => { res.statusCode = 500; res.end("no osu"); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    await assert.rejects(fetchCurrentBeatmapPath(server.address().port), /открой osu! и выбери карту/);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
});

// fetch double for /json/v2: answers with status and body, records the url.
function fakeFetch(status, body, urls = []) {
    return async (url) => {
        urls.push(url);
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
}

test("fetchProfile reads the logged-in osu! account from tosu", async () => {
    const { fetchProfile } = await import("../app/tosuClient.js");
    const urls = [];
    const body = { profile: { id: 1234567, name: "TestPlayer", mode: { number: 3, name: "mania" } } };
    assert.deepEqual(await fetchProfile(24077, { fetchImpl: fakeFetch(200, body, urls) }), { id: 1234567, name: "TestPlayer" });
    assert.deepEqual(urls, ["http://127.0.0.1:24077/json/v2"]);
});

test("fetchProfile gives null when nobody is logged in or tosu cannot answer", async () => {
    const { fetchProfile } = await import("../app/tosuClient.js");
    const cases = [
        fakeFetch(500, { error: "no osu" }),
        fakeFetch(200, { profile: { id: 0, name: "Guest" } }),
        fakeFetch(200, { profile: { id: -3, name: "x" } }),
        fakeFetch(200, { profile: { name: "x" } }),
        fakeFetch(200, {}),
        fakeFetch(200, null),
        async () => { throw new TypeError("fetch failed"); },
        async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }),
    ];
    for (const fetchImpl of cases) assert.equal(await fetchProfile(24077, { fetchImpl }), null);
});

test("fetchProfile keeps the id when the name is missing", async () => {
    const { fetchProfile } = await import("../app/tosuClient.js");
    assert.deepEqual(await fetchProfile(1, { fetchImpl: fakeFetch(200, { profile: { id: 42 } }) }), { id: 42, name: "" });
});

test("fetchProfile gives up on a tosu that never answers", async () => {
    const { createServer } = await import("node:http");
    const { fetchProfile } = await import("../app/tosuClient.js");
    const server = createServer(() => {});
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
        const t0 = Date.now();
        assert.equal(await fetchProfile(server.address().port, { timeoutMs: 200 }), null);
        assert.ok(Date.now() - t0 < 2000);
    } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
});

test("tosu reasons in English", async () => {
    const { createServer } = await import("node:http");
    const { fetchCurrentBeatmapPath, fetchCurrentOsu } = await import("../app/tosuClient.js");
    let status = 500;
    const server = createServer((_q, res) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(status === 200 ? JSON.stringify({ folders: {} }) : "no osu");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    setLang("en");
    try {
        await assert.rejects(fetchCurrentBeatmapPath(port), { message: "open osu! and pick a map" });
        await assert.rejects(fetchCurrentOsu(port), { message: "tosu answered 500" });
        status = 200;
        await assert.rejects(fetchCurrentBeatmapPath(port), { message: "no map is selected in osu!" });
    } finally {
        setLang("ru");
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
});

test("fetchSongsFolder reads osu!'s Songs folder from tosu, or null", async () => {
    const { fetchSongsFolder } = await import("../app/tosuClient.js");
    const urls = [];
    assert.equal(await fetchSongsFolder(24077, { fetchImpl: fakeFetch(200, { folders: { songs: String.raw`C:\Games\osu!\Songs\ `.trim() } }, urls) }),
        String.raw`C:\Games\osu!\Songs`);
    assert.deepEqual(urls, ["http://127.0.0.1:24077/json/v2"]);
    const cases = [
        fakeFetch(500, { error: "no osu" }),
        fakeFetch(200, { folders: {} }),
        fakeFetch(200, { folders: { songs: "" } }),
        fakeFetch(200, { folders: { songs: 42 } }),
        fakeFetch(200, null),
        async () => { throw new TypeError("fetch failed"); },
        async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }),
    ];
    for (const fetchImpl of cases) assert.equal(await fetchSongsFolder(24077, { fetchImpl }), null);
});
