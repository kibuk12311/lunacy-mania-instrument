// The Skin tab's main side over temporary folders only (a fixture osu! folder made here, a fixture Documents):
// an osu! skin is copied out and its original never changes, an .osk is unpacked safely, a skin made from scratch,
// edits saved with the skin.ini's own encoding, pictures handed out, the builder redrawing, the .osk / folder /
// Interlude exports, recent skins; and the channels registered without I/O.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkinService, registerSkinIpc, decodeIni, encodeIni, safeName, SKINS_FOLDER, checkPicturePair, pictureWarnings } from "../../app/skinIpc.js";
import { readZip } from "../../src/rate/oszRead.js";
import { packOsk, readSkinArchive, exportedFiles } from "../../src/skin/skinArchive.js";
import { encodePng, pngSize } from "../../src/skin/png.js";
import { parseSkinIni, getValue, patchSkinIni } from "../../src/skin/skinIni.js";

const png = (w = 4, h = 4) => encodePng(w, h, new Uint8Array(w * h * 4).fill(200));
const INI = "﻿[General]\r\nName: Fixture Skin\r\nAuthor: TestPlayer\r\n\r\n[Mania]\r\nKeys: 4\r\nColumnWidth: 50,50,50,50\r\nNoteImage0: Notes/n1\r\n\r\n[Mania]\r\nKeys: 7\r\nHitPosition: 400\r\n";

