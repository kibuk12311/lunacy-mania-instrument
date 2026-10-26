// The «Скин» tab: open an osu! skin (from osu!'s Skins folder, an .osk / .zip, or made from scratch by the
// builder), edit its osu!mania 4K part ([Mania] Keys: 4 of skin.ini) with a live preview, undo / redo, redraw parts
// with the builder, and export: an .osk for osu! stable and lazer, a folder copy, and — for a skin made here — an
// Interlude skin (.isk). Main keeps the working copy (app/skinIpc.js); this side holds the skin.ini text.
import { t } from "../../src/i18n/i18n.js";
import { parseSkinIni, pairsOf, findSection, patchSkinIni } from "../../src/skin/skinIni.js";
import { GROUPS, GENERAL_FIELDS, MANIA_FIELDS, fieldValue, fieldText, maniaConfig, toHex, fromHex, KEYS } from "../../src/skin/maniaFields.js";
import {
    DEFAULT_OPTIONS, PALETTES, PATTERNS, SHAPES, FONTS, HOLD_STYLES, KEY_STYLES, STAGE_STYLES, JUDGEMENT_STYLES, PARTS,
    normalizeOptions, patternColours,
} from "../../src/skin/options.js";
import { createHistory } from "../../src/skin/history.js";
import { createSkinPreview } from "./skinPreview.js";
import { pictureToPngs, ACCEPT } from "./skinPictures.js";

const SOURCE_KEY = "skin-source";
const BUILDER_KEY = "skin-builder";
const SAVE_MS = 400;

// texts of the builder's choices
const CHOICE_TEXT = {
    shape: { circle: "skin.b.shapeCircle", bar: "skin.b.shapeBar", arrow: "skin.b.shapeArrow", diamond: "skin.b.shapeDiamond" },
    theme: { dark: "skin.b.themeDark", light: "skin.b.themeLight" },
    pattern: { 1221: "skin.b.pattern1221", 1212: "skin.b.pattern1212", 1111: "skin.b.pattern1111", 1234: "skin.b.pattern1234" },
    holdStyle: { solid: "skin.b.holdSolid", stripes: "skin.b.holdStripes", fade: "skin.b.holdFade" },
    keyStyle: { plain: "skin.b.keyPlain", ring: "skin.b.keyRing", glow: "skin.b.keyGlow" },
    stage: { plain: "skin.b.stagePlain", lines: "skin.b.stageLines", glow: "skin.b.stageGlow" },
    judgements: { numbers: "skin.b.judgeNumbers", words: "skin.b.judgeWords" },
    font: { round: "skin.b.fontRound", thin: "skin.b.fontThin", pixel: "skin.b.fontPixel" },
};
const PALETTE_TEXT = { lunacy: "skin.b.paletteLunacy", ice: "skin.b.paletteIce", sakura: "skin.b.paletteSakura", lime: "skin.b.paletteLime", sunset: "skin.b.paletteSunset", mono: "skin.b.paletteMono" };
const PART_TEXT = { layout: "skin.part.layout", notes: "skin.part.notes", holds: "skin.part.holds", keys: "skin.part.keys", stage: "skin.part.stage", lighting: "skin.part.lighting", judgements: "skin.part.judgements" };
const ORIGIN_TEXT = { osu: "skin.origin.osu", archive: "skin.origin.archive", template: "skin.origin.template" };
const PART_ROWS = [
    ["note", "skin.col.note"], ["head", "skin.col.head"], ["body", "skin.col.body"], ["tail", "skin.col.tail"], ["key", "skin.col.key"], ["keyD", "skin.col.keyD"],
];

const el = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
};
const button = (text, className = "small", onClick = null) => {
    const b = el("button", className, text);
    if (onClick) b.addEventListener("click", onClick);
    return b;
};
function readJson(key, fallback) {
    try {
        const v = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null");
        return v ?? fallback;
    } catch {
        return fallback;
    }
}
function writeJson(key, value) {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
        // not remembered
    }
}

// A row of chips, one chosen: values with their text keys → the box; onPick(value).
function chips(values, textOf, chosen, onPick) {
    const box = el("div", "chips");
    const spans = values.map((v) => {
        const s = el("span", String(v) === String(chosen) ? "sel" : "", t(textOf(v)));
        s.dataset.value = String(v);
        s.addEventListener("click", () => {
            for (const other of spans) other.className = other === s ? "sel" : "";
            onPick(v);
        });
        return s;
    });
    box.replaceChildren(...spans);
    return box;
}

