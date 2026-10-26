// The osu!mania 4K settings of skin.ini the Skin tab edits ([Mania] with Keys: 4, plus [General] Name/Author), as
// the osu! wiki (Skinning/skin.ini) documents them: type, default, range and the texts of each field. Column
// numbers: Colour#/ColourLight# count from 1, KeyImage#/NoteImage# from 0 (as osu! reads them).
// Positions and widths are in osu!'s 480-high stage units. Pure, shared by main and the renderer.

export const KEYS = 4;

// [field]: { key, group, type, def, min, max, step, n (list length), options (enum), label, tip }
// type: "text" | "int" | "float" | "list" | "bool" | "enum" | "rgb" | "rgba" | "image"
const F = (key, group, type, def, label, tip, extra = {}) => ({ key, group, type, def, label, tip, ...extra });

export const GENERAL_FIELDS = [
    F("Name", "general", "text", "", "skin.f.name", "skin.f.nameTip"),
    F("Author", "general", "text", "", "skin.f.author", "skin.f.authorTip"),
];

export const MANIA_FIELDS = [
    // layout
    F("ColumnStart", "layout", "int", 136, "skin.f.columnStart", "skin.f.columnStartTip", { min: 0, max: 640, step: 1 }),
    F("ColumnRight", "layout", "int", 19, "skin.f.columnRight", "skin.f.columnRightTip", { min: 0, max: 640, step: 1 }),
    F("ColumnWidth", "layout", "list", 30, "skin.f.columnWidth", "skin.f.columnWidthTip", { n: KEYS, min: 5, max: 120, step: 1 }),
    F("ColumnSpacing", "layout", "list", 0, "skin.f.columnSpacing", "skin.f.columnSpacingTip", { n: KEYS - 1, min: -50, max: 100, step: 1 }),
    F("ColumnLineWidth", "layout", "list", 2, "skin.f.columnLineWidth", "skin.f.columnLineWidthTip", { n: KEYS + 1, min: 0, max: 20, step: 0.5 }),
    F("HitPosition", "layout", "int", 402, "skin.f.hitPosition", "skin.f.hitPositionTip", { min: 240, max: 480, step: 1 }),
    F("LightPosition", "layout", "int", 413, "skin.f.lightPosition", "skin.f.lightPositionTip", { min: 0, max: 480, step: 1 }),
    F("ScorePosition", "layout", "int", 325, "skin.f.scorePosition", "skin.f.scorePositionTip", { min: 0, max: 480, step: 1 }),
    F("ComboPosition", "layout", "int", 111, "skin.f.comboPosition", "skin.f.comboPositionTip", { min: 0, max: 480, step: 1 }),
    F("BarlineHeight", "layout", "float", 1.2, "skin.f.barlineHeight", "skin.f.barlineHeightTip", { min: 0, max: 10, step: 0.1 }),
    F("WidthForNoteHeightScale", "layout", "float", null, "skin.f.widthForNoteHeightScale", "skin.f.widthForNoteHeightScaleTip", { min: 0, max: 120, step: 1 }),
    F("LightingNWidth", "layout", "list", null, "skin.f.lightingNWidth", "skin.f.lightingNWidthTip", { n: KEYS, min: 0, max: 200, step: 1 }),
    F("LightingLWidth", "layout", "list", null, "skin.f.lightingLWidth", "skin.f.lightingLWidthTip", { n: KEYS, min: 0, max: 200, step: 1 }),
    // behaviour
    F("UpsideDown", "behaviour", "bool", 0, "skin.f.upsideDown", "skin.f.upsideDownTip"),
    F("KeysUnderNotes", "behaviour", "bool", 0, "skin.f.keysUnderNotes", "skin.f.keysUnderNotesTip"),
    F("JudgementLine", "behaviour", "bool", 1, "skin.f.judgementLine", "skin.f.judgementLineTip"),
    F("NoteBodyStyle", "behaviour", "enum", 1, "skin.f.noteBodyStyle", "skin.f.noteBodyStyleTip", {
        options: [{ value: 0, label: "skin.opt.bodyStretch" }, { value: 1, label: "skin.opt.bodyRepeatTop" }, { value: 2, label: "skin.opt.bodyRepeatBottom" }],
    }),
    F("SpecialStyle", "behaviour", "enum", 0, "skin.f.specialStyle", "skin.f.specialStyleTip", {
        options: [{ value: 0, label: "skin.opt.specialNone" }, { value: 1, label: "skin.opt.specialLeft" }, { value: 2, label: "skin.opt.specialRight" }],
    }),
    F("ComboBurstStyle", "behaviour", "enum", 1, "skin.f.comboBurstStyle", "skin.f.comboBurstStyleTip", {
        options: [{ value: 0, label: "skin.opt.burstLeft" }, { value: 1, label: "skin.opt.burstRight" }, { value: 2, label: "skin.opt.burstBoth" }],
    }),
    F("KeyFlipWhenUpsideDown", "behaviour", "bool", 1, "skin.f.keyFlip", "skin.f.keyFlipTip"),
    F("NoteFlipWhenUpsideDown", "behaviour", "bool", 1, "skin.f.noteFlip", "skin.f.noteFlipTip"),
    F("SeparateScore", "behaviour", "bool", 1, "skin.f.separateScore", "skin.f.separateScoreTip"),
    F("LightFramePerSecond", "behaviour", "int", 60, "skin.f.lightFps", "skin.f.lightFpsTip", { min: 1, max: 240, step: 1 }),
    // colours
    ...[1, 2, 3, 4].map((c) => F(`Colour${c}`, "colours", "rgba", "0,0,0,255", "skin.f.colour", "skin.f.colourTip", { column: c - 1 })),
    ...[1, 2, 3, 4].map((c) => F(`ColourLight${c}`, "colours", "rgb", "55,255,255", "skin.f.colourLight", "skin.f.colourLightTip", { column: c - 1 })),
    F("ColourColumnLine", "colours", "rgba", "255,255,255,255", "skin.f.colourColumnLine", "skin.f.colourColumnLineTip"),
    F("ColourBarline", "colours", "rgba", "255,255,255,255", "skin.f.colourBarline", "skin.f.colourBarlineTip"),
    F("ColourJudgementLine", "colours", "rgb", "255,255,255", "skin.f.colourJudgementLine", "skin.f.colourJudgementLineTip"),
    F("ColourKeyWarning", "colours", "rgb", "0,0,0", "skin.f.colourKeyWarning", "skin.f.colourKeyWarningTip"),
    F("ColourHold", "colours", "rgba", "255,191,51,255", "skin.f.colourHold", "skin.f.colourHoldTip"),
    F("ColourBreak", "colours", "rgb", "255,0,0", "skin.f.colourBreak", "skin.f.colourBreakTip"),
    // images of each column
    ...[0, 1, 2, 3].flatMap((c) => [
        F(`KeyImage${c}`, "columns", "image", null, "skin.f.keyImage", "skin.f.keyImageTip", { column: c, part: "key" }),
        F(`KeyImage${c}D`, "columns", "image", null, "skin.f.keyImageD", "skin.f.keyImageDTip", { column: c, part: "keyD" }),
        F(`NoteImage${c}`, "columns", "image", null, "skin.f.noteImage", "skin.f.noteImageTip", { column: c, part: "note" }),
        F(`NoteImage${c}H`, "columns", "image", null, "skin.f.noteImageH", "skin.f.noteImageHTip", { column: c, part: "head" }),
        F(`NoteImage${c}L`, "columns", "image", null, "skin.f.noteImageL", "skin.f.noteImageLTip", { column: c, part: "body" }),
        F(`NoteImage${c}T`, "columns", "image", null, "skin.f.noteImageT", "skin.f.noteImageTTip", { column: c, part: "tail" }),
    ]),
    // the stage
    F("StageLeft", "stage", "image", null, "skin.f.stageLeft", "skin.f.stageLeftTip", { part: "stageLeft" }),
    F("StageRight", "stage", "image", null, "skin.f.stageRight", "skin.f.stageRightTip", { part: "stageRight" }),
    F("StageBottom", "stage", "image", null, "skin.f.stageBottom", "skin.f.stageBottomTip", { part: "stageBottom" }),
    F("StageHint", "stage", "image", null, "skin.f.stageHint", "skin.f.stageHintTip", { part: "stageHint" }),
    F("StageLight", "stage", "image", null, "skin.f.stageLight", "skin.f.stageLightTip", { part: "stageLight" }),
    F("LightingN", "stage", "image", null, "skin.f.lightingN", "skin.f.lightingNTip", { part: "lightingN" }),
    F("LightingL", "stage", "image", null, "skin.f.lightingL", "skin.f.lightingLTip", { part: "lightingL" }),
    F("WarningArrow", "stage", "image", null, "skin.f.warningArrow", "skin.f.warningArrowTip", { part: "warningArrow" }),
    // judgements
    ...[["Hit300g", "hit300g", "skin.f.hit300g"], ["Hit300", "hit300", "skin.f.hit300"], ["Hit200", "hit200", "skin.f.hit200"],
        ["Hit100", "hit100", "skin.f.hit100"], ["Hit50", "hit50", "skin.f.hit50"], ["Hit0", "hit0", "skin.f.hit0"]]
        .map(([key, part, label]) => F(key, "judgements", "image", null, label, "skin.f.hitTip", { part })),
];

