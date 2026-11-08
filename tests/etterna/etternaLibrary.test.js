// The library of an Etterna install's charts (app/etternaLibrary.js) over invented installs (tests/fixtures/etternaFolder.js):
// which charts it lists, what it reads from the game's cache.db (only ever from a copy), the index it keeps between
// starts, and the search.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEtternaLibrary, etternaFolderOf, detectEtterna, parseMsd, msdAt } from "../../app/etternaLibrary.js";
import { makeEtternaFolder, smText, smChart, sscText, msdText } from "../fixtures/etternaFolder.js";

const KEY_A = `X${"a".repeat(40)}`;
const KEY_B = `X${"b".repeat(40)}`;

async function withDirs(body) {
    const root = await mkdtemp(path.join(tmpdir(), "lm-ett-"));
    try {
        return await body({ game: path.join(root, "Etterna"), cacheDir: path.join(root, "cache"), root });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

// two packs, a song without a pack; one dance-double chart
const SONGS = [
    { at: "Songs/Pack A/Song 1", files: { "Song 1.sm": smText({ title: "First Song", artist: "Alpha", charts: [smChart({ difficulty: "Hard", meter: 12 }), smChart({ type: "dance-double", difficulty: "Hard" })] }) } },
    { at: "Songs/Pack A/Song 2", files: { "Song 2.ssc": sscText({ title: "Second Song", artist: "Beta", charts: [{ difficulty: "Challenge", meter: 20, hold: true }] }) } },
    { at: "Songs/Pack B/Song 3", files: { "Song 3.sm": smText({ title: "Third Song", artist: "Gamma", charts: [smChart({ difficulty: "Easy", meter: 4 })] }) } },
];

test("lists every dance-single chart of every pack, with pack, title, version and length", async () => {
    await withDirs(async ({ game, cacheDir }) => {
        await makeEtternaFolder(game, { songs: SONGS });
        const lib = createEtternaLibrary({ folder: game, cacheDir });
        const done = await lib.refresh();
        assert.equal(done.charts, 3);
        assert.equal(lib.size(), 3);
        const rows = lib.search("");
        assert.deepEqual(rows.map((r) => [r.pack, r.title, r.artist]).sort(), [
            ["Pack A", "First Song", "Alpha"], ["Pack A", "Second Song", "Beta"], ["Pack B", "Third Song", "Gamma"],
        ]);
        const first = rows.find((r) => r.title === "First Song");
        assert.match(first.version, /Hard/);
        assert.equal(first.meter, 12);
        assert.ok(first.lengthMs > 0 && first.notes === 16, JSON.stringify(first));
        assert.equal(first.skip, null);
        const chart = await lib.chart(first.id);
        assert.match(chart.osu, /\[HitObjects\]/);
        assert.match(chart.osu, /CircleSize:4/);
        assert.equal(await lib.chart("no such id"), null);
    });
});

test("a song with both .sm and .ssc is read from the .ssc only", async () => {
    await withDirs(async ({ game, cacheDir }) => {
        await makeEtternaFolder(game, { songs: [{ at: "Songs/P/S", files: { "S.sm": smText({ title: "From SM" }), "S.ssc": sscText({ title: "From SSC" }) } }] });
        const lib = createEtternaLibrary({ folder: game, cacheDir });
        await lib.refresh();
        assert.deepEqual(lib.search("").map((r) => r.title), ["From SSC"]);
    });
});

test("a song folder straight in Songs is a song without a pack", async () => {
    await withDirs(async ({ game, cacheDir }) => {
        await makeEtternaFolder(game, { songs: [{ at: "Songs/Loose Song", files: { "Loose.sm": smText({ title: "Loose" }) } }] });
        const lib = createEtternaLibrary({ folder: game, cacheDir });
        await lib.refresh();
        const [row] = lib.search("");
        assert.equal(row.title, "Loose");
        assert.equal(row.pack, "");
    });
});

test("a chart the converter refuses stays listed with its reason and no osu", async () => {
    await withDirs(async ({ game, cacheDir }) => {
        await makeEtternaFolder(game, { songs: [{ at: "Songs/P/Warped", files: { "W.sm": smText({ title: "Warped", warps: "4.000=2.000" }) } }] });
        const lib = createEtternaLibrary({ folder: game, cacheDir });
        await lib.refresh();
        const [row] = lib.search("");
        assert.equal(row.title, "Warped");
        assert.ok(typeof row.skip === "string" && row.skip.length > 0, JSON.stringify(row));
        assert.equal((await lib.chart(row.id)).osu, null);
    });
});

test("AdditionalSongs and AdditionalSongFolders are scanned too", async () => {
    await withDirs(async ({ game, cacheDir, root }) => {
        const extra = path.join(root, "More Packs");
        await makeEtternaFolder(game, {
            songs: [{ at: "Songs/P/In Songs", files: { "a.sm": smText({ title: "In Songs" }) } }, { at: "AdditionalSongs/Q/In Additional", files: { "b.sm": smText({ title: "In Additional" }) } }],
            additionalFolders: [extra],
        });
        await makeEtternaFolder(extra, { songs: [] });
        await makeEtternaFolder(path.join(root, "unused"), {});
        const { mkdir } = await import("node:fs/promises");
        await mkdir(path.join(extra, "R", "In Extra"), { recursive: true });
        await writeFile(path.join(extra, "R", "In Extra", "c.sm"), smText({ title: "In Extra" }));
        const lib = createEtternaLibrary({ folder: game, cacheDir });
        await lib.refresh();
        assert.deepEqual(lib.search("").map((r) => r.title).sort(), ["In Additional", "In Extra", "In Songs"]);
    });
});

test("MSD and chart key come from a copy of cache.db, matched by step file and chart order", async () => {
    await withDirs(async ({ game, cacheDir }) => {
        await makeEtternaFolder(game, {
            songs: SONGS,
            cache: { steps: [
                { file: "/Songs/Pack A/Song 1/Song 1.sm", key: KEY_A, msd: msdText(20) },
                { file: "/Songs/Pack A/Song 1/Song 1.sm", type: "dance-double", key: `X${"c".repeat(40)}`, msd: msdText(5) },
                { file: "/Songs/Pack A/Song 2/Song 2.ssc", key: KEY_B, msd: msdText(25) },
            ] },
        });
        const before = await readFile(path.join(game, "Cache", "cache.db"));
        const lib = createEtternaLibrary({ folder: game, cacheDir });
        await lib.refresh();
        const rows = lib.search("");
        const first = rows.find((r) => r.title === "First Song");
        const second = rows.find((r) => r.title === "Second Song");
        const third = rows.find((r) => r.title === "Third Song");
        assert.equal(first.key, KEY_A);
        assert.equal(first.msd[3][0], 20, "1.0x Overall");
        assert.equal(second.key, KEY_B);
        assert.equal(second.msd[3][0], 25);
        assert.equal(third.key, null, "not in the cache");
        assert.equal(third.msd, null);
        assert.deepEqual(await readFile(path.join(game, "Cache", "cache.db")), before, "the game's file is left as it was");
        assert.ok((await stat(path.join(cacheDir, "etterna-cache.db"))).size > 0, "read from a copy");
    });
});

test("no cache, a cache of another version or a copy that fails: MSD and key empty, the charts still listed", async () => {
    for (const setup of [
        { cache: null },
        { cache: { version: 999, steps: [{ file: "/Songs/Pack A/Song 1/Song 1.sm", key: KEY_A, msd: msdText(20) }] } },
        { cache: { steps: [{ file: "/Songs/Pack A/Song 1/Song 1.sm", key: KEY_A, msd: msdText(20) }] }, copy: async () => { throw new Error("EBUSY: locked"); } },
    ]) {
        await withDirs(async ({ game, cacheDir }) => {
            await makeEtternaFolder(game, { songs: SONGS, cache: setup.cache });
            const lib = createEtternaLibrary({ folder: game, cacheDir, ...(setup.copy ? { copy: setup.copy } : {}) });
            await lib.refresh();
            const rows = lib.search("");
            assert.equal(rows.length, 3);
            assert.ok(rows.every((r) => r.msd === null && r.key === null), JSON.stringify(rows.map((r) => [r.msd, r.key])));
        });
    }
});

test("the index is reused: an unchanged file is not read again, a changed one is", async () => {
    await withDirs(async ({ game, cacheDir }) => {
        await makeEtternaFolder(game, { songs: SONGS });
        const reads = [];
        const read = async (file) => { reads.push(path.basename(file)); return readFile(file); };
        await createEtternaLibrary({ folder: game, cacheDir, read }).refresh();
        assert.equal(reads.length, 3);
        reads.length = 0;
        const changed = path.join(game, "Songs", "Pack B", "Song 3", "Song 3.sm");
        await writeFile(changed, smText({ title: "Third Song Edited", artist: "Gamma" }));
        const later = new Date(Date.now() + 5000);
        await utimes(changed, later, later);
        const lib = createEtternaLibrary({ folder: game, cacheDir, read });
        await lib.refresh();
        assert.deepEqual(reads, ["Song 3.sm"]);
        assert.ok(lib.search("").some((r) => r.title === "Third Song Edited"));
        assert.equal(lib.size(), 3);
    });
});

test("search matches pack, title, artist and version, case-insensitive; title matches rank first", async () => {
    await withDirs(async ({ game, cacheDir }) => {
        await makeEtternaFolder(game, { songs: [
            { at: "Songs/Songs of Gamma/X", files: { "x.sm": smText({ title: "Plain", artist: "Nobody" }) } },
            { at: "Songs/Other/Y", files: { "y.sm": smText({ title: "gamma ray", artist: "Someone" }) } },
        ] });
        const lib = createEtternaLibrary({ folder: game, cacheDir });
        await lib.refresh();
        assert.deepEqual(lib.search("GAMMA").map((r) => r.title), ["gamma ray", "Plain"]);
        assert.deepEqual(lib.search("nobody").map((r) => r.title), ["Plain"]);
        assert.deepEqual(lib.search("hard").length, 2, "the version");
        assert.deepEqual(lib.search("nothing like it"), []);
        assert.equal(lib.search("", { limit: 1 }).length, 1);
    });
});

test("MSD text: 14 rates from 0.7x, Overall first; only 0.1 steps have a value", () => {
    const msd = parseMsd(msdText(20));
    assert.equal(msd.length, 14);
    assert.equal(msd[3][0], 20);
    assert.equal(msdAt(msd, 1), 20);
    assert.equal(msdAt(msd, 0.7), 14);
    assert.equal(msdAt(msd, 2), 40);
    assert.equal(msdAt(msd, 1.05), null);
    assert.equal(msdAt(msd, 2.1), null);
    assert.equal(msdAt(null, 1), null);
    assert.equal(parseMsd(""), null);
    assert.equal(parseMsd("garbage"), null);
});

test("the Etterna folder is the one with Songs, picked as itself, its Songs or its Program", async () => {
    await withDirs(async ({ game }) => {
        await makeEtternaFolder(game, {});
        assert.equal(etternaFolderOf(game), game);
        assert.equal(etternaFolderOf(path.join(game, "Songs")), game);
        assert.equal(etternaFolderOf(path.join(game, "Program")), game);
        assert.equal(etternaFolderOf(path.join(game, "Save")), null);
        assert.equal(etternaFolderOf(path.join(game, "nowhere")), null);
        assert.equal(detectEtterna({ candidates: ["Z:/nope", game] }), game);
        assert.equal(detectEtterna({ candidates: ["Z:/nope"] }), null);
    });
});

test("charts from AdditionalSongFolders get their MSD from the cache rows Etterna names /AdditionalSongs/…", async () => {
    await withDirs(async ({ game, cacheDir, root }) => {
        const extra = path.join(root, "More Packs");
        const { mkdir } = await import("node:fs/promises");
        await makeEtternaFolder(game, {
            songs: [{ at: "Songs/P/In Songs", files: { "a.sm": smText({ title: "In Songs" }) } }],
            additionalFolders: [extra],
            cache: { steps: [
                { file: "/Songs/P/In Songs/a.sm", key: KEY_A, msd: msdText(20) },
                { file: "/AdditionalSongs/R/In Extra/c.sm", key: KEY_B, msd: msdText(30) },
            ] },
        });
        await mkdir(path.join(extra, "R", "In Extra"), { recursive: true });
        await writeFile(path.join(extra, "R", "In Extra", "c.sm"), smText({ title: "In Extra" }));
        const lib = createEtternaLibrary({ folder: game, cacheDir });
        await lib.refresh();
        const extraRow = lib.search("In Extra")[0];
        assert.equal(extraRow.key, KEY_B);
        assert.equal(extraRow.msd[3][0], 30);
        assert.equal(lib.search("In Songs")[0].key, KEY_A);
    });
});

test("a file that could not be read is tried again on the next scan instead of being remembered as empty", async () => {
    await withDirs(async ({ game, cacheDir }) => {
        await makeEtternaFolder(game, { songs: SONGS });
        let fail = true;
        const read = async (file) => {
            if (fail && file.endsWith("Song 3.sm")) throw new Error("EBUSY: resource busy or locked");
            return readFile(file);
        };
        const lib = createEtternaLibrary({ folder: game, cacheDir, read });
        await lib.refresh();
        assert.equal(lib.size(), 2);
        fail = false;
        await createEtternaLibrary({ folder: game, cacheDir, read }).refresh().then(() => {});
        const again = createEtternaLibrary({ folder: game, cacheDir, read });
        await again.refresh();
        assert.equal(again.size(), 3, "the locked file is listed once it can be read");
    });
});

test("a cache row whose meter is not the chart's is not used: no MSD rather than another chart's", async () => {
    await withDirs(async ({ game, cacheDir }) => {
        await makeEtternaFolder(game, {
            songs: SONGS,
            cache: { steps: [
                { file: "/Songs/Pack A/Song 1/Song 1.sm", key: KEY_A, msd: msdText(20), meter: 5 },
                { file: "/Songs/Pack A/Song 2/Song 2.ssc", key: KEY_B, msd: msdText(25), meter: 20 },
            ] },
        });
        const lib = createEtternaLibrary({ folder: game, cacheDir });
        await lib.refresh();
        const first = lib.search("First Song")[0];
        assert.equal(first.msd, null);
        assert.equal(first.key, null);
        assert.equal(lib.search("Second Song")[0].msd[3][0], 25, "a matching meter is used");
    });
});