function slider(label, { min, max, step = 1, value, unit = "" }, onInput, onChange = onInput) {
    const row = el("label", "slider-row");
    const input = el("input");
    Object.assign(input, { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
    const out = el("span", "muted", `${value}${unit}`);
    input.addEventListener("input", () => { out.textContent = `${input.value}${unit}`; onInput(Number(input.value)); });
    input.addEventListener("change", () => onChange(Number(input.value)));
    row.append(el("span", "", label), input, out);
    return row;
}

// The builder's form: every choice, the column colours with their presets. → { node, get options() }
export function builderForm(start, onChange = () => {}, { withNames = false } = {}) {
    let o = normalizeOptions(start ?? {});
    const node = el("div", "sk-builder");
    const changed = () => { o = normalizeOptions(o); onChange(o); };
    const set = (key) => (v) => { o = { ...o, [key]: v }; changed(); };
    const section = (label, ...kids) => {
        const g = el("div", "group");
        g.append(el("div", "flabel", label), ...kids);
        return g;
    };
    const colourRow = el("div", "row sk-colours");
    const drawColours = () => {
        colourRow.replaceChildren(...o.colours.map((hex, c) => {
            const input = el("input", "sk-colour");
            input.type = "color";
            input.value = hex;
            input.title = t("skin.b.columnColour", { n: c + 1 });
            input.addEventListener("change", () => {
                const colours = [...o.colours];
                colours[c] = input.value;
                o = { ...o, colours };
                changed();
            });
            return input;
        }));
    };
    const presetColours = () => { o = { ...o, colours: patternColours(o.palette, o.pattern) }; drawColours(); changed(); };
    const palette = el("select");
    palette.replaceChildren(...Object.keys(PALETTES).map((id) => {
        const opt = el("option", "", t(PALETTE_TEXT[id]));
        opt.value = id;
        opt.selected = id === o.palette;
        return opt;
    }));
    palette.value = o.palette;
    palette.addEventListener("change", () => { o = { ...o, palette: palette.value }; presetColours(); });
    drawColours();
    const kids = [];
    if (withNames) {
        const name = el("input", "rec-input");
        Object.assign(name, { type: "text", maxLength: 64, value: o.name, spellcheck: false });
        name.addEventListener("change", () => set("name")(name.value));
        const author = el("input", "rec-input");
        Object.assign(author, { type: "text", maxLength: 64, value: o.author, spellcheck: false });
        author.title = t("skin.f.authorTip");
        author.addEventListener("change", () => set("author")(author.value));
        const names = el("div", "row");
        const nameField = el("label", "field wide sk-text");
        nameField.append(el("span", "", t("skin.f.name")), name);
        const authorField = el("label", "field wide sk-text");
        authorField.append(el("span", "", t("skin.f.author")), author);
        names.append(nameField, authorField);
        kids.push(names);
    }
    kids.push(
        section(t("skin.b.shape"), chips(SHAPES, (v) => CHOICE_TEXT.shape[v], o.shape, set("shape"))),
        section(t("skin.b.colours"),
            chips(PATTERNS, (v) => CHOICE_TEXT.pattern[v], o.pattern, (v) => { o = { ...o, pattern: v }; presetColours(); }),
            (() => { const r = el("div", "row"); r.append(el("span", "muted", t("skin.b.palette")), palette); return r; })(),
            colourRow,
            chips(["dark", "light"], (v) => CHOICE_TEXT.theme[v], o.theme, set("theme"))),
        section(t("skin.b.sizes"),
            slider(t("skin.b.columnWidth"), { min: 30, max: 100, value: o.columnWidth }, () => {}, set("columnWidth")),
            slider(t("skin.b.noteSize"), { min: 50, max: 100, value: o.noteSize, unit: "%" }, () => {}, set("noteSize")),
            slider(t("skin.b.hitPosition"), { min: 300, max: 470, value: o.hitPosition }, () => {}, set("hitPosition"))),
        section(t("skin.b.holds"),
            chips(HOLD_STYLES, (v) => CHOICE_TEXT.holdStyle[v], o.holdStyle, set("holdStyle")),
            chips([0, 1, 2], (v) => ["skin.opt.bodyStretch", "skin.opt.bodyRepeatTop", "skin.opt.bodyRepeatBottom"][v], o.bodyStyle, set("bodyStyle"))),
        section(t("skin.b.keys"), chips(KEY_STYLES, (v) => CHOICE_TEXT.keyStyle[v], o.keyStyle, set("keyStyle"))),
        section(t("skin.b.stage"), chips(STAGE_STYLES, (v) => CHOICE_TEXT.stage[v], o.stage, set("stage"))),
        section(t("skin.b.judgements"),
            chips(JUDGEMENT_STYLES, (v) => CHOICE_TEXT.judgements[v], o.judgements, set("judgements")),
            chips(FONTS, (v) => CHOICE_TEXT.font[v], o.font, set("font"))),
    );
    const lighting = el("label", "check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = o.lighting;
    box.addEventListener("change", () => set("lighting")(Boolean(box.checked)));
    lighting.append(box, el("span", "", t("skin.b.lighting")));
    kids.push(lighting);
    node.replaceChildren(...kids);
    return { node, get options() { return o; } };
}

export function initSkinTab() {
    const api = window.danApi;
    const $ = (id) => document.getElementById(id);
    const status = $("sk-status");
    const result = $("sk-result");
    let source = readJson(SOURCE_KEY, "new");
    if (!["osu", "file", "new"].includes(source)) source = "new";
    let builderOptions = normalizeOptions(readJson(BUILDER_KEY, DEFAULT_OPTIONS));
    let session = null; // { id, name, origin, interlude, builder }
    const history = createHistory("");
    let pictures = {}; // value → { img, hd } | null
    let saveTimer = null;
    let busy = false;
    const preview = createSkinPreview({ canvas: $("sk-preview"), controls: $("sk-preview-controls") });

    const say = (text, kind = "") => {
        status.textContent = text;
        status.className = `muted sk-status${kind ? ` ${kind}` : ""}`;
    };
    const failText = (r) => t("skin.failed", { message: r?.message ?? "?" });

    // ---- where a skin comes from ----
    const sourceBox = $("sk-source");
    const panes = { osu: $("sk-pane-osu"), file: $("sk-pane-file"), new: $("sk-pane-new") };
    const showSource = (s) => {
        source = s;
        writeJson(SOURCE_KEY, s);
        for (const [id, pane] of Object.entries(panes)) pane.hidden = id !== s;
        if (s === "osu") void loadOsuSkins();
    };
    sourceBox.replaceChildren(chips(["osu", "file", "new"], (v) => ({ osu: "skin.src.osu", file: "skin.src.file", new: "skin.src.new" })[v], source, showSource));

    const osuList = $("sk-osu-list");
    const osuNote = $("sk-osu-note");
    let osuLoaded = false;
    async function loadOsuSkins(force = false) {
        if (osuLoaded && !force) return;
        osuLoaded = true;
        osuNote.textContent = t("skin.osu.loading");
        const r = await api.skinList?.();
        if (!r?.ok) {
            osuNote.textContent = failText(r);
            return;
        }
        if (!r.folder) {
            osuList.replaceChildren();
            osuNote.textContent = t("skin.osu.noFolder");
            return;
        }
        osuList.replaceChildren(...r.skins.map((s) => {
            const opt = el("option", "", s.mania4 ? s.name : `${s.name} ${t("skin.osu.no4k")}`);
            opt.value = s.folder;
            return opt;
        }));
        osuNote.textContent = r.skins.length ? t("skin.osu.folder", { folder: r.folder, n: r.skins.length }) : t("skin.osu.empty", { folder: r.folder });
    }
    $("sk-osu-refresh").addEventListener("click", () => void loadOsuSkins(true));
    $("sk-open").addEventListener("click", () => {
        if (osuList.value) void begin(() => api.skinOpen({ folder: osuList.value }), t("skin.opening"));
    });
    $("sk-import").addEventListener("click", () => void begin(() => api.skinImport({}), t("skin.importing")));
    // an .osk dropped on the file pane
    const drop = panes.file;
    drop.addEventListener("dragover", (e) => { e.preventDefault?.(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
        e.preventDefault?.();
        drop.classList.remove("over");
        const file = e.dataTransfer?.files?.[0];
        const where = file ? api.pathForFile?.(file) : null;
        if (where) void begin(() => api.skinImport({ file: where }), t("skin.importing"));
    });

    const newForm = builderForm(builderOptions, (o) => { builderOptions = o; writeJson(BUILDER_KEY, o); }, { withNames: true });
    $("sk-builder-new").replaceChildren(newForm.node);
    $("sk-create").addEventListener("click", () => void begin(() => api.skinCreate({ options: newForm.options }), t("skin.creating")));

    async function showRecent() {
        const r = await api.skinRecent?.();
        const box = $("sk-recent");
        if (!r?.ok || !r.items?.length) {
            box.replaceChildren();
            return;
        }
        box.replaceChildren(el("div", "flabel", t("skin.recent")), ...r.items.map((item) => {
            const row = el("div", "sk-recent-row");
            const b = button(item.name, "small sk-recent-open", () => void begin(() => api.skinReopen({ id: item.id }), t("skin.opening")));
            b.title = item.source ? `${t(ORIGIN_TEXT[item.origin] ?? "skin.origin.osu")}: ${item.source}` : t(ORIGIN_TEXT[item.origin] ?? "skin.origin.template");
            row.append(b, el("span", "muted", t(ORIGIN_TEXT[item.origin] ?? "skin.origin.osu")));
            return row;
        }));
    }

    // ---- the open skin ----
    async function begin(call, doing) {
        if (busy) return;
        busy = true;
        say(doing);
        try {
            const r = await call();
            if (r?.cancelled) { say(""); return; }
            if (!r?.ok) { say(failText(r), "bad"); return; }
            await openSession(r);
            say(t("skin.opened", { name: r.name }), "ok");
        } finally {
            busy = false;
        }
    }

    let sessionBuilder = null;
    let baseline = new Map();
    let allColumns = readJson("skin-all-columns", false) === true;
    async function openSession(r) {
        session = { id: r.id, name: r.name, origin: r.origin, interlude: Boolean(r.interlude), builder: r.builder };
        // what «Сбросить» goes back to: the pictures the skin had when it was opened (or the builder last drew)
        baseline = new Map([...pairsOf(parseSkinIni(r.ini), { mania: 4 })].map(([k, v]) => [k, v.value]));
        history.reset(r.ini);
        pictures = {};
        $("sk-start").hidden = true;
        $("sk-session").hidden = false;
        result.hidden = true;
        $("sk-origin").textContent = t(ORIGIN_TEXT[r.origin] ?? "skin.origin.osu");
        $("sk-no4k").hidden = Boolean(r.mania4);
        $("sk-export-il").hidden = !session.interlude;
        $("sk-il-note").textContent = session.interlude ? t("skin.interlude.how") : t("skin.interlude.onlyBuilt");
        sessionBuilder = builderForm(r.builder ?? builderOptions, () => {});
        $("sk-builder").replaceChildren(sessionBuilder.node);
        drawParts();
        await refresh();
        preview.setVisible(!document.getElementById("skin-tab").hidden);
    }

    $("sk-close").addEventListener("click", () => {
        flushSave();
        session = null;
        $("sk-session").hidden = true;
        $("sk-start").hidden = false;
        preview.setVisible(false);
        say("");
        void showRecent();
    });

    // which parts the builder redraws on an opened skin (all of them on one made here)
    const partsBox = $("sk-parts");
    let parts = new Set(PARTS);
    function drawParts() {
        parts = new Set(session?.origin === "template" ? PARTS : ["notes", "holds", "keys"]);
        partsBox.replaceChildren(...PARTS.map((p) => {
            const label = el("label", "check");
            const box = el("input");
            box.type = "checkbox";
            box.checked = parts.has(p);
            box.addEventListener("change", () => { if (box.checked) parts.add(p); else parts.delete(p); });
            label.append(box, el("span", "", t(PART_TEXT[p])));
            return label;
        }));
    }
    $("sk-rebuild").addEventListener("click", async () => {
        if (!session || busy) return;
        busy = true;
        say(t("skin.building"));
        try {
            const r = await api.skinBuild({ id: session.id, options: sessionBuilder.options, parts: [...parts] });
            if (!r?.ok) { say(failText(r), "bad"); return; }
            const patch = { mania4: r.mania };
            if (Object.keys(r.general ?? {}).length) patch.General = r.general;
            session.builder = r.options;
            for (const [key, value] of Object.entries(r.mania)) baseline.set(key.toLowerCase(), value);
            commit(patchSkinIni(history.current, patch));
            say(t("skin.built", { n: r.files }), "ok");
        } finally {
            busy = false;
        }
    });

    // a new skin.ini text: one step of history (or merged with the last one of the same field), saved soon
    function commit(text, mergeKey = null) {
        if (!history.push(text, mergeKey)) return;
        scheduleSave();
        void refresh();
    }
    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, SAVE_MS);
    }
    function flushSave() {
        clearTimeout(saveTimer);
        saveTimer = null;
        if (session) void api.skinSave?.({ id: session.id, ini: history.current });
    }
    $("sk-undo").addEventListener("click", () => { history.undo(); scheduleSave(); void refresh(); });
    $("sk-redo").addEventListener("click", () => { history.redo(); scheduleSave(); void refresh(); });

    const doc = () => parseSkinIni(history.current);

    // the pictures a config needs, fetched once each
    async function loadPictures(cfg) {
        const wanted = [...new Set(Object.values(cfg.images))].filter((v) => v && !(v in pictures));
        if (!wanted.length || !session) return;
        const r = await api.skinImages?.({ id: session.id, values: wanted });
        const got = r?.images ?? {};
        await Promise.all(wanted.map((value) => new Promise((resolve) => {
            const info = got[value];
            if (!info?.url || typeof Image === "undefined") {
                pictures[value] = null;
                resolve();
                return;
            }
            const img = new Image();
            img.onload = () => { pictures[value] = { img, hd: info.hd, file: info.file }; resolve(); };
            img.onerror = () => { pictures[value] = null; resolve(); };
            img.src = info.url;
        })));
    }

    async function refresh() {
        if (!session) return;
        const d = doc();
        const pairs = pairsOf(d, { mania: 4 });
        const cfg = maniaConfig(pairs);
        $("sk-undo").disabled = !history.canUndo;
        $("sk-redo").disabled = !history.canRedo;
        const name = fieldValue(GENERAL_FIELDS[0], pairsOf(d, "General")) || session.name;
        $("sk-name").textContent = name;
        $("sk-no4k").hidden = Boolean(findSection(d, { mania: 4 }));
        drawEditor(d, pairs);
        await loadPictures(cfg);
        preview.setSkin(cfg, pictures);
        drawThumbs(cfg);
    }

    // ---- the editor ----
    const editor = $("sk-editor");
    const openGroups = new Set(readJson("skin-open-groups", ["layout"]));
    let thumbCells = [];
    function drawEditor(d, pairs) {
        const general = pairsOf(d, "General");
        const focused = document.activeElement;
        // a field being typed in or dragged stays as it is
        if (focused && editor.contains?.(focused) && focused.dataset?.live === "1") return;
        thumbCells = [];
        editor.replaceChildren(...GROUPS.map((g) => {
            const box = el("details", "sk-group");
            box.open = openGroups.has(g.id);
            box.addEventListener("toggle", () => {
                if (box.open) openGroups.add(g.id);
                else openGroups.delete(g.id);
                writeJson("skin-open-groups", [...openGroups]);
            });
            box.append(el("summary", "", t(g.label)));
            if (g.id === "general") for (const f of GENERAL_FIELDS) box.append(textRow(f, general));
            else if (g.id === "columns") box.append(columnImages(pairs));
            else box.append(...fieldRows(MANIA_FIELDS.filter((f) => f.group === g.id), pairs));
            return box;
        }));
    }

    const setField = (field, value, merge = true) => {
        const where = GENERAL_FIELDS.includes(field) ? "General" : "mania4";
        commit(patchSkinIni(history.current, { [where]: { [field.key]: value === null ? null : fieldText(field, value) } }), merge ? field.key : null);
    };
    const labelOf = (field, extra = "") => {
        const s = el("span", "sk-label", `${t(field.label, { n: (field.column ?? 0) + 1 })}${extra}`);
        s.title = t(field.tip);
        return s;
    };
    const unsetMark = (field, pairs) => (pairs.has(field.key.toLowerCase()) ? null : el("i", "sk-default", t("skin.default")));

    function textRow(field, pairs) {
        const row = el("label", "field wide sk-text");
        const input = el("input");
        Object.assign(input, { type: "text", maxLength: 80, value: fieldValue(field, pairs), spellcheck: false });
        input.title = t(field.tip);
        input.addEventListener("change", () => setField(field, input.value.trim() || null, false));
        row.append(labelOf(field), input);
        return row;
    }

    function numberInput(value, field, onValue) {
        const input = el("input", "sk-num");
        Object.assign(input, { type: "number", min: String(field.min), max: String(field.max), step: String(field.step ?? 1), value: String(value) });
        input.addEventListener("change", () => {
            const n = Number(input.value);
            if (Number.isFinite(n)) onValue(Math.max(field.min, Math.min(field.max, n)));
        });
        return input;
    }

    function fieldRows(fields, pairs) {
        const rows = [];
        const done = new Set();
        for (const field of fields) {
            if (done.has(field.key)) continue;
            // a field of each column (colours) in one row
            if (field.column !== undefined && (field.type === "rgb" || field.type === "rgba")) {
                const set = fields.filter((f) => f.label === field.label && f.column !== undefined);
                for (const f of set) done.add(f.key);
                const row = el("div", "sk-row");
                const pickers = el("div", "sk-pickers");
                pickers.append(...set.map((f) => colourPicker(f, pairs, t("skin.b.columnColour", { n: f.column + 1 }))));
                row.append(labelOf(field), pickers);
                rows.push(row);
                continue;
            }
            done.add(field.key);
            rows.push(fieldRow(field, pairs));
        }
        return rows;
    }

    function colourPicker(field, pairs, title) {
        const value = fieldValue(field, pairs);
        const wrap = el("span", "sk-picker");
        const input = el("input", "sk-colour");
        input.type = "color";
        input.value = toHex(value);
        input.title = `${title} — ${value.join(",")}`;
        const alpha = field.type === "rgba" ? el("input", "sk-alpha") : null;
        const apply = () => {
            const rgb = fromHex(input.value);
            if (!rgb) return;
            rgb[3] = alpha ? Math.round(Number(alpha.value)) : 255;
            setField(field, rgb, false);
        };
        input.addEventListener("change", apply);
        wrap.append(input);
        if (alpha) {
            Object.assign(alpha, { type: "range", min: "0", max: "255", step: "1", value: String(value[3]) });
            alpha.title = t("skin.alpha", { n: value[3] });
            alpha.addEventListener("change", apply);
            wrap.append(alpha);
        }
        return wrap;
    }

    function fieldRow(field, pairs) {
        const value = fieldValue(field, pairs);
        const row = el("div", "sk-row");
        const mark = unsetMark(field, pairs);
        // a value osu! leaves unset unless the skin gives one: "set" starts it from the column widths
        if (field.def === null && value === null && (field.type === "int" || field.type === "float" || field.type === "list")) {
            const widths = fieldValue(MANIA_FIELDS.find((f) => f.key === "ColumnWidth"), pairs);
            const start = field.type === "list" ? widths.slice(0, field.n) : widths[0];
            const controls = el("div", "sk-controls");
            controls.append(el("span", "muted", t("skin.unset")), button(t("skin.setValue"), "small", () => setField(field, start, false)));
            row.append(labelOf(field), controls);
            return row;
        }
        switch (field.type) {
        case "int":
        case "float": {
            const shown = value ?? field.min;
            const range = el("input", "sk-range");
            Object.assign(range, { type: "range", min: String(field.min), max: String(field.max), step: String(field.step ?? 1), value: String(shown) });
            range.dataset.live = "1";
            const num = numberInput(shown, field, (n) => setField(field, n));
            range.addEventListener("input", () => { num.value = range.value; setField(field, Number(range.value)); });
            range.addEventListener("change", () => { range.dataset.live = "0"; setField(field, Number(range.value)); });
            const controls = el("div", "sk-controls");
            controls.append(range, num);
            if (field.def === null && value !== null) controls.append(button("×", "small sk-reset", () => setField(field, null, false)));
            row.append(labelOf(field), controls);
            break;
        }
        case "list": {
            const values = value ?? Array(field.n).fill(field.min > 0 ? field.min : 0);
            const controls = el("div", "sk-controls");
            if (field.n === KEYS) {
                // one slider moves every column, the boxes set one each
                const all = el("input", "sk-range");
                Object.assign(all, { type: "range", min: String(field.min), max: String(field.max), step: String(field.step ?? 1), value: String(values[0]) });
                all.title = t("skin.allColumns");
                all.dataset.live = "1";
                all.addEventListener("input", () => setField(field, Array(field.n).fill(Number(all.value))));
                all.addEventListener("change", () => { all.dataset.live = "0"; setField(field, Array(field.n).fill(Number(all.value))); });
                controls.append(all);
            }
            const boxes = el("div", "sk-list");
            boxes.append(...values.map((v, i) => {
                const input = numberInput(v, field, (n) => {
                    const next = [...values];
                    next[i] = n;
                    setField(field, next, false);
                });
                input.title = t("skin.listItem", { n: i + 1 });
                return input;
            }));
            controls.append(boxes);
            if (field.def === null && value !== null) controls.append(button("×", "small sk-reset", () => setField(field, null, false)));
            row.append(labelOf(field), controls);
            break;
        }
        case "bool": {
            const label = el("label", "check");
            const box = el("input");
            box.type = "checkbox";
            box.checked = Boolean(value);
            box.addEventListener("change", () => setField(field, box.checked ? 1 : 0, false));
            label.append(box, labelOf(field));
            row.append(label);
            break;
        }
        case "enum": {
            const select = el("select");
            select.replaceChildren(...field.options.map((o) => {
                const opt = el("option", "", t(o.label));
                opt.value = String(o.value);
                opt.selected = o.value === value;
                return opt;
            }));
            select.value = String(value);
            select.addEventListener("change", () => setField(field, Number(select.value), false));
            row.append(labelOf(field), select);
            break;
        }
        case "rgb":
        case "rgba":
            row.append(labelOf(field), colourPicker(field, pairs, t(field.label)));
            break;
        case "image":
            row.append(labelOf(field), imageCell(field, pairs));
            break;
        default:
            break;
        }
        if (mark) row.append(mark);
        return row;
    }

    // one picture of the skin: its thumbnail (click: a picture from your files), × back to osu!'s default
    // one picture of the skin: its thumbnail (a click or a dropped file: the user's own picture), «Своя картинка…»
    // where there is room, and «Сбросить» back to what it was when the skin was opened
    function imageCell(field, pairs, { compact = false } = {}) {
        const cell = el("span", compact ? "sk-thumb-cell" : "sk-thumb-cell wide");
        const thumb = el("button", "sk-thumb");
        thumb.title = t("skin.pic.hint");
        thumb.dataset.key = field.key;
        thumb.addEventListener("click", () => pick(field));
        thumb.addEventListener("dragover", (e) => { e.preventDefault?.(); thumb.classList.add("over"); });
        thumb.addEventListener("dragleave", () => thumb.classList.remove("over"));
        thumb.addEventListener("drop", (e) => {
            e.preventDefault?.();
            e.stopPropagation?.();
            thumb.classList.remove("over");
            const file = e.dataTransfer?.files?.[0];
            if (file) void replace(field, file);
        });
        cell.append(thumb);
        if (!compact) cell.append(button(t("skin.pic.own"), "small", () => pick(field)));
        const now = pairs.get(field.key.toLowerCase())?.value ?? null;
        const was = baseline.get(field.key.toLowerCase()) ?? null;
        if (now !== was) {
            const reset = button(compact ? "↺" : t("skin.pic.reset"), compact ? "small sk-reset" : "small", () => resetPicture(field));
            reset.title = t("skin.pic.resetTitle");
            cell.append(reset);
        }
        thumbCells.push({ field, thumb });
        return cell;
    }

    function columnImages(pairs) {
        const wrap = el("div", "group");
        const all = el("label", "check");
        const box = el("input");
        box.type = "checkbox";
        box.checked = allColumns;
        box.id = "sk-all-columns";
        box.addEventListener("change", () => { allColumns = Boolean(box.checked); writeJson("skin-all-columns", allColumns); });
        all.title = t("skin.pic.allColumnsTitle");
        all.append(box, el("span", "", t("skin.pic.allColumns")));
        const grid = el("div", "sk-cols");
        grid.append(el("span", ""), ...[0, 1, 2, 3].map((c) => el("span", "muted sk-col-head", String(c + 1))));
        for (const [part, label] of PART_ROWS) {
            const fields = MANIA_FIELDS.filter((f) => f.part === part);
            const name = el("span", "sk-label", t(label));
            name.title = t(fields[0].tip);
            grid.append(name, ...fields.map((f) => imageCell(f, pairs, { compact: true })));
        }
        wrap.append(all, grid, el("div", "muted", t("skin.pic.note")));
        return wrap;
    }

    function drawThumbs(cfg) {
        for (const { field, thumb } of thumbCells) {
            const value = cfg.images[field.key];
            const p = pictures[value];
            const img = p?.img;
            thumb.replaceChildren();
            thumb.title = `${value ?? ""}${p ? "" : ` — ${t("skin.missing")}`}\n${t("skin.pic.hint")}`;
            if (img) {
                const copy = el("img");
                copy.src = img.src;
                copy.alt = "";
                thumb.append(copy);
            } else thumb.append(el("span", "muted", "—"));
        }
    }

    // the file picker (one input for the tab: the picture goes to the field it was opened for)
    const fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = ACCEPT;
    fileInput.hidden = true;
    let pickFor = null;
    fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        const field = pickFor;
        fileInput.value = "";
        if (file && field) void replace(field, file);
    });
    $("skin-tab").append?.(fileInput);
    function pick(field) {
        pickFor = field;
        fileInput.click?.();
    }

    // the keys a picture goes to: the field, or that part of every column when «Применить ко всем колонкам» is on
    const keysFor = (field) => (allColumns && field.column !== undefined ? MANIA_FIELDS.filter((f) => f.part === field.part).map((f) => f.key) : [field.key]);

    async function replace(field, file) {
        if (!session || busy) return;
        busy = true;
        say(t("skin.pic.reading"));
        try {
            let pngs;
            try {
                pngs = await pictureToPngs(file);
            } catch (error) {
                say(t({ type: "skin.err.notImage", size: "skin.err.tooBig" }[error.code] ?? "skin.err.readPicture"), "bad");
                return;
            }
            const keys = keysFor(field);
            const r = await api.skinReplaceImage?.({ id: session.id, keys, png1x: pngs.png1x, png2x: pngs.png2x });
            if (!r?.ok) { say(failText(r), "bad"); return; }
            commit(patchSkinIni(history.current, { mania4: Object.fromEntries(r.keys.map((k) => [k, r.value])) }));
            const warn = (r.warnings ?? []).map((w) => t({ large: "skin.warn.large", notSquare: "skin.warn.notSquare" }[w] ?? "skin.warn.large", { w: r.width, h: r.height }));
            say([t("skin.replaced", { key: r.keys.join(", "), w: r.width, h: r.height }), ...warn].join(" "), warn.length ? "" : "ok");
        } finally {
            busy = false;
        }
    }

    function resetPicture(field) {
        const keys = keysFor(field);
        commit(patchSkinIni(history.current, { mania4: Object.fromEntries(keys.map((k) => [k, baseline.get(k.toLowerCase()) ?? null])) }));
        say(t("skin.pic.wasReset", { key: keys.join(", ") }), "ok");
    }

    // ---- export ----
    async function exportWith(call, done) {
        if (!session || busy) return;
        flushSave();
        busy = true;
        say(t("skin.exporting"));
        try {
            const r = await call();
            if (!r?.ok) { say(failText(r), "bad"); return; }
            say("");
            result.hidden = false;
            const where = r.file ?? r.dir;
            const links = el("div", "links");
            if (r.file) links.append(button(t("skin.show"), "small", () => void api.skinShow?.({ file: r.file })));
            result.replaceChildren(el("div", "ok", done(r)), el("div", "muted sk-path", where), links);
        } finally {
            busy = false;
        }
    }
    $("sk-export-osk").addEventListener("click", () => void exportWith(() => api.skinExportOsk({ id: session.id, ini: history.current }), (r) => t(r.opened ? "skin.osk.opened" : "skin.osk.saved", { n: r.files })));
    $("sk-save-copy").addEventListener("click", () => void exportWith(() => api.skinSaveCopy({ id: session.id, ini: history.current }), (r) => t("skin.copy.saved", { n: r.files })));
    $("sk-export-il").addEventListener("click", () => void exportWith(() => api.skinExportInterlude({ id: session.id, ini: history.current }), () => t("skin.interlude.saved")));

    window.addEventListener("tab-shown", (e) => {
        const on = e.detail === "skin";
        preview.setVisible(on && Boolean(session));
        if (on) {
            void showRecent();
            if (source === "osu") void loadOsuSkins();
        } else flushSave();
    });
    document.addEventListener?.("visibilitychange", () => preview.setVisible(!document.hidden && Boolean(session) && !document.getElementById("skin-tab").hidden));
    for (const [id, pane] of Object.entries(panes)) pane.hidden = id !== source;

    // the smoke drives the tab through these
    return {
        get session() { return session; },
        get ini() { return history.current; },
        preview,
        setField: (key, value) => {
            const field = [...GENERAL_FIELDS, ...MANIA_FIELDS].find((f) => f.key === key);
            if (field) setField(field, value, false);
        },
    };
}
