// The skin builder: a 4K osu!mania skin made from a few choices (note shape, colours per column, sizes, hold look,
// keys, judgement font, stage, hit lighting). Every picture is drawn by src/skin/art.js and src/skin/font.js, at
// @1x and @2x. The result is files to write and the skin.ini values that point at them, so the same call makes a
// skin from scratch or redraws chosen parts of an opened one.
import { createImage, drawNote, drawBody, drawTail, drawKey, drawHint, drawBorder, drawColumnLight, drawBurst } from "./art.js";
import { renderText } from "./font.js";
import { normalizeOptions, PARTS, DEFAULT_OPTIONS } from "./options.js";
import { hexRgb, lighter, mix } from "./raster.js";
import { KEYS } from "./maniaFields.js";

export * from "./options.js";

// The judgements in order Hit300g … Hit0: [key, file part, numbers text, words text, colour]
export const JUDGEMENTS = [
    ["Hit300g", "hit300g", "MAX", "PERFECT", "#c8f4ff"],
    ["Hit300", "hit300", "300", "GREAT", "#f5c66b"],
    ["Hit200", "hit200", "200", "GOOD", "#7be08f"],
    ["Hit100", "hit100", "100", "OK", "#8fd3ff"],
    ["Hit50", "hit50", "50", "MEH", "#b8b4c8"],
    ["Hit0", "hit0", "MISS", "MISS", "#ff6b6b"],
];

// The picture sizes at @1x (px). Notes are as wide as osu! draws a column at 768 px high and twice that at @2x;
// a key image fills from the hit line to the bottom at the chosen column width.
export function sizes(o) {
    const W = 64;
    const barH = Math.round(W * 0.3 * (o.noteSize / 85));
    return {
        note: [W, o.shape === "bar" ? Math.max(8, barH) : W],
        body: [W, W],
        tail: [W, Math.round(W * 0.22)],
        key: [W, Math.max(16, Math.round((W * (480 - o.hitPosition)) / o.columnWidth))],
        hint: [W, 20],
        border: [8, 128],
        light: [W, 192],
        burst: [128, 128],
        blank: [1, 1],
    };
}

const at2x = (name) => `${name}@2x`;

// Draw one picture at a scale.
function draw(kind, o, scale, extra = {}) {
    const s = sizes(o)[kind === "keyD" ? "key" : kind];
    const image = createImage(s[0] * scale, s[1] * scale);
    const colour = extra.colour ? hexRgb(extra.colour) : [255, 255, 255];
    const size = o.noteSize / 100;
    switch (kind) {
    case "note": return drawNote(image, o.shape, colour, { size, column: extra.column });
    case "body": return drawBody(image, o.shape, colour, { size, style: o.holdStyle });
    case "tail": return drawTail(image, o.shape, colour, { size });
    case "key": return drawKey(image, o.shape, colour, { style: o.keyStyle, theme: o.theme, column: extra.column });
    case "keyD": return drawKey(image, o.shape, colour, { pressed: true, style: o.keyStyle, theme: o.theme, column: extra.column });
    case "hint": return drawHint(image, colour);
    case "border": return drawBorder(image, colour, extra.side);
    case "light": return drawColumnLight(image);
    case "burst": return drawBurst(image, colour);
    default: return image;
    }
}

const accentOf = (o) => (o.theme === "light" ? [60, 60, 80] : hexRgb(o.colours[1]));
const rgbText = (c, a) => (a === undefined ? c.join(",") : `${c.join(",")},${a}`);