export const GROUPS = [
    { id: "general", label: "skin.g.general" },
    { id: "layout", label: "skin.g.layout" },
    { id: "behaviour", label: "skin.g.behaviour" },
    { id: "colours", label: "skin.g.colours" },
    { id: "columns", label: "skin.g.columns" },
    { id: "stage", label: "skin.g.stage" },
    { id: "judgements", label: "skin.g.judgements" },
];

export const fieldByKey = new Map([...GENERAL_FIELDS, ...MANIA_FIELDS].map((f) => [f.key.toLowerCase(), f]));

// osu!'s own file names for what a 4K skin does not name (columns 1-2-2-1: note1, note2, note2, note1).
const COLUMN_KIND = [1, 2, 2, 1];
export function defaultImage(part, column = 0) {
    const k = COLUMN_KIND[column] ?? 1;
    switch (part) {
    case "key": return `mania-key${k}`;
    case "keyD": return `mania-key${k}D`;
    case "note": return `mania-note${k}`;
    case "head": return `mania-note${k}H`;
    case "body": return `mania-note${k}L`;
    case "tail": return `mania-note${k}T`;
    case "stageLeft": return "mania-stage-left";
    case "stageRight": return "mania-stage-right";
    case "stageBottom": return "mania-stage-bottom";
    case "stageHint": return "mania-stage-hint";
    case "stageLight": return "mania-stage-light";
    case "lightingN": return "lightingN";
    case "lightingL": return "lightingL";
    case "warningArrow": return "mania-warningarrow";
    default: return /^hit(\d+g?)$/.test(part) ? `mania-${part}` : null;
    }
}