async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), "lm-skin-"));
    const game = path.join(root, "osu");
    const skin = path.join(game, "Skins", "Fixture");
    await mkdir(path.join(skin, "Notes"), { recursive: true });
    await writeFile(path.join(skin, "skin.ini"), INI, "utf8");
    await writeFile(path.join(skin, "Notes", "n1@2x.png"), png(8, 8));
    await writeFile(path.join(skin, "Notes", "n1.png"), png());
    await writeFile(path.join(skin, "mania-key1.png"), png());
    await mkdir(path.join(game, "Skins", "No ini"), { recursive: true });
    const opened = [];
    const shown = [];
    const service = createSkinService({
        userData: path.join(root, "user-data"), docsDir: path.join(root, "docs"), env: {},
        gameFolder: async () => game,
        shell: { openPath: async (f) => { opened.push(f); return ""; }, showItemInFolder: (f) => shown.push(f) },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    });
    return { root, game, skin, service, opened, shown, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("names and encodings", () => {
    assert.equal(safeName('a:b/c*?"<>|. '), "a_b_c______");
    assert.equal(safeName("  "), "skin");
    const latin = Buffer.from([0x5b, 0x47, 0x5d, 0x0d, 0x0a, 0x4e, 0x3a, 0xe9]);
    const d = decodeIni(latin);
    assert.equal(d.encoding, "latin1");
    assert.deepEqual(encodeIni(d.text, d.encoding), latin, "byte for byte back");
    assert.equal(decodeIni(Buffer.from("﻿Name: Ö", "utf8")).text, "﻿Name: Ö");
});

test("osu!'s Skins folder: listed, a skin copied out, the original left alone", async () => {
    const { skin, service, cleanup } = await setup();
    try {
        const list = await service.list();
        assert.equal(list.ok, true);
        assert.deepEqual(list.skins.map((s) => [s.folder, s.name, s.mania4]), [["Fixture", "Fixture Skin", true], ["No ini", "No ini", false]]);
        const before = await readFile(path.join(skin, "skin.ini"));
        const s = await service.open({ folder: "Fixture" });
        assert.equal(s.ok, true);
        assert.equal(s.name, "Fixture Skin");
        assert.equal(s.ini, INI);
        assert.equal(s.interlude, false);
        for (const bad of ["..", "../x", "a\\b", ""]) assert.equal((await service.open({ folder: bad })).ok, false, bad);
        // edits go to the working copy
        const edited = patchSkinIni(s.ini, { mania4: { HitPosition: "420" } });
        assert.equal((await service.save({ id: s.id, ini: edited })).ok, true);
        assert.deepEqual(await readFile(path.join(skin, "skin.ini")), before, "osu!'s skin.ini unchanged");
        const work = path.join(service.paths.workRoot, s.id);
        assert.equal(await readFile(path.join(work, "skin.ini"), "utf8"), edited);
        // pictures: @2x first, osu!'s own names found whatever their case, missing ones null
        const { images } = await service.images({ id: s.id, values: ["Notes/n1", "MANIA-KEY1", "mania-note2"] });
        assert.equal(images["Notes/n1"].hd, true);
        assert.match(images["Notes/n1"].url, /^data:image\/png;base64,/);
        assert.equal(images["MANIA-KEY1"].hd, false);
        assert.equal(images["mania-note2"], null);
        // the builder redraws keys only; the values come back for the tab to apply
        const b = await service.build({ id: s.id, options: { shape: "diamond" }, parts: ["keys"] });
        assert.equal(b.ok, true);
        assert.ok(b.mania.KeyImage0.startsWith("lunacy-mania/b1/"));
        assert.ok(!("NoteImage0" in b.mania));
        // the Interlude export is only for skins made here
        const il = await service.exportInterlude({ id: s.id, ini: edited });
        assert.equal(il.ok, false);
    } finally {
        await cleanup();
    }
});

test("export: an .osk in Documents\\…\\скины with the skin's files (old builds left out), opened; a folder copy; never overwritten", async () => {
    const { service, opened, root, cleanup } = await setup();
    try {
        const s = await service.open({ folder: "Fixture" });
        const one = await service.build({ id: s.id, options: {}, parts: ["notes"] });
        const two = await service.build({ id: s.id, options: { shape: "bar" }, parts: ["notes"] });
        const ini = patchSkinIni(s.ini, { mania4: two.mania });
        const r = await service.exportOsk({ id: s.id, ini });
        assert.equal(r.ok, true);
        assert.equal(path.dirname(r.file), path.join(root, "docs", SKINS_FOLDER));
        assert.equal(path.basename(r.file), "Fixture Skin.osk");
        assert.deepEqual(opened, [r.file]);
        const names = readZip(await readFile(r.file)).map((e) => e.name);
        assert.ok(names.includes("skin.ini") && names.includes("Notes/n1@2x.png") && names.includes("mania-key1.png"));
        assert.ok(names.some((n) => n.startsWith("lunacy-mania/b2/")), "the build skin.ini uses");
        assert.ok(!names.some((n) => n.startsWith("lunacy-mania/b1/")), "not the one undone");
        assert.ok(one.ok);
        const again = await service.exportOsk({ id: s.id, ini, open: false });
        assert.equal(path.basename(again.file), "Fixture Skin (2).osk");
        const copy = await service.saveCopy({ id: s.id, ini });
        assert.equal(copy.ok, true);
        assert.ok((await stat(path.join(copy.dir, "Notes", "n1.png"))).isFile());
    } finally {
        await cleanup();
    }
});

test("a skin from scratch: drawn, listed as recent, reopened, exported for Interlude", async () => {
    const { service, shown, cleanup } = await setup();
    try {
        const s = await service.create({ options: { name: "Scratch", author: "TestPlayer", shape: "arrow" } });
        assert.equal(s.ok, true);
        assert.equal(s.origin, "template");
        assert.equal(s.interlude, true);
        assert.equal(getValue(parseSkinIni(s.ini), "General", "Author"), "TestPlayer");
        const recent = await service.recent();
        assert.deepEqual(recent.items.map((i) => i.name), ["Scratch"]);
        const again = await service.reopen({ id: s.id });
        assert.equal(again.ini, s.ini);
        const il = await service.exportInterlude({ id: s.id, ini: s.ini });
        assert.equal(il.ok, true);
        assert.equal(path.extname(il.file), ".isk");
        assert.deepEqual(shown, [il.file]);
        const entries = readSkinArchive(await readFile(il.file)).map((e) => e.name);
        // the user's own judgement-line picture goes to Interlude too (and turns its judgement line on)
        const own = await service.replaceImage({ id: s.id, keys: ["StageHint"], png1x: png(40, 6), png2x: png(80, 12) });
        const withOwn = patchSkinIni(s.ini, { mania4: { StageHint: own.value } });
        const il2 = await service.exportInterlude({ id: s.id, ini: withOwn });
        const line = readSkinArchive(await readFile(il2.file)).find((e) => e.name === "Noteskin/judgementline[1x1].png");
        assert.ok(line, "judgementline from the user's picture");
        assert.deepEqual(pngSize(line.read()), { width: 80, height: 12 }, "its @2x, as given");
        assert.ok(entries.includes("skin.json") && entries.includes("Noteskin/noteskin.json") && entries.includes("Noteskin/note[1x4].png"));
        assert.equal((await service.reopen({ id: "nosuchid0" })).ok, false);
    } finally {
        await cleanup();
    }
});

test("an .osk / .zip: unpacked safely (a zipped folder loses its folder, ../ names are dropped); pictures replaced", async () => {
    const { root, service, cleanup } = await setup();
    try {
        const zip = packOsk([
            { name: "My Skin/skin.ini", data: Buffer.from("[General]\r\nName: Zipped\r\n") },
            { name: "My Skin/mania-note1.png", data: png() },
            { name: "../evil.txt", data: Buffer.from("no") },
        ]);
        const file = path.join(root, "my.osk");
        await writeFile(file, zip);
        const s = await service.importArchive({ file });
        assert.equal(s.ok, true);
        assert.equal(s.name, "Zipped");
        assert.equal(s.mania4, false);
        const work = path.join(service.paths.workRoot, s.id);
        assert.deepEqual((await readdir(work)).sort(), ["mania-note1.png", "skin.ini"]);
        await assert.rejects(stat(path.join(service.paths.workRoot, "evil.txt")));
        assert.equal((await service.importArchive({ file: path.join(root, "x.txt") })).ok, false);
        await writeFile(path.join(root, "broken.osk"), "not a zip");
        assert.equal((await service.importArchive({ file: path.join(root, "broken.osk") })).ok, false);
        // the user's own picture (two PNGs from the tab): both written, the value for every key asked comes back
        const keys = ["NoteImage0", "NoteImage1", "NoteImage2", "NoteImage3"];
        const r = await service.replaceImage({ id: s.id, keys, png1x: new Uint8Array(png(16, 16)), png2x: png(32, 32) });
        assert.equal(r.ok, true);
        assert.deepEqual(r.keys, keys);
        assert.match(r.value, /^lunacy-mania\/custom\/NoteImage0-/);
        assert.deepEqual(r.warnings, []);
        assert.ok((await stat(path.join(work, ...`${r.value}.png`.split("/")))).isFile());
        assert.ok((await stat(path.join(work, ...`${r.value}@2x.png`.split("/")))).isFile());
        const { images } = await service.images({ id: s.id, values: [r.value] });
        assert.equal(images[r.value].hd, true);
        // refused: not a PNG pair, a @2x of the wrong size, a key that is no picture
        assert.equal((await service.replaceImage({ id: s.id, keys: ["NoteImage0"], png1x: Buffer.from("x"), png2x: png(8, 8) })).ok, false);
        assert.equal((await service.replaceImage({ id: s.id, keys: ["NoteImage0"], png1x: png(16, 16), png2x: png(20, 32) })).ok, false);
        assert.equal((await service.replaceImage({ id: s.id, keys: ["HitPosition"], png1x: png(4, 4), png2x: png(8, 8) })).ok, false);
        assert.deepEqual(await service.importArchive({}), { ok: false, cancelled: true });
    } finally {
        await cleanup();
    }
});

test("picture checks: a PNG pair twice the size within the limits; warnings for huge or (for Interlude) not square", () => {
    assert.equal(checkPicturePair(png(10, 7), png(20, 14)).ok, true);
    assert.equal(checkPicturePair(png(10, 7), png(21, 15)).ok, true, "odd sizes round");
    assert.equal(checkPicturePair(png(10, 7), png(20, 20)).ok, false);
    assert.equal(checkPicturePair(null, png(2, 2)).ok, false);
    assert.equal(checkPicturePair(png(2100, 2), png(4200, 4)).ok, false, "past 4096 px");
    assert.deepEqual(pictureWarnings({ width: 1500, height: 64 }, ["Hit300"]), ["large"]);
    assert.deepEqual(pictureWarnings({ width: 64, height: 20 }, ["NoteImage0"], true), ["notSquare"]);
    assert.deepEqual(pictureWarnings({ width: 64, height: 20 }, ["NoteImage0"], false), [], "osu! notes needn't be square");
    assert.deepEqual(pictureWarnings({ width: 64, height: 20 }, ["StageHint"], true), []);
});

test("exportedFiles keeps the skin's own files and only the builds skin.ini points at", () => {
    const ini = "[Mania]\nKeys: 4\nNoteImage0: lunacy-mania/b2/note-abc\n";
    const files = ["skin.ini", "a.png", "lunacy-mania/b1/note-abc.png", "lunacy-mania/b2/note-abc.png", "lunacy-mania/b2/note-abc@2x.png", "lunacy-mania/b2/unused.png"];
    assert.deepEqual(exportedFiles(files, ini, "lunacy-mania"), ["skin.ini", "a.png", "lunacy-mania/b2/note-abc.png", "lunacy-mania/b2/note-abc@2x.png"]);
});

test("registering: every channel once, nothing read or made until asked", () => {
    const handled = [];
    registerSkinIpc({
        ipcMain: { handle: (c) => handled.push(c), on: () => assert.fail("no events") },
        paths: new Proxy({}, { get: () => assert.fail("no paths read while registering") }),
        shell: null, dialog: null, window: () => null, log: () => {}, tosu: { port: 0 },
    });
    assert.equal(new Set(handled).size, handled.length);
    assert.ok(handled.includes("skin-export-osk") && handled.includes("skin-export-interlude") && handled.includes("skin-create"));
});