// options, { dir: folder the files go in (relative, "/"), parts: which to make (all by default) } →
// { files: [{ name, data }], general: { key: value }, mania: { key: value | null } }
export function buildSkin(rawOptions, { dir = "lunacy", parts = PARTS } = {}) {
    const o = normalizeOptions(rawOptions);
    const want = new Set(parts.filter((p) => PARTS.includes(p)));
    const files = [];
    const mania = {};
    const cache = new Map();
    // one picture at @1x and @2x under dir/name; the same drawing is made once
    const put = (name, kind, extra = {}) => {
        const id = `${kind}|${extra.colour ?? ""}|${extra.column ?? ""}|${extra.side ?? ""}`;
        if (cache.has(id)) return cache.get(id);
        const path = `${dir}/${name}`;
        files.push({ name: `${path}.png`, data: draw(kind, o, 1, extra).png() });
        files.push({ name: `${at2x(path)}.png`, data: draw(kind, o, 2, extra).png() });
        cache.set(id, path);
        return path;
    };
    const blank = () => put("blank", "blank");
    // arrows differ per column even in one colour; other shapes only per colour
    const noteId = (c) => (o.shape === "arrow" ? c : null);
    const tag = (c) => o.colours[c].slice(1);
    const light = o.theme === "light";

    if (want.has("layout")) {
        const total = o.columnWidth * KEYS;
        Object.assign(mania, {
            ColumnStart: String(Math.max(0, Math.round((640 - total) / 2))),
            ColumnRight: "19",
            ColumnWidth: Array(KEYS).fill(o.columnWidth).join(","),
            ColumnSpacing: Array(KEYS - 1).fill(0).join(","),
            HitPosition: String(o.hitPosition),
            LightPosition: String(o.hitPosition),
            ScorePosition: String(Math.round(o.hitPosition * 0.62)),
            ComboPosition: String(Math.round(o.hitPosition * 0.3)),
            NoteBodyStyle: String(o.bodyStyle),
            KeysUnderNotes: "0",
        });
    }
    for (let c = 0; c < KEYS; c += 1) {
        const colour = o.colours[c];
        if (want.has("notes")) {
            const note = put(o.shape === "arrow" ? `note-${c}-${tag(c)}` : `note-${tag(c)}`, "note", { colour, column: noteId(c) });
            mania[`NoteImage${c}`] = note;
            mania[`NoteImage${c}H`] = note;
        }
        if (want.has("holds")) {
            mania[`NoteImage${c}L`] = put(`body-${tag(c)}`, "body", { colour });
            mania[`NoteImage${c}T`] = put(`tail-${tag(c)}`, "tail", { colour });
        }
        if (want.has("keys")) {
            const column = o.keyStyle === "ring" && o.shape === "arrow" ? c : null;
            mania[`KeyImage${c}`] = put(`key-${column === null ? "" : `${column}-`}${tag(c)}`, "key", { colour, column });
            mania[`KeyImage${c}D`] = put(`key-${column === null ? "" : `${column}-`}${tag(c)}-d`, "keyD", { colour, column });
        }
        if (want.has("stage")) mania[`Colour${c + 1}`] = light ? "236,236,244,235" : "8,7,14,235";
        if (want.has("lighting")) mania[`ColourLight${c + 1}`] = rgbText(hexRgb(colour));
    }
    if (want.has("stage")) {
        const accent = accentOf(o);
        const lines = o.stage !== "plain";
        mania.StageHint = put("hint", "hint", { colour: `#${accent.map((v) => v.toString(16).padStart(2, "0")).join("")}` });
        mania.StageLeft = lines ? put("stage-left", "border", { colour: light ? "#50506a" : "#c8c4dc", side: "left" }) : blank();
        mania.StageRight = lines ? put("stage-right", "border", { colour: light ? "#50506a" : "#c8c4dc", side: "right" }) : blank();
        mania.StageBottom = blank();
        mania.ColumnLineWidth = Array(KEYS + 1).fill(o.stage === "lines" ? 1 : 0).join(",");
        mania.ColourColumnLine = light ? "0,0,0,40" : "255,255,255,36";
        mania.JudgementLine = o.stage === "glow" ? "1" : "0";
        mania.ColourJudgementLine = rgbText(lighter(accent, 0.4));
    }
    if (want.has("lighting")) {
        mania.StageLight = o.lighting ? put("stage-light", "light") : blank();
        mania.LightingN = o.lighting ? put("lighting-n", "burst", { colour: "#ffffff" }) : blank();
        mania.LightingL = o.lighting ? put("lighting-l", "burst", { colour: `#${lighter(hexRgb(o.colours[1]), 0.5).map((v) => v.toString(16).padStart(2, "0")).join("")}` }) : blank();
    }
    if (want.has("judgements")) {
        for (const [key, part, number, word, colour] of JUDGEMENTS) {
            const text = o.judgements === "words" ? word : number;
            const path = `${dir}/${part}`;
            const rgb = mix(hexRgb(colour), light ? [40, 40, 60] : [255, 255, 255], light ? 0.25 : 0);
            files.push({ name: `${path}.png`, data: renderText(text, { unit: 5, font: o.font, colour: rgb }).png() });
            files.push({ name: `${at2x(path)}.png`, data: renderText(text, { unit: 10, scale: 2, font: o.font, colour: rgb }).png() });
            mania[key] = path;
        }
    }
    const general = want.has("layout") ? { Name: o.name, Author: o.author } : {};
    return { options: o, files, general, mania };
}

// A whole skin.ini for a skin made from scratch: [General] and [Mania] Keys: 4 with every value the builder sets.
export function skinIniText(result) {
    const lines = [
        "// Made with Lunacy mania (osu!mania 4K skin builder)",
        "[General]",
        `Name: ${result.general.Name ?? DEFAULT_OPTIONS.name}`,
        `Author: ${result.general.Author ?? DEFAULT_OPTIONS.author}`,
        "Version: 2.7",
        "",
        "[Mania]",
        "Keys: 4",
        ...Object.entries(result.mania).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`),
        "",
    ];
    return lines.join("\r\n");
}
