// The Interlude skin from the builder: the .isk's layout (skin.json + Noteskin\noteskin.json + grid textures), the
// grids' sizes as Prelude checks them (square frames, columns × rows in the name), and noteskin.json's fields: the
// same set Interlude's own bundled noteskin writes, enums by name, colours as [A, R, G, B].
import test from "node:test";
import assert from "node:assert/strict";
import { buildInterludeSkin, noteskinConfig } from "../../src/skin/interludeSkin.js";
import { normalizeOptions } from "../../src/skin/build.js";
import { packOsk, readSkinArchive } from "../../src/skin/skinArchive.js";
import { pngSize, decodePng } from "../../src/skin/png.js";
import { createImage } from "../../src/skin/raster.js";

// the fields of Interlude's bundled "chocolate" noteskin.json (interlude/src/Resources/chocolate.zip) and the two
// Prelude has besides (prelude/src/Skins/Noteskins/NoteskinConfig.fs)
const CHOCOLATE_FIELDS = ["AdvancedColumnSpacing", "AnimationFrameTime", "ColumnLightColors", "ColumnLightDuration", "ColumnLightOffset",
    "ColumnSpacing", "ColumnWidth", "DroppedHoldColor", "EnableColumnLight", "EnableStageTextures", "FillColumnGaps", "FlipHoldTail",
    "HoldExplosionSettings", "HoldNoteTrim", "JudgementLineOffset", "JudgementLineScale", "LinearSampling", "NoteColors",
    "NoteExplosionSettings", "NotesUnderReceptors", "PlayfieldAlignment", "PlayfieldColor", "ReceptorColors", "ReceptorOffset",
    "ReceptorStyle", "Rotations", "UseAdvancedColumnSpacing", "UseExplosions", "UseHoldTailTexture", "UseJudgementLine", "UseReceptors", "UseRotation"];
const PRELUDE_EXTRA = ["KeymodeSpecificColumnWidth", "MinimumHoldNoteLength", "UseKeymodeSpecificColumnWidth"];

const grid = (name) => {
    const m = /\[(\d+)x(\d+)\]\.png$/.exec(name);
    return m ? { columns: Number(m[1]), rows: Number(m[2]) } : null;
};

