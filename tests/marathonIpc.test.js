// The marathon tab's channels, registered the way main.js does it, with fakes for the shared services.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerMarathonIpc } from "../app/marathonIpc.js";
import { buildOsz } from "../src/gen/osz.js";
import { cutRange } from "../src/rate/marathon.js";
import { numericToLabel } from "../src/core/labels.js";
import { makeChart } from "./fixtures/makeChart.js";

const chart = (beatmapId, setId) => makeChart({ kind: "stream", bpm: 160, seconds: 20 })
    .replace("[Metadata]", `[Metadata]\r\nBeatmapID:${beatmapId}\r\nBeatmapSetID:${setId}`)
    .replace(/^Version:.*$/m, `Version:V${beatmapId}`);
const item = (setId, beatmapId, dan) => ({
    beatmapsetId: setId, artist: "A", title: `S${setId}`,
    diffs: [{ beatmapId, beatmapsetId: setId, version: `V${beatmapId}`, dan: { rawDan: dan }, lnShare: 0, playCount: 500, msd: {}, patterns: {}, length: 120 }],
});

async function setup({ songsDir = null, analyze } = {}) {
    const server = createServer((_q, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ folders: { songs: songsDir } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const root = await mkdtemp(path.join(tmpdir(), "марафон ipc "));
    const handlers = new Map();
    const sent = [];
    const downloads = [];
    const deps = {
        ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: (channel, fn) => handlers.set(channel, fn) },
        tosu: { port: server.address().port, beatmapPath: async () => { throw new Error("no osu"); } },
        analysis: {
            analyze: analyze ?? (async () => ({ kind: "ok", label: "Gamma mid", numeric: 13.02 })),
            analyzeQueued: async (osuText, rate) => {
                const numeric = Math.round((12.7 + 3 * (rate - 1)) * 100) / 100;
                return { kind: "ok", numeric, label: numericToLabel(numeric).text };
            },
        },
        paths: { mapsDir: path.join(root, "карты"), downloadsDir: path.join(root, "скачанные") },
        send: (channel, payload) => sent.push([channel, payload]),
        log: () => {},
        trackerApi: { searchMaps: async () => ({ items: [item(10, 1001, 12.9), item(20, 2001, 12.8)] }) },
        recommender: { playedMaps: async () => ({ played: new Map(), partial: false }) },
        downloader: {
            download: async ({ beatmapsetId }) => {
                downloads.push(beatmapsetId);
                const file = path.join(root, "скачанные", `${beatmapsetId}.osz`);
                await mkdir(path.dirname(file), { recursive: true });
                await writeFile(file, buildOsz([
                    { name: `x [V${beatmapsetId}01].osu`, data: Buffer.from(chart(beatmapsetId * 100 + 1, beatmapsetId)) },
                    { name: "audio.mp3", data: Buffer.from("AUDIO") },
                ]));
                return { file, reused: false };
            },
        },
        profile: { current: () => ({ ok: false }) },
        ffmpegPath: async () => "ffmpeg",
        renderPng: async () => Buffer.from(""),
    };
    registerMarathonIpc(deps);
    const call = (channel, ...args) => handlers.get(channel)({}, ...args);
    return { call, sent, downloads, root, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("marathon-dan answers the label, the dan and the cut length; unknown is empty, never a throw", async () => {
    const s = await setup();
    try {
        const file = path.join(s.root, "a.osu");
        const text = chart(5, 6);
        await writeFile(file, text, "utf8");
        assert.deepEqual(await s.call("marathon-dan", { file, rate: 1.1 }), { label: "Gamma mid", numeric: 13.02, cutMs: cutRange(text).cutMs });
        const empty = { label: "", numeric: null, cutMs: null };
        assert.deepEqual(await s.call("marathon-dan", { file, rate: 3 }), empty);
        assert.deepEqual(await s.call("marathon-dan", { file: path.join(s.root, "none.osu"), rate: 1 }), empty);
        assert.deepEqual(await s.call("marathon-dan", { file: 42, rate: 1 }), empty);
        assert.deepEqual(await s.call("marathon-dan", null), empty);
    } finally {
        await s.close();
    }
    const notRice = await setup({ analyze: async () => ({ kind: "not-rice", reason: "keys", keys: 7 }) });
    try {
        const file = path.join(notRice.root, "a.osu");
        await writeFile(file, chart(5, 6), "utf8");
        const r = await notRice.call("marathon-dan", { file, rate: 1 });
        assert.equal(r.label, "");
        assert.equal(r.numeric, null);
        assert.ok(r.cutMs > 19000);
    } finally {
        await notRice.close();
    }
});

test("marathon-auto: a set in Songs is used where it is, another is downloaded into скачанные/марафон, progress is sent", async () => {
    const songs = path.join(await mkdtemp(path.join(tmpdir(), "osu songs ")), "Songs");
    await mkdir(path.join(songs, "10 A - S10"), { recursive: true });
    await writeFile(path.join(songs, "10 A - S10", "x.osu"), chart(1001, 10), "utf8");
    const before = await readdir(path.join(songs, "10 A - S10"));
    const s = await setup({ songsDir: songs });
    try {
        const r = await s.call("marathon-auto", {
            templateId: "custom", count: 3, step: 0.1, source: "manual", manualDan: 13, patternIds: ["stream"], skipPlayed: false, rankedOnly: false,
        });
        assert.equal(r.ok, true, r.message);
        assert.deepEqual(r.plan, [12.8, 12.9, 13]);
        // map 1 (12.8) takes the set the tracker puts at 12.8, map 2 the other one
        assert.deepEqual(r.entries.map((e) => [e.beatmapsetId, e.from]), [[20, "download"], [10, "songs"]]);
        assert.equal(r.entries[0].path, path.join(s.root, "скачанные", "марафон", "20", "2001.osu"));
        assert.deepEqual((await readdir(path.dirname(r.entries[0].path))).sort(), ["2001.osu", "audio.mp3"]);
        assert.equal(r.entries[1].path, path.join(songs, "10 A - S10", "x.osu"));
        assert.deepEqual(s.downloads, [20]);
        // the third map has no set left: a miss
        assert.deepEqual(r.warnings.map((w) => [w.kind, w.i]), [["miss", 3]]);
        const phases = s.sent.filter(([c]) => c === "marathon-auto-progress").map(([, e]) => e.phase);
        assert.equal(phases[0], "search");
        assert.equal(phases.at(-1), "done");
        assert.ok(phases.includes("songs") && phases.includes("download") && phases.includes("analyze"));
        // nothing was written into Songs
        assert.deepEqual(await readdir(path.join(songs, "10 A - S10")), before);
        assert.deepEqual(await readdir(songs), ["10 A - S10"]);
        assert.deepEqual(await s.call("marathon-auto-cancel"), { ok: true });
    } finally {
        await s.close();
    }
});

test("marathon-auto refuses a bad request without throwing", async () => {
    const s = await setup();
    try {
        for (const req of [null, { templateId: "x" }, { templateId: "dan", patternIds: ["stream"], source: "profile" }]) {
            const r = await s.call("marathon-auto", req);
            assert.equal(r.ok, false);
            assert.equal(typeof r.message, "string");
        }
        assert.deepEqual(s.downloads, []);
    } finally {
        await s.close();
    }
});