const num = (v) => {
    const s = String(v ?? "").trim();
    const n = s ? Number(s) : NaN;
    return Number.isFinite(n) ? n : null;
};

// "1,2,3" → [1,2,3] of length n: a short list repeats its last value (as osu! does), a bad one gives null.
export function readList(value, n) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const parts = String(value).split(",").map(num);
    if (!parts.length || parts.some((p) => p === null)) return null;
    return Array.from({ length: n }, (_, i) => parts[Math.min(i, parts.length - 1)]);
}

// "r,g,b[,a]" → [r, g, b, a] (0–255), or null.
export function readColour(value) {
    const parts = String(value ?? "").split(",").map((p) => num(p));
    if (parts.length < 3 || parts.slice(0, 4).some((p) => p === null)) return null;
    const c = parts.slice(0, 4).map((p) => Math.max(0, Math.min(255, Math.round(p))));
    return [c[0], c[1], c[2], c.length > 3 ? c[3] : 255];
}

export const writeColour = ([r, g, b, a = 255], withAlpha = true) => (withAlpha ? `${r},${g},${b},${a}` : `${r},${g},${b}`);
export const toHex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
export function fromHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
    if (!m) return null;
    const v = Number.parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
}

// A field's value from the section's pairs (Map from pairsOf), with osu!'s default when it is unset or unreadable.
export function fieldValue(field, pairs) {
    const raw = pairs.get(field.key.toLowerCase())?.value ?? null;
    switch (field.type) {
    case "int":
    case "float": {
        const n = num(raw);
        return n === null ? field.def : field.type === "int" ? Math.round(n) : n;
    }
    case "list": return readList(raw, field.n) ?? (field.def === null ? null : Array(field.n).fill(field.def));
    case "bool": return raw === null || num(raw) === null ? field.def : num(raw) ? 1 : 0;
    case "enum": {
        const n = num(raw);
        if (field.key === "ComboBurstStyle" && raw !== null && n === null) {
            const word = { left: 0, right: 1, both: 2 }[String(raw).trim().toLowerCase()];
            return word ?? field.def;
        }
        return n !== null && field.options.some((o) => o.value === n) ? n : field.def;
    }
    case "rgb":
    case "rgba": return readColour(raw) ?? readColour(field.def);
    case "image": return raw ? raw.trim() : null;
    default: return raw ?? field.def ?? "";
    }
}

