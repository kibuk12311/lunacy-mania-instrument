// skin.ini read and written back: untouched text comes back byte for byte (BOM, CRLF / LF / mixed, comments, odd
// spacing, several [Mania] sections), edits touch only their line, and the 4K fields read with osu!'s defaults.
import test from "node:test";
import assert from "node:assert/strict";
import {
    parseSkinIni, writeSkinIni, maniaSections, findSection, getValue, setValue, removeKey, pairsOf, patchSkinIni, ensureSection,
} from "../../src/skin/skinIni.js";
import { MANIA_FIELDS, fieldByKey, fieldValue, fieldText, maniaConfig, readList, readColour, imageCandidates, defaultImage } from "../../src/skin/maniaFields.js";

const SKIN = [
    "﻿// a skin by TestPlayer",
    "[General]",
    "Name:   Fixture Skin  ",
    "Author:TestPlayer",
    "Version: 2.5",
    "",
    "[Colours]",
    "Combo1: 255,0,0",
    "",
    "[Mania]",
    "Keys: 7",
    "ColumnWidth: 40,40,40,40,40,40,40",
    "",
    "[Mania]",
    "//4K below",
    "Keys:4",
    "ColumnStart: 200",
    "ColumnWidth :  55,55, 55,55   ",
    "HitPosition: 420 // comment-like tail",
    "NoteImage0: Notes\\note1",
    "",
    "[Mania]",
    "Keys: 4",
    "HitPosition: 300",
    "",
    "[Fonts]",
    "HitCirclePrefix: default",
].join("\r\n");

test("round trip: untouched text comes back exactly (BOM, CRLF, LF, mixed, no final newline)", () => {
    for (const text of [SKIN, SKIN.replaceAll("\r\n", "\n"), `${SKIN}\r\n`, SKIN.replace("\r\n", "\n").replace("[Fonts]\r\n", "[Fonts]\r"), "", "\n\n", "[Mania]"]) {
        assert.equal(writeSkinIni(parseSkinIni(text)), text);
    }
    assert.equal(parseSkinIni(SKIN).bom, true);
});

test("sections: several [Mania] told apart by Keys, the first 4K one is used", () => {
    const doc = parseSkinIni(SKIN);
    assert.deepEqual(maniaSections(doc).map((s) => s.keys), [7, 4, 4]);
    assert.equal(getValue(doc, { mania: 4 }, "HitPosition"), "420");
    assert.equal(getValue(doc, { mania: 4 }, "columnwidth"), "55,55, 55,55");
    assert.equal(getValue(doc, { mania: 7 }, "HitPosition"), null);
    assert.equal(getValue(doc, "general", "Name"), "Fixture Skin");
    assert.equal(getValue(doc, "General", "Author"), "TestPlayer");
    assert.equal(findSection(doc, { mania: 5 }), null);
    // a comment line is not a key
    assert.equal(pairsOf(doc, { mania: 4 }).has("//4k below"), false);
});

test("edits: one line changes, its spacing and the rest stay; new keys go to the end of their section", () => {
    const doc = parseSkinIni(SKIN);
    setValue(doc, { mania: 4 }, "ColumnWidth", "60,60,60,60");
    setValue(doc, { mania: 4 }, "Colour1", "0,0,0,200");
    setValue(doc, "General", "Name", "Renamed");
    const out = writeSkinIni(doc);
    const lines = out.split("\r\n");
    assert.ok(lines.includes("ColumnWidth :  60,60,60,60   "), "spacing kept");
    assert.ok(lines.includes("Name:   Renamed  "));
    assert.equal(lines[lines.indexOf("NoteImage0: Notes\\note1") + 1], "Colour1: 0,0,0,200", "after the section's last line");
    // the 7K and the second 4K section are as they were
    assert.ok(out.includes("[Mania]\r\nKeys: 7\r\nColumnWidth: 40,40,40,40,40,40,40\r\n"));
    assert.ok(out.includes("[Mania]\r\nKeys: 4\r\nHitPosition: 300\r\n"));
    assert.ok(out.startsWith("﻿// a skin by TestPlayer\r\n"));
    // everything else is the same as before, line for line
    const before = SKIN.split("\r\n");
    const changed = lines.filter((l) => !before.includes(l));
    assert.deepEqual(changed.sort(), ["Colour1: 0,0,0,200", "ColumnWidth :  60,60,60,60   ", "Name:   Renamed  "].sort());
    setValue(doc, { mania: 4 }, "HitPosition", "430");
    assert.ok(writeSkinIni(doc).includes("HitPosition: 430 // comment-like tail\r\n"), "the comment stays");
    removeKey(doc, { mania: 4 }, "NoteImage0");
    assert.ok(!writeSkinIni(doc).includes("NoteImage0"));
});

test("an LF file gets LF lines; a missing 4K section is made; a file without final newline stays without", () => {
    const lf = "[General]\nName: A\n\n[Mania]\nKeys: 7";
    const out = patchSkinIni(lf, { mania4: { HitPosition: "410" }, mania7: { HitPosition: "400" } });
    assert.equal(out, "[General]\nName: A\n\n[Mania]\nKeys: 7\nHitPosition: 400\n\n[Mania]\nKeys: 4\nHitPosition: 410\n");
    assert.equal(patchSkinIni("[General]\r\nName: A", { General: { Author: "TestPlayer" } }), "[General]\r\nName: A\r\nAuthor: TestPlayer");
    // an empty file gets its sections
    const made = parseSkinIni("");
    ensureSection(made, { mania: 4 });
    ensureSection(made, "General");
    assert.equal(writeSkinIni(made), "[General]\r\n\r\n[Mania]\r\nKeys: 4\r\n");
    // null removes
    assert.equal(patchSkinIni("[Mania]\nKeys: 4\nUpsideDown: 1\n", { mania4: { UpsideDown: null } }), "[Mania]\nKeys: 4\n");
});

