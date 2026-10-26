// Interlude's own skin made from the builder's choices: a .isk (a zip of the skin folder) with skin.json and a
// Noteskin folder of noteskin.json and grid textures. Re-implemented from how Prelude (MIT) reads them:
//   prelude/src/Skins/Skin.fs — a skin is a folder with skin.json { Name, Author, Editor } and a Noteskin\ folder;
//   prelude/src/Skins/Noteskins/NoteskinConfig.fs — noteskin.json's fields and their defaults, and the textures each
//     setting needs (note, holdhead, holdbody, holdtail, receptor, receptorlighting, noteexplosion, holdexplosion,
//     judgementline, stageleft, stageright), frames square where it says so;
//   prelude/src/Skins/Storage.fs — a texture is one "name[COLSxROWS].png" grid: columns are animation frames, rows
//     colours (a note's colour id picks its row, wrapping);
//   interlude/src/Features/Play/Playfield.fs — a receptor's row is colour × 2 + (pressed ? 1 : 0); hold tails are
//     drawn for upscroll and flipped in downscroll when FlipHoldTail is set;
//   interlude/src/Content/Skins.fs, interlude/src/Features/Import/FileDrop.fs — a .isk dropped on the window is copied
//     into Skins and unpacked there.
// Colours in noteskin.json are [A, R, G, B]; enums are written by name.
import { createImage, drawNote, drawBody, drawColumnLight, drawBurst, drawBorder, drawHint } from "./art.js";
import { roundBox, outline, hexRgb, lighter, darker, fitted } from "./raster.js";
import { normalizeOptions } from "./build.js";
import { KEYS } from "./maniaFields.js";

const FRAME = 128;
// osu! stage units (480 high) → Interlude pixels (1080 high), as Prelude's osu! converter scales ColumnWidth
const TO_INTERLUDE = 1080 / 480;

// Images stacked as one grid texture of 1 column × n rows (all the same size).
function stack(images) {
    const w = images[0].width;
    const h = images[0].height;
    const grid = createImage(w, h * images.length);
    images.forEach((img, i) => grid.draw(img, 0, i * h));
    return grid;
}

// A hold tail for Interlude: the body's end, rounded at the bottom only (upscroll), flipped by Interlude in downscroll.
function drawInterludeTail(image, shape, colour, size) {
    const { width: w, height: h } = image;
    const fill = { bar: 1, circle: 0.72, arrow: 0.62, diamond: 0.7 }[shape] ?? 0.72;
    const half = (w * size * fill) / 2;
    const base = darker(colour, 0.2);
    // straight on top (it joins the body), round below
    image.fill((x, y) => Math.max(Math.abs(x - w / 2) - half, y - h * 0.6), [...base, 0.82]);
    const cap = roundBox(w / 2, h * 0.45, half, h * 0.2, half);
    image.fill(cap, [...lighter(base, 0.15), 0.9]);
    image.fill(outline(cap, Math.max(1, w * 0.04)), [...lighter(colour, 0.3), 0.95]);
    return image;
}

// A receptor: the note's shape as an outline (not pressed) or filled bright (pressed), in a square.
function drawReceptor(image, shape, colour, { pressed, column, size, theme }) {
    const { width: w } = image;
    const ghost = createImage(w, w);
    drawNote(ghost, shape, pressed ? lighter(colour, 0.35) : theme === "light" ? darker(colour, 0.35) : colour, { size, column });
    // not pressed: only the rim and a faint fill
    if (!pressed) {
        for (let i = 3; i < ghost.px.length; i += 4) ghost.px[i] *= 0.4;
    }
    image.draw(ghost, 0, 0);
    return image;
}

const argb = (rgb, a = 255) => [a, rgb[0], rgb[1], rgb[2]];
const rows = (n) => Array.from({ length: n }, (_, i) => i);

