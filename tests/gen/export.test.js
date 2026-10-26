import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveGeneratedMap, safeFileName } from "../../app/mapExport.js";
import { targetNumeric, normalizeShares, LEVELS } from "../../src/gen/request.js";
import { setLang } from "../../src/i18n/i18n.js";

test("file names lose characters Windows forbids", () => {
    assert.equal(safeFileName(String.raw`a<b>:c"d/e\f|g?h*i`), "a_b__c_d_e_f_g_h_i");
    assert.equal(safeFileName("  Песня. "), "Песня");
});

test("saveGeneratedMap writes an .osz with the audio and the map", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "карты "));
    const audio = path.join(dir, "song.mp3");
    await writeFile(audio, Buffer.from([9, 9, 9]));
    const out = await saveGeneratedMap({ dir: path.join(dir, "out"), audioPath: audio, title: "Song", version: "Gamma mid Chordjack", osuText: "osu file format v14" });
    assert.ok(out.endsWith("Song [Gamma mid Chordjack].osz"));
    const zip = await readFile(out);
    assert.ok(zip.includes(Buffer.from("audio.mp3")));
    assert.ok(zip.includes(Buffer.from("Song [Gamma mid Chordjack].osu")));
});

test("a second save does not overwrite the first", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "карты "));
    const audio = path.join(dir, "song.ogg");
    await writeFile(audio, "x");
    const args = { dir, audioPath: audio, title: "S", version: "V", osuText: "o" };
    const a = await saveGeneratedMap(args);
    const b = await saveGeneratedMap(args);
    assert.notEqual(a, b);
});

test("target numeric from level and step", () => {
    assert.equal(targetNumeric(13, "mid/high"), 13.2);
    assert.equal(targetNumeric(13, "low"), 12.6);
    assert.equal(targetNumeric(7, "mid"), 7);
    assert.equal(LEVELS.find((l) => l.value === 13).name, "Gamma");
    assert.equal(LEVELS.length, 20);
});

test("shares are normalised and empty selections rejected", () => {
    assert.deepEqual(normalizeShares([{ name: "Chordjack", share: 70 }, { name: "Jumpstream", share: 30 }]),
        [{ name: "Chordjack", share: 0.7 }, { name: "Jumpstream", share: 0.3 }]);
    assert.deepEqual(normalizeShares([{ name: "Stream", share: 0 }]), [{ name: "Stream", share: 1 }]);
    assert.throws(() => normalizeShares([]));
});

test("level names and the empty-selection error follow the language", () => {
    try {
        assert.deepEqual(LEVELS.slice(0, 2).map((l) => l.name), ["1 дан", "2 дан"]);
        assert.throws(() => normalizeShares([]), /^Error: выбери хотя бы один паттерн$/);
        setLang("en");
        assert.deepEqual([1, 10, 11, 13, 20].map((v) => LEVELS.find((l) => l.value === v).name), ["Dan 1", "Dan 10", "Alpha", "Gamma", "Kappa"]);
        assert.throws(() => normalizeShares([]), /^Error: pick at least one pattern$/);
        assert.equal(JSON.parse(JSON.stringify(LEVELS[4])).name, "Dan 5");
    } finally {
        setLang("ru");
    }
    assert.equal(LEVELS[4].name, "5 дан");
});
