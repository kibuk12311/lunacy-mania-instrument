import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { groupKey, readBenchRows, findOsuFile } from "../tools/bench-rows.mjs";

test("groupKey ignores rate suffix and case", () => {
    assert.equal(
        groupKey({ bid: "", name: "Grinding Of The Teeth x1.35" }),
        groupKey({ bid: "", name: "grinding of the teeth x1.2" }),
    );
});

test("groupKey ignores parenthesized remarks and bid", () => {
    assert.equal(
        groupKey({ bid: "3755310", name: "Death Melody(e8v2) x1.25" }),
        groupKey({ bid: "", name: "Death Melody x1.1" }),
    );
});

test("readBenchRows parses expected as a number", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bench "));
    const csv = path.join(dir, "data.csv");
    await writeFile(csv, [
        "bid,name,pattern,subPattern,expected,got,delta,deltaAbs",
        ",Song A x1.1,jack,dense chordjack,17.8,,,",
        "123,Song B,speed,high stream,13.4,,,",
        ",Song C,ln,lnwall,9,,,",
    ].join("\n"), "utf8");
    const rows = await readBenchRows(csv);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].expected, 17.8);
    assert.equal(rows[1].bid, "123");
    assert.equal(typeof rows[2].group, "string");
});

test("findOsuFile uses exact, normalized and Name (...) matching", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bench "));
    await mkdir(path.join(root, "jack"));
    await writeFile(path.join(root, "jack", "Song A x1.1.osu"), "x");
    await writeFile(path.join(root, "jack", "song  b.osu"), "x");
    await writeFile(path.join(root, "jack", "Song C (theta).osu"), "x");
    assert.equal(path.basename(await findOsuFile(root, "jack", "Song A x1.1")), "Song A x1.1.osu");
    assert.equal(path.basename(await findOsuFile(root, "jack", "Song B")), "song  b.osu");
    assert.equal(path.basename(await findOsuFile(root, "jack", "Song C(theta)")), "Song C (theta).osu");
    assert.equal(await findOsuFile(root, "jack", "Nope"), null);
});
