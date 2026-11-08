// The Etterna folder and its switch (app/etternaClient.js): linking scans once, a folder that is not Etterna's is
// refused, a folder that is gone says so, the switch turns Etterna off for the whole app while the folder and the
// index stay, and the window hears of every change.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setLang } from "../../src/i18n/i18n.js";
import { createEtternaClient } from "../../app/etternaClient.js";
import { createEtternaLibrary } from "../../app/etternaLibrary.js";
import { makeEtternaFolder, smText } from "../fixtures/etternaFolder.js";

setLang("en");
const memoryStore = (value = null) => ({ value, get: async function () { return this.value; }, set: async function (v) { this.value = v; } });

async function withGame(body) {
    const root = await mkdtemp(path.join(tmpdir(), "lm-ettc-"));
    try {
        const game = path.join(root, "Etterna");
        await makeEtternaFolder(game, { songs: [
            { at: "Songs/P/One", files: { "one.sm": smText({ title: "One" }) } },
            { at: "Songs/P/Two", files: { "two.sm": smText({ title: "Two" }) } },
        ] });
        const reads = [];
        const makeLibrary = (opts) => createEtternaLibrary({ ...opts, read: async (f) => { reads.push(f); return readFile(f); } });
        return await body({ root, game, cacheDir: path.join(root, "cache"), reads, makeLibrary });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("links a folder with Songs and scans it once", async () => {
    await withGame(async ({ game, cacheDir, reads, makeLibrary }) => {
        const store = memoryStore();
        const client = createEtternaClient({ store, cacheDir, makeLibrary });
        assert.deepEqual(await client.status(), { linked: false, folder: null });
        const linked = await client.link(path.join(game, "Songs"));
        assert.equal(linked.ok, true);
        await client.scanned();
        const st = await client.status();
        assert.equal(st.linked, true);
        assert.equal(st.folder, game);
        assert.equal(st.size, 2);
        assert.equal(st.scanning, null);
        assert.deepEqual(store.value, { folder: game, enabled: true });
        assert.equal(reads.length, 2);
        assert.deepEqual(client.search("").map((r) => r.title).sort(), ["One", "Two"]);
        const one = client.search("one")[0];
        assert.match((await client.chart(one.id)).osu, /\[HitObjects\]/);
    });
});

test("a folder without Songs is refused with a message, and nothing is kept", async () => {
    await withGame(async ({ root, cacheDir, makeLibrary }) => {
        const store = memoryStore();
        const client = createEtternaClient({ store, cacheDir, makeLibrary });
        const r = await client.link(root);
        assert.equal(r.ok, false);
        assert.match(r.message, /isn't an Etterna folder/);
        assert.equal(store.value, null);
    });
});

test("a linked folder that is gone reports it and lists nothing", async () => {
    await withGame(async ({ root, cacheDir, makeLibrary }) => {
        const gone = path.join(root, "Moved Away");
        const client = createEtternaClient({ store: memoryStore({ folder: gone, enabled: true }), cacheDir, makeLibrary });
        const st = await client.status();
        assert.equal(st.linked, false);
        assert.equal(st.missing, true);
        assert.match(st.message, /gone/);
        assert.deepEqual(client.search(""), []);
    });
});

test("off: not linked for the app, folder kept; on again: the same rows without reading unchanged files again", async () => {
    await withGame(async ({ game, cacheDir, reads, makeLibrary }) => {
        const store = memoryStore();
        const client = createEtternaClient({ store, cacheDir, makeLibrary });
        await client.link(game);
        await client.scanned();
        const off = await client.setEnabled(false);
        assert.deepEqual(off, { linked: false, off: true, folder: game });
        assert.deepEqual(store.value, { folder: game, enabled: false });
        assert.deepEqual(client.search(""), []);
        assert.equal(await client.chart(`/Songs/P/One/one.sm|0`), null);
        reads.length = 0;
        // a new start with the switch off, then turned on
        const later = createEtternaClient({ store, cacheDir, makeLibrary });
        assert.equal((await later.status()).off, true);
        await later.setEnabled(true);
        await later.scanned();
        assert.equal((await later.status()).size, 2);
        assert.equal(reads.length, 0, "the index answered for both files");
    });
});

test("a start with a linked folder scans it in the background", async () => {
    await withGame(async ({ game, cacheDir, makeLibrary }) => {
        const client = createEtternaClient({ store: memoryStore({ folder: game, enabled: true }), cacheDir, makeLibrary });
        await client.status();
        await client.scanned();
        assert.equal((await client.status()).size, 2);
    });
});

test("onChange fires on link, the scan's end, the switch and unlink; detect finds a default place", async () => {
    await withGame(async ({ game, cacheDir, makeLibrary }) => {
        let changes = 0;
        const client = createEtternaClient({ store: memoryStore(), cacheDir, makeLibrary, onChange: () => { changes += 1; }, candidates: ["Z:/nowhere", game] });
        const found = await client.detect();
        assert.equal(found.ok, true);
        await client.scanned();
        const afterLink = changes;
        assert.ok(afterLink >= 2, `link and scan end: ${afterLink}`);
        await client.setEnabled(false);
        await client.unlink();
        assert.equal(changes, afterLink + 2);
        assert.deepEqual(await client.status(), { linked: false, off: true, folder: null }, "unlinked, the switch still off");
        const none = createEtternaClient({ store: memoryStore(), cacheDir, makeLibrary, candidates: ["Z:/nowhere"] });
        const miss = await none.detect();
        assert.equal(miss.ok, false);
        assert.match(miss.message, /wasn't found/);
    });
});

test("scans run one after another: copies of cache.db never overlap, and the last scan keeps its MSD", async () => {
    const { createEtternaLibrary: realLibrary } = await import("../../app/etternaLibrary.js");
    const { copyFile } = await import("node:fs/promises");
    const { msdText } = await import("../fixtures/etternaFolder.js");
    const root = await mkdtemp(path.join(tmpdir(), "lm-ettc-"));
    try {
        const game = path.join(root, "Etterna");
        await makeEtternaFolder(game, {
            songs: [{ at: "Songs/P/One", files: { "one.sm": smText({ title: "One" }) } }],
            cache: { steps: [{ file: "/Songs/P/One/one.sm", key: `X${"a".repeat(40)}`, msd: msdText(20) }] },
        });
        let copying = 0;
        let most = 0;
        const copy = async (from, to) => {
            copying += 1;
            most = Math.max(most, copying);
            await new Promise((r) => setTimeout(r, 40));
            await copyFile(from, to);
            copying -= 1;
        };
        const client = createEtternaClient({ store: memoryStore(), cacheDir: path.join(root, "cache"), makeLibrary: (opts) => realLibrary({ ...opts, copy }) });
        await client.link(game);
        await client.setEnabled(false);
        await client.setEnabled(true);
        await client.refresh();
        await client.scanned();
        assert.equal(most, 1, "one copy at a time");
        assert.equal(client.search("")[0].msd[3][0], 20);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