// The noteskin.json for 4K: every field Prelude knows, the builder's where it has one.
export function noteskinConfig(o, mania = {}) {
    const width = Math.round((mania.columnWidth?.[0] ?? o.columnWidth) * TO_INTERLUDE);
    const spacing = Math.round((mania.columnSpacing?.[0] ?? 0) * TO_INTERLUDE);
    const lane = o.theme === "light" ? [235, 236, 236, 244] : [235, 8, 7, 14];
    const keymodeColors = rows(9).map(() => rows(10));
    // 4K: column k takes colour row k
    keymodeColors[KEYS - 2] = rows(10);
    return {
        AdvancedColumnSpacing: rows(8).map((i) => Array(2 + i).fill(0)),
        AnimationFrameTime: 200,
        ColumnLightColors: rows(8).map((i) => rows(3 + i)),
        ColumnLightDuration: 100,
        ColumnLightOffset: 0,
        ColumnSpacing: spacing,
        ColumnWidth: width,
        DroppedHoldColor: [255, 150, 150, 150],
        EnableColumnLight: o.lighting,
        EnableStageTextures: o.stage !== "plain",
        FillColumnGaps: false,
        FlipHoldTail: true,
        HoldExplosionSettings: {
            AnimationFrameTime: 20, Colors: "Note", Duration: 300, ExpandAmount: 0.15, Offset: 0,
            ReleaseUseBuiltInAnimation: true, Scale: 1, UseReleaseExplosion: false,
        },
        HoldNoteTrim: 0,
        JudgementLineOffset: 0,
        JudgementLineScale: 1,
        KeymodeSpecificColumnWidth: Array(8).fill(width),
        LinearSampling: o.font !== "pixel",
        MinimumHoldNoteLength: false,
        NoteColors: { Colors: keymodeColors, Style: "Column", UseGlobalColors: false },
        NoteExplosionSettings: {
            AnimationFrameTime: 20, Colors: "Note", Duration: 300, ExpandAmount: 0.15, Offset: 0, Scale: 1, UseBuiltInAnimation: true,
        },
        NotesUnderReceptors: !(mania.keysUnderNotes ?? 0),
        PlayfieldAlignment: [0.5, 0.5],
        PlayfieldColor: lane,
        ReceptorColors: rows(8).map((i) => rows(3 + i)),
        ReceptorOffset: 0,
        ReceptorStyle: "Receptors",
        Rotations: [[90, 0, 270], [90, 0, 180, 270], [45, 135, 0, 225, 315], [90, 135, 0, 180, 225, 270], [135, 90, 45, 0, 315, 270, 225],
            [90, 0, 180, 270, 90, 0, 180, 270], [0, 0, 0, 0, 0, 0, 0, 0, 0], [45, 135, 0, 225, 315, 45, 135, 0, 225, 315]],
        UseAdvancedColumnSpacing: false,
        UseExplosions: o.lighting,
        UseHoldTailTexture: true,
        UseJudgementLine: o.stage === "glow",
        UseKeymodeSpecificColumnWidth: false,
        UseReceptors: true,
        // arrows are drawn already turned for their column
        UseRotation: false,
    };
}

// Which skin.ini picture stands in for which Interlude texture when the user gave their own. Judgements have no
// noteskin texture (they are Interlude's HUD and ruleset), StageBottom has no counterpart.
export const OVERRIDE_TEXTURES = {
    note: (c) => `NoteImage${c}`, holdhead: (c) => `NoteImage${c}H`, holdbody: (c) => `NoteImage${c}L`, holdtail: (c) => `NoteImage${c}T`,
    receptor: (c, pressed) => `KeyImage${c}${pressed ? "D" : ""}`,
    receptorlighting: () => "StageLight", noteexplosion: () => "LightingN", holdexplosion: () => "LightingL",
    stageleft: () => "StageLeft", stageright: () => "StageRight", judgementline: () => "StageHint",
};