test("the .isk: skin.json and a Noteskin folder, every texture a grid of square frames", () => {
    const { entries, config } = buildInterludeSkin({ name: "Fixture", author: "TestPlayer", stage: "glow", lighting: true });
    const names = entries.map((e) => e.name);
    assert.deepEqual(JSON.parse(entries.find((e) => e.name === "skin.json").data), { Author: "TestPlayer", Editor: null, Name: "Fixture" });
    for (const tex of ["note[1x4]", "holdhead[1x4]", "holdbody[1x4]", "holdtail[1x4]", "receptor[1x8]", "receptorlighting[1x4]",
        "noteexplosion[1x4]", "holdexplosion[1x4]", "stageleft[1x1]", "stageright[1x1]", "judgementline[1x1]"]) {
        assert.ok(names.includes(`Noteskin/${tex}.png`), tex);
    }
    for (const e of entries.filter((x) => x.name.endsWith(".png"))) {
        const { columns, rows } = grid(e.name);
        const { width, height } = pngSize(e.data);
        assert.equal(width % columns, 0, e.name);
        assert.equal(height % rows, 0, e.name);
        // square where Prelude wants square (note, holds, explosions, receptors of the Receptors style)
        if (/^(note|hold\w+|noteexplosion|holdexplosion|receptor)\[/.test(e.name.split("/")[1])) assert.equal(width / columns, height / rows, e.name);
    }
    assert.equal(config.UseJudgementLine, true);
    assert.equal(config.EnableStageTextures, true);
    // a zip, unpacked the way Interlude unpacks it: at the root of the skin's folder
    const back = readSkinArchive(packOsk(entries)).map((e) => e.name).sort();
    assert.deepEqual(back, [...names].sort());
});

test("noteskin.json: Interlude's own fields, enums by name, colours ARGB, 4K colours per column", () => {
    const config = noteskinConfig(normalizeOptions({ columnWidth: 60, theme: "dark" }), { columnWidth: [64, 64, 64, 64], columnSpacing: [2, 2, 2], keysUnderNotes: 0 });
    assert.deepEqual(Object.keys(config).sort(), [...CHOCOLATE_FIELDS, ...PRELUDE_EXTRA].sort());
    assert.equal(config.ColumnWidth, 144, "osu!'s 480-high units × 1080 / 480");
    assert.equal(config.ColumnSpacing, 5);
    assert.equal(config.ReceptorStyle, "Receptors");
    assert.equal(config.NoteColors.Style, "Column");
    assert.equal(config.NoteColors.Colors.length, 9);
    assert.ok(config.NoteColors.Colors.every((c) => c.length === 10));
    assert.deepEqual(config.NoteColors.Colors[2].slice(0, 4), [0, 1, 2, 3], "4K is index keys − 2");
    assert.equal(config.PlayfieldColor.length, 4);
    assert.equal(config.PlayfieldColor[0], 235, "alpha first");
    // the shapes Prelude's Validate wants
    assert.ok(config.Rotations.length === 8 && config.Rotations.every((r, i) => r.length === 3 + i));
    assert.ok(config.AdvancedColumnSpacing.every((r, i) => r.length === 2 + i));
    assert.ok(config.ColumnLightColors.every((r, i) => r.length === 3 + i));
    assert.ok(config.ReceptorColors.every((r, i) => r.length === 3 + i));
    assert.equal(config.UseRotation, false, "arrows are drawn already turned");
    assert.equal(config.NotesUnderReceptors, true);
});

test("without lighting and stage edges: no explosion, light or stage textures, and the config says so", () => {
    const { entries, config } = buildInterludeSkin({ lighting: false, stage: "plain" });
    const names = entries.map((e) => e.name);
    assert.ok(!names.some((n) => /explosion|receptorlighting|stageleft|judgementline/.test(n)));
    assert.equal(config.UseExplosions, false);
    assert.equal(config.EnableColumnLight, false);
    assert.equal(config.EnableStageTextures, false);
    assert.equal(config.UseJudgementLine, false);
});

test("the user's own pictures take the drawn ones' place: fitted into the square frame, a tail turned over", () => {
    // a red, wide note picture for column 2 and a tail whose top half is opaque
    const red = createImage(64, 32).fill(() => -1, [255, 0, 0, 1]);
    const tail = createImage(32, 32).fill((x, y) => (y < 16 ? -1 : 1), [0, 255, 0, 1]);
    const { entries, config } = buildInterludeSkin({ lighting: false, stage: "plain" }, {}, { NoteImage2: red, NoteImage1T: tail, LightingN: red });
    const pixels = (name) => decodePng(entries.find((e) => e.name === name).data);
    const note = pixels("Noteskin/note[1x4].png");
    const at = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
    // row 2's middle is the red picture, its top (outside the 2:1 picture fitted in) see-through
    assert.deepEqual(at(note, 64, 2 * 128 + 64), [255, 0, 0, 255]);
    assert.equal(at(note, 64, 2 * 128 + 5)[3], 0);
    // row 0 is still drawn by the builder
    assert.ok(at(note, 64, 64)[3] > 0);
    // the tail upside down: its opaque half at the bottom now
    const tails = pixels("Noteskin/holdtail[1x4].png");
    assert.equal(at(tails, 64, 128 + 10)[3], 0);
    assert.equal(at(tails, 64, 128 + 120)[3], 255);
    // the user's hit flash switches the explosions on even with the builder's lighting off
    assert.equal(config.UseExplosions, true);
    assert.ok(entries.some((e) => e.name === "Noteskin/noteexplosion[1x4].png"));
});
