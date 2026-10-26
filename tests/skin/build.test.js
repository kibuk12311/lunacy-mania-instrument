// The skin builder: every picture at @1x and @2x (twice the size, really drawn), the skin.ini values pointing at
// files it made, choices checked, parts drawn alone; the PNG writer and the stroke font.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSkin, skinIniText, normalizeOptions, patternColours, sizes, JUDGEMENTS, DEFAULT_OPTIONS, SHAPES, FONTS } from "../../src/skin/build.js";
import { decodePng, encodePng, pngSize } from "../../src/skin/png.js";
import { textStrokes, renderText, FONT_CHARS } from "../../src/skin/font.js";
import { parseSkinIni, pairsOf, getValue } from "../../src/skin/skinIni.js";
import { maniaConfig, imageCandidates } from "../../src/skin/maniaFields.js";
import { pairSizes } from "../../app/renderer/skinPictures.js";
import { crc32, deflateSync } from "node:zlib";

const opaque = (png) => {
    const { data } = decodePng(png);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n += 1;
    return n;
};

test("PNG: what is written reads back, size from the header", () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 255);
    const png = encodePng(3, 2, rgba);
    assert.deepEqual(pngSize(png), { width: 3, height: 2 });
    assert.deepEqual([...decodePng(png).data], [...rgba]);
    assert.equal(pngSize(Buffer.from("not a png at all, sorry")), null);
});

test("options: unknown choices fall back, numbers are clamped, palettes give 1-2-2-1 colours", () => {
    const o = normalizeOptions({ shape: "star", columnWidth: 500, noteSize: 3, hitPosition: "x", colours: ["#fff"], name: "[My]\nSkin", author: "" });
    assert.equal(o.shape, DEFAULT_OPTIONS.shape);
    assert.equal(o.columnWidth, 100);
    assert.equal(o.noteSize, 50);
    assert.equal(o.hitPosition, DEFAULT_OPTIONS.hitPosition);
    assert.equal(o.name, "My  Skin");
    assert.equal(o.author, DEFAULT_OPTIONS.author);
    assert.deepEqual(o.colours, patternColours("lunacy", "1221"));
    const [a, b, c, d] = patternColours("ice", "1221");
    assert.ok(a === d && b === c && a !== b);
    assert.deepEqual(normalizeOptions({ colours: ["#AA0000", "#00aa00", "#0000aa", "#ffffff"] }).colours, ["#aa0000", "#00aa00", "#0000aa", "#ffffff"]);
});

test("a whole skin: every value skin.ini names is a file it made, at @1x and @2x twice the size", () => {
    for (const shape of SHAPES) {
        const r = buildSkin({ shape, keyStyle: "ring" }, { dir: "lunacy-mania/b1" });
        const names = new Map(r.files.map((f) => [f.name.toLowerCase(), f.data]));
        const ini = skinIniText(r);
        const doc = parseSkinIni(ini);
        assert.equal(getValue(doc, "General", "Name"), DEFAULT_OPTIONS.name);
        const cfg = maniaConfig(pairsOf(doc, { mania: 4 }));
        assert.deepEqual(cfg.columnWidth, [60, 60, 60, 60]);
        assert.equal(cfg.hitPosition, 410);
        for (const [key, value] of Object.entries(cfg.images)) {
            if (key === "WarningArrow") continue;
            const [hd, sd] = imageCandidates(value);
            assert.ok(names.has(sd.toLowerCase()) && names.has(hd.toLowerCase()), `${shape} ${key} → ${value}`);
            const one = pngSize(names.get(sd.toLowerCase()));
            const two = pngSize(names.get(hd.toLowerCase()));
            assert.equal(two.width, one.width * 2, `${key} @2x width`);
            assert.equal(two.height, one.height * 2, `${key} @2x height`);
        }
        // the pictures are drawn, not empty (the blank one aside)
        for (const [name, data] of names) if (!name.includes("blank")) assert.ok(opaque(data) > 0, `${shape} ${name} has pixels`);
        // a note is as wide as a column picture is (64 / 128 px); a key fills from the hit line down at this width
        const note = pngSize(names.get(imageCandidates(cfg.images.NoteImage0)[1].toLowerCase()));
        assert.equal(note.width, 64);
        if (shape !== "bar") assert.equal(note.height, 64);
        else assert.ok(note.height < 32);
        const key = pngSize(names.get(imageCandidates(cfg.images.KeyImage0)[1].toLowerCase()));
        assert.equal(key.height, Math.round((64 * (480 - 410)) / 60));
    }
});