// builder options (+ the 4K section's maniaConfig, for the sizes the user set in the editor; + the user's own
// pictures by skin.ini key, raster images, which take the place of the drawn ones) → .isk entries [{ name, data }]
// and noteskin.json as an object. A picture of the user's is fitted into Interlude's square frame (aspect kept), a
// hold body stretched to it, a hold tail turned upside down (osu! draws tails for downscroll, Interlude for upscroll).
export function buildInterludeSkin(rawOptions, mania = {}, overrides = {}) {
    const o = normalizeOptions(rawOptions);
    const colours = o.colours.map(hexRgb);
    const size = o.noteSize / 100;
    const frame = () => createImage(FRAME, FRAME);
    const png = (image) => image.png();
    const own = (key) => overrides[key] ?? null;
    const entries = [];
    const add = (name, data) => entries.push({ name, data });
    const anyOwn = (keys) => keys.some((k) => own(k));
    const lighting = o.lighting || anyOwn(["StageLight", "LightingN", "LightingL"]);
    const edges = o.stage !== "plain" || anyOwn(["StageLeft", "StageRight"]);
    const hint = o.stage === "glow" || anyOwn(["StageHint"]);
    const config = { ...noteskinConfig(o, mania), EnableColumnLight: lighting, UseExplosions: lighting, EnableStageTextures: edges, UseJudgementLine: hint };
    add("skin.json", Buffer.from(JSON.stringify({ Author: o.author, Editor: null, Name: o.name }, null, 4), "utf8"));
    add("Noteskin/noteskin.json", Buffer.from(JSON.stringify(config, null, 4), "utf8"));
    // one frame per column: the user's picture of that column when there is one, else the drawing
    const perColumn = (texture, paint, { mode = "fit", flip = false, h = FRAME } = {}) => stack(colours.map((c, column) => {
        const mine = own(OVERRIDE_TEXTURES[texture](column));
        if (mine) {
            const fit = fitted(mine, FRAME, h, { mode });
            return flip ? fit.flipped() : fit;
        }
        return paint(createImage(FRAME, h), c, column);
    }));
    add(`Noteskin/note[1x${KEYS}].png`, png(perColumn("note", (img, c, column) => drawNote(img, o.shape, c, { size, column }))));
    add(`Noteskin/holdhead[1x${KEYS}].png`, png(perColumn("holdhead", (img, c, column) => {
        // a head the user did not give follows their note, as osu! does
        const note = own(`NoteImage${column}`);
        return note ? fitted(note, FRAME, FRAME) : drawNote(img, o.shape, c, { size, column });
    })));
    add(`Noteskin/holdbody[1x${KEYS}].png`, png(perColumn("holdbody", (img, c) => drawBody(img, o.shape, c, { size, style: o.holdStyle }), { mode: "stretch" })));
    add(`Noteskin/holdtail[1x${KEYS}].png`, png(perColumn("holdtail", (img, c) => drawInterludeTail(img, o.shape, c, size), { flip: true })));
    // receptor rows: column 0 up, column 0 pressed, column 1 up, …
    const receptors = colours.flatMap((c, column) => [false, true].map((pressed) => {
        const mine = own(OVERRIDE_TEXTURES.receptor(column, pressed));
        return mine ? fitted(mine, FRAME, FRAME) : drawReceptor(frame(), o.shape, c, { pressed, column, size, theme: o.theme });
    }));
    add(`Noteskin/receptor[1x${KEYS * 2}].png`, png(stack(receptors)));
    if (lighting) {
        add(`Noteskin/receptorlighting[1x${KEYS}].png`, png(perColumn("receptorlighting", (img, c) => drawColumnLight(img, lighter(c, 0.3)), { mode: "stretch", h: FRAME * 3 })));
        add(`Noteskin/noteexplosion[1x${KEYS}].png`, png(perColumn("noteexplosion", (img, c) => drawBurst(img, lighter(c, 0.4)))));
        add(`Noteskin/holdexplosion[1x${KEYS}].png`, png(perColumn("holdexplosion", (img, c) => drawBurst(img, lighter(c, 0.2)))));
    }
    if (edges) {
        const line = o.theme === "light" ? [80, 80, 106] : [200, 196, 220];
        // a single picture, so the user's keeps its own size
        add("Noteskin/stageleft[1x1].png", png(own("StageLeft") ?? drawBorder(createImage(16, 256), line, "left")));
        add("Noteskin/stageright[1x1].png", png(own("StageRight") ?? drawBorder(createImage(16, 256), line, "right")));
    }
    if (hint) add("Noteskin/judgementline[1x1].png", png(own("StageHint") ?? drawHint(createImage(256, 32), lighter(colours[1], 0.4))));
    return { options: o, entries, config };
}