test("field values: osu!'s defaults when unset, lists repeat their last value, colours with alpha", () => {
    const pairs = pairsOf(parseSkinIni(SKIN), { mania: 4 });
    const v = (key) => fieldValue(fieldByKey.get(key.toLowerCase()), pairs);
    assert.deepEqual(v("ColumnWidth"), [55, 55, 55, 55]);
    assert.equal(v("HitPosition"), 420, "a // comment after the value is not part of it");
    assert.equal(v("ColumnStart"), 200);
    assert.equal(v("LightPosition"), 413);
    assert.deepEqual(v("ColumnLineWidth"), [2, 2, 2, 2, 2]);
    assert.deepEqual(v("Colour1"), [0, 0, 0, 255]);
    assert.deepEqual(v("ColourLight2"), [55, 255, 255, 255]);
    assert.equal(v("NoteBodyStyle"), 1);
    assert.equal(v("NoteImage0"), "Notes\\note1");
    assert.equal(v("WidthForNoteHeightScale"), null);
    assert.deepEqual(readList("30,40", 4), [30, 40, 40, 40]);
    assert.equal(readList("a,b", 4), null);
    assert.deepEqual(readColour("10, 20,30"), [10, 20, 30, 255]);
    assert.equal(readColour("10,20"), null);
    const f = (key) => fieldByKey.get(key.toLowerCase());
    assert.equal(fieldText(f("ColumnWidth"), [60, 60.5, 60, 60]), "60,60.5,60,60");
    assert.equal(fieldText(f("Colour1"), [1, 2, 3, 4]), "1,2,3,4");
    assert.equal(fieldText(f("ColourLight1"), [1, 2, 3, 4]), "1,2,3");
    assert.equal(fieldText(f("UpsideDown"), true), "1");
    assert.equal(fieldText(f("HitPosition"), 410.4), "410");
    assert.equal(fieldValue(f("ComboBurstStyle"), new Map([["comboburststyle", { value: "Both" }]])), 2);
});

test("every [Mania] key the wiki lists for 4K is a field, column numbering as osu! reads it", () => {
    const keys = new Set(MANIA_FIELDS.map((f) => f.key));
    for (const key of ["ColumnStart", "ColumnRight", "ColumnWidth", "ColumnLineWidth", "ColumnSpacing", "HitPosition", "LightPosition",
        "ScorePosition", "ComboPosition", "JudgementLine", "KeysUnderNotes", "UpsideDown", "NoteBodyStyle", "SpecialStyle",
        "WidthForNoteHeightScale", "ColourColumnLine", "ColourJudgementLine", "ColourHold", "ColourBreak", "StageLeft", "StageRight",
        "StageBottom", "StageHint", "StageLight", "LightingN", "LightingL", "Hit0", "Hit50", "Hit100", "Hit200", "Hit300", "Hit300g"]) {
        assert.ok(keys.has(key), key);
    }
    for (const c of [1, 2, 3, 4]) for (const key of [`Colour${c}`, `ColourLight${c}`]) assert.ok(keys.has(key), key);
    for (const c of [0, 1, 2, 3]) for (const key of [`KeyImage${c}`, `KeyImage${c}D`, `NoteImage${c}`, `NoteImage${c}H`, `NoteImage${c}L`, `NoteImage${c}T`]) assert.ok(keys.has(key), key);
    assert.ok(!keys.has("Colour0") && !keys.has("KeyImage4"));
    // every field has texts
    for (const f of MANIA_FIELDS) assert.ok(f.label.startsWith("skin.") && f.tip.startsWith("skin."), f.key);
});

test("maniaConfig: osu!'s file names where the skin names none (1-2-2-1), and image candidates", () => {
    const cfg = maniaConfig(pairsOf(parseSkinIni(SKIN), { mania: 4 }));
    assert.equal(cfg.images.NoteImage0, "Notes\\note1");
    assert.equal(cfg.images.NoteImage1, "mania-note2");
    assert.equal(cfg.images.NoteImage3, "mania-note1");
    assert.equal(cfg.images.KeyImage2D, "mania-key2D");
    assert.equal(cfg.images.StageHint, "mania-stage-hint");
    assert.equal(cfg.images.Hit300g, "mania-hit300g");
    assert.equal(cfg.fallback.NoteImage2T, "NoteImage2H");
    assert.deepEqual(cfg.bodyStyles, [1, 1, 1, 1]);
    assert.equal(defaultImage("lightingN"), "lightingN");
    assert.deepEqual(imageCandidates("Notes\\note1"), ["Notes/note1@2x.png", "Notes/note1.png", "Notes/note1@2x.jpg", "Notes/note1.jpg"]);
    assert.deepEqual(imageCandidates("a/b.png").slice(0, 2), ["a/b@2x.png", "a/b.png"]);
    assert.deepEqual(imageCandidates(""), []);
});