test("arrows get a picture per column (they point four ways); circles share one per colour", () => {
    const arrows = buildSkin({ shape: "arrow" }).mania;
    assert.equal(new Set([0, 1, 2, 3].map((c) => arrows[`NoteImage${c}`])).size, 4);
    const circles = buildSkin({ shape: "circle", pattern: "1221" }).mania;
    assert.equal(circles.NoteImage0, circles.NoteImage3);
    assert.equal(circles.NoteImage1, circles.NoteImage2);
    assert.notEqual(circles.NoteImage0, circles.NoteImage1);
});

test("parts: only what is asked is drawn and set; no lighting points at a blank picture", () => {
    const r = buildSkin({}, { parts: ["notes"] });
    assert.deepEqual(Object.keys(r.mania).sort(), ["NoteImage0", "NoteImage0H", "NoteImage1", "NoteImage1H", "NoteImage2", "NoteImage2H", "NoteImage3", "NoteImage3H"]);
    assert.deepEqual(r.general, {});
    const dark = buildSkin({ lighting: false }, { parts: ["lighting"] });
    assert.ok(dark.mania.StageLight.endsWith("/blank") && dark.mania.LightingN.endsWith("/blank"));
    assert.equal(dark.mania.ColourLight1.split(",").length, 3);
    const judgements = buildSkin({ judgements: "words" }, { parts: ["judgements"] });
    assert.deepEqual(Object.keys(judgements.mania), JUDGEMENTS.map(([k]) => k));
    assert.equal(judgements.files.length, 12);
});

test("sizes follow the choices: wider columns give shorter key pictures, bigger bars are taller", () => {
    const narrow = sizes(normalizeOptions({ columnWidth: 40 }));
    const wide = sizes(normalizeOptions({ columnWidth: 80 }));
    assert.ok(narrow.key[1] > wide.key[1]);
    assert.ok(sizes(normalizeOptions({ shape: "bar", noteSize: 100 })).note[1] > sizes(normalizeOptions({ shape: "bar", noteSize: 50 })).note[1]);
});

test("the stroke font: every letter the judgements use exists, and texts are drawn in each look", () => {
    for (const [, , number, word] of JUDGEMENTS) {
        for (const ch of `${number}${word}`) assert.ok(FONT_CHARS.includes(ch), ch);
    }
    assert.ok(textStrokes("MISS").strokes.length >= 8);
    assert.ok(textStrokes("300").width > textStrokes("50").width);
    for (const font of FONTS) {
        const png = renderText("300", { unit: 5, font }).png();
        assert.ok(opaque(png) > 100, font);
    }
});

// a minimal PNG of another colour type, written by hand (filter 0 rows)
function rawPng(width, height, type, rows, extra = []) {
    const chunk = (kind, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(kind, 4, "latin1");
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
        return Buffer.concat([head, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = type;
    const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra.map(([k, d]) => chunk(k, Buffer.from(d))), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("PNG reading: grey, RGB, palette with transparency and grey + alpha come out as RGBA", () => {
    assert.deepEqual([...decodePng(rawPng(1, 1, 0, [[77]])).data], [77, 77, 77, 255]);
    assert.deepEqual([...decodePng(rawPng(2, 1, 2, [[1, 2, 3, 4, 5, 6]])).data], [1, 2, 3, 255, 4, 5, 6, 255]);
    assert.deepEqual([...decodePng(rawPng(2, 1, 3, [[0, 1]], [["PLTE", [9, 8, 7, 6, 5, 4]], ["tRNS", [0]]])).data], [9, 8, 7, 0, 6, 5, 4, 255]);
    assert.deepEqual([...decodePng(rawPng(1, 1, 4, [[50, 128]])).data], [50, 50, 50, 128]);
    assert.throws(() => decodePng(Buffer.from("nope")));
});

test("a picture's two sizes: @1x and twice it, an @2x file halved, the @2x kept within 4096 px", () => {
    assert.deepEqual(pairSizes(64, 30, false), { one: [64, 30], two: [128, 60] });
    assert.deepEqual(pairSizes(128, 61, true), { one: [64, 31], two: [128, 61] });
    const huge = pairSizes(3000, 1500, false);
    assert.deepEqual(huge.two, [4096, 2048]);
    assert.deepEqual(huge.one, [2048, 1024]);
});