// A field value back to skin.ini text (null: remove the key).
export function fieldText(field, value) {
    if (value === null || value === undefined) return null;
    switch (field.type) {
    case "int": return String(Math.round(Number(value)));
    case "float": return String(Math.round(Number(value) * 100) / 100);
    case "list": return value.map((v) => String(Math.round(Number(v) * 100) / 100)).join(",");
    case "bool": return value ? "1" : "0";
    case "enum": return String(value);
    case "rgb": return writeColour(value, false);
    case "rgba": return writeColour(value, true);
    default: return String(value);
    }
}

// Everything the preview and the converters need of a 4K section: numbers with defaults applied, colours as
// [r,g,b,a], and for every image part the file name it will load (its own or osu!'s default).
export function maniaConfig(pairs) {
    const v = (key) => fieldValue(fieldByKey.get(key.toLowerCase()), pairs);
    const cfg = {
        columnStart: v("ColumnStart"), columnRight: v("ColumnRight"),
        columnWidth: v("ColumnWidth"), columnSpacing: v("ColumnSpacing"), columnLineWidth: v("ColumnLineWidth"),
        hitPosition: v("HitPosition"), lightPosition: v("LightPosition"), scorePosition: v("ScorePosition"),
        comboPosition: v("ComboPosition"), barlineHeight: v("BarlineHeight"),
        widthForNoteHeightScale: v("WidthForNoteHeightScale"),
        lightingNWidth: v("LightingNWidth"), lightingLWidth: v("LightingLWidth"),
        upsideDown: v("UpsideDown"), keysUnderNotes: v("KeysUnderNotes"), judgementLine: v("JudgementLine"),
        noteBodyStyle: v("NoteBodyStyle"), specialStyle: v("SpecialStyle"),
        keyFlip: v("KeyFlipWhenUpsideDown"), noteFlip: v("NoteFlipWhenUpsideDown"),
        colours: [1, 2, 3, 4].map((c) => v(`Colour${c}`)),
        lights: [1, 2, 3, 4].map((c) => v(`ColourLight${c}`)),
        columnLine: v("ColourColumnLine"), judgementLineColour: v("ColourJudgementLine"),
        hold: v("ColourHold"), breakColour: v("ColourBreak"),
        // per-column NoteBodyStyle# overrides the section's
        bodyStyles: [0, 1, 2, 3].map((c) => {
            const n = num(pairs.get(`notebodystyle${c}`)?.value);
            return n !== null && n >= 0 && n <= 2 ? n : null;
        }),
        images: {},
    };
    cfg.bodyStyles = cfg.bodyStyles.map((s) => s ?? cfg.noteBodyStyle);
    for (const field of MANIA_FIELDS) {
        if (field.type !== "image") continue;
        const own = fieldValue(field, pairs);
        cfg.images[field.key] = own ?? defaultImage(field.part, field.column);
    }
    // a hold head whose file is not there is drawn as the note, a missing tail as the head
    cfg.fallback = {};
    for (let c = 0; c < KEYS; c += 1) {
        cfg.fallback[`NoteImage${c}H`] = `NoteImage${c}`;
        cfg.fallback[`NoteImage${c}T`] = `NoteImage${c}H`;
    }
    return cfg;
}

// Image file names a skin's value can mean, best first: "x@2x.png", "x.png", "x@2x.jpg", "x.jpg" (a value with its own
// extension is tried as given too). Slashes either way.
export function imageCandidates(value) {
    const base = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!base) return [];
    const m = /\.(png|jpe?g)$/i.exec(base);
    const stem = m ? base.slice(0, -m[0].length) : base;
    return [`${stem}@2x.png`, `${stem}.png`, `${stem}@2x.jpg`, `${stem}.jpg`, ...(m ? [base] : [])];
}
