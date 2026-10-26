// End to end without the real game: the fake Interlude (native/interlude-reader/out/fake, an F# program with
// Interlude's shapes) runs, the real interlude-reader.exe reads it through the app's reader manager
// (app/interludeReader.js), and the app's live coordinator puts the fake's selected chart on a real selection
// controller's card from a fixture library (tests/fixtures/interludeFolder.js) holding a chart with the fake's hash;
// the fake's play then reaches an overlay session. The reader is pointed at FakeInterlude by name only, so a real
// Interlude is never looked at. Skipped when the reader or the fake isn't built (native/interlude-reader/build.ps1).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReaderProcess, readerPath } from "../app/interludeReader.js";
import { createInterludeLive } from "../app/interludeLive.js";
import { createInterludeClient } from "../app/interludeClient.js";
import { createSelectionController } from "../app/selectionController.js";
import { createJsonStore } from "../app/jsonStore.js";
import { createOverlaySession } from "../src/overlay/session.js";
import { readInterludeFrame, chartTimeNotes } from "../src/overlay/interludeData.js";
import { parseManiaNotes } from "../src/overlay/maniaNotes.js";
import { makeChart } from "./fixtures/makeChart.js";
import { makeInterludeFolder } from "./fixtures/interludeFolder.js";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const READER = readerPath({ packaged: false, appDir });
const FAKE = path.join(path.dirname(READER), "..", "fake", "FakeInterlude.exe");
const built = existsSync(READER) && existsSync(FAKE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
    for (let waited = 0; waited < ms; waited += 50) {
        if (fn()) return;
        await sleep(50);
    }
    throw new Error(`timed out: ${what}`);
}

test("e2e: the fake Interlude's selection goes on the card at its rate, its play reaches the overlay session", { skip: !built && "reader or fake not built", timeout: 90_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "il-e2e-"));
    // the fake plays 2000 notes, one every 50 ms from 1000 ms: the fixture chart has the same rhythm and the fake's hash
    const fx = await makeInterludeFolder({ charts: [
        { hash: "hashB", osuText: makeChart({ kind: "stream", bpm: 300, seconds: 100 }), title: "Blue Zenith", artist: "xi", version: "4K Insane" },
        { hash: "hashA", osuText: makeChart({ kind: "jumpstream", bpm: 180, seconds: 30 }), title: "Freedom Dive", artist: "xi", version: "4K Another" },
    ] });
    const interlude = createInterludeClient({
        store: createJsonStore({ file: path.join(dir, "interlude.json"), fallback: { folder: null } }),
        docsDir: dir, mapsDir: path.join(dir, "maps"), cacheDir: path.join(dir, "cache"),
    });
    await interlude.link(fx.root);
    assert.equal((await interlude.liveSettings()).follow, true);
    const views = [];
    const analyzed = [];
    const controller = createSelectionController({
        fetchOsu: async () => { throw new Error("no osu!"); },
        analyze: async (text, rate) => { analyzed.push(rate); return { kind: "ok", label: `${/^Title:(.*)$/m.exec(text)?.[1]} ${rate}` }; },
        cache: { get: async () => undefined, set: async () => {} },
        onView: (v) => views.push(v),
    });
    const session = createOverlaySession();
    const notes = chartTimeNotes(parseManiaNotes((await interlude.library.osuFor("hashB")).text));
    const overlay = { onInterlude: (msg) => {
        if (!msg) return;
        const { mapWanted } = session.onFrame(readInterludeFrame(msg), Date.now());
        if (mapWanted) session.setMap(mapWanted, notes);
    } };
    const states = [];
    const live = createInterludeLive({ interlude, card: controller, overlay: () => overlay, onState: (s) => states.push(s.status) });
    const reader = createReaderProcess({
        exe: () => READER, args: () => ["--name", "FakeInterlude"], // the fake only, never a real Interlude
        onMessage: (m) => live.onMessage(m), onState: (s) => live.onReader(s),
    });
    const fake = spawn(FAKE, [], { stdio: ["pipe", "pipe", "pipe"] });
    let fakeOut = "";
    fake.stdout.on("data", (d) => { fakeOut += d; });
    const cmd = async (c) => {
        const at = fakeOut.length;
        fake.stdin.write(`${c}\n`);
        await until(() => fakeOut.slice(at).includes(`ok ${c}`), 5000, c);
    };
    try {
        await until(() => fakeOut.includes("ready"), 15000, "fake ready");
        reader.start();
        await until(() => live.state().status === "attached", 20000, "attached");
        await cmd("screen levelselect");
        await cmd("select hashA|Freedom Dive|xi|4K Another|Mapper One|4|258000|222|6.75");
        await until(() => controller.external()?.checksum === "external:hashA" && views.at(-1)?.screen === "result", 15000, "chart A on the card");
        assert.equal(views.at(-1).result.label, "Freedom Dive 1");
        await cmd("select hashB|Blue Zenith|xi|4K Insane|Mapper Two|4|100000|200|5.25");
        await cmd("rate 1.25");
        await until(() => controller.external()?.checksum === "external:hashB" && controller.external().rate === 1.25 && views.at(-1)?.screen === "result", 15000, "chart B at 1.25× on the card");
        assert.equal(views.at(-1).result.label, "Blue Zenith 1.25", "the dan is worked out at Interlude's rate");
        assert.equal(interlude.selection()?.hash, "hashB", "and it is the tabs' map");
        await cmd("play");
        await until(() => session.phase() === "playing" && session.snapshot(0).lanes.counts.some((n) => n > 5), 15000, "a play in the overlay session");
        await sleep(1500);
        const snap = session.snapshot(0);
        assert.equal(snap.rate, 1.25);
        assert.equal(snap.lanes.source, "keys", "the key lines come from Interlude's own presses");
        assert.ok(snap.kps.max > 15, `KPS max ${snap.kps.max} (20 presses a second of chart time)`);
        assert.ok(snap.ur > 0, `UR ${snap.ur}`);
        assert.equal(snap.nps.ready, true);
        assert.ok(snap.hits.max > 0 && snap.accuracy > 0 && snap.accuracy <= 100);
        assert.deepEqual(snap.judgeNames.labels, ["MARV", "PERF", "GREAT", "GOOD", "BAD", "MISS"]);
        await cmd("screen score");
        await until(() => session.phase() === "results", 5000, "results");
    } finally {
        await reader.stop();
        fake.kill();
    }
    assert.equal(reader.running(), false);
    assert.ok(states.includes("attached"));
});
