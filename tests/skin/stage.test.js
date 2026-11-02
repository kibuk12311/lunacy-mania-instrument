import test from "node:test";
import assert from "node:assert/strict";
import { createStagePainter, STAGE_H } from "../../app/renderer/skinStage.js";
import { maniaConfig } from "../../src/skin/maniaFields.js";
import { parseSkinIni, pairsOf } from "../../src/skin/skinIni.js";

// A canvas that remembers where each picture went, in stage units; a flipped picture is told by its top on the stage.
function recorder() {
    const drawn = [];
    let flipAt = null;
    const ctx = {
        save() {}, restore() { flipAt = null; }, beginPath() {}, rect() {}, clip() {}, fillRect() {},
        translate(_x, y) { flipAt = y; },
        scale() {},
        drawImage(src, x, y, w, h) { drawn.push({ src, x, y: flipAt === null ? y : flipAt - h, w, h }); },
    };
    return { ctx, drawn };
}

const picture = (naturalWidth, naturalHeight, hd = false) => ({ img: { naturalWidth, naturalHeight, src: `${naturalWidth}x${naturalHeight}` }, hd });

function paintKeys({ column, key, up = false, light = null, pressed = false }) {
    const lines = ["[Mania]", "Keys: 4", `ColumnWidth: ${Array(4).fill(column).join(",")}`, "HitPosition: 430"];
    for (let c = 0; c < 4; c += 1) lines.push(`KeyImage${c}: key`);
    if (light) lines.push("StageLight: light");
    const cfg = maniaConfig(pairsOf(parseSkinIni(lines.join("\n")), { mania: 4 }));
    const { ctx, drawn } = recorder();
    const images = { key, ...(light ? { light } : {}) };
    createStagePainter().paint(ctx, {
        cfg, images, up, speed: 24, now: 0, notes: [],
        keys: { pressed: Array(4).fill(pressed), hold: Array(4).fill(false), lastHit: Array(4).fill(null), judgement: null },
    });
    return { cfg, drawn };
}

test("a key is stretched to its column and keeps its own height, as osu! draws it", () => {
    // Mystia's 100 × 284 at column 70 and at the +15 % column 80.5: the same height, the bottom on the stage's bottom
    for (const column of [70, 80.5]) {
        const key = picture(100, 284);
        const { drawn } = paintKeys({ column, key });
        const keys = drawn.filter((d) => d.src === key.img);
        assert.equal(keys.length, 4);
        for (const k of keys) {
            assert.equal(k.w, column);
            assert.equal(k.h, 177.5);
            assert.equal(k.y, STAGE_H - 177.5);
        }
    }
});

test("a key at @2x is half as high, whatever its width", () => {
    const key = picture(150, 375, true);
    const { drawn } = paintKeys({ column: 84, key });
    const k = drawn.find((d) => d.src === key.img);
    assert.equal(k.w, 84);
    assert.ok(Math.abs(k.h - 117.1875) < 1e-9);
});

test("upscroll puts the same key against the stage's top", () => {
    const key = picture(100, 284);
    const k = paintKeys({ column: 70, key, up: true }).drawn.find((d) => d.src === key.img);
    assert.equal(k.h, 177.5);
    assert.equal(k.y, 0);
});

test("the column light keeps its own height too, its bottom on LightPosition", () => {
    const made = [];
    globalThis.document = { createElement: () => { const c = { getContext: () => null }; made.push(c); return c; } };
    try {
        const light = picture(64, 192);
        const { cfg, drawn } = paintKeys({ column: 60, key: picture(100, 284), light, pressed: true });
        const lights = drawn.filter((d) => made.includes(d.src));
        assert.equal(lights.length, 4);
        for (const l of lights) {
            assert.equal(l.w, 60);
            assert.equal(l.h, 120);
            assert.equal(l.y, cfg.lightPosition - 120);
        }
    } finally {
        delete globalThis.document;
    }
});
