// "Метаданные" and "Сохранение" groups of the create tab (mapgen v3, stream C): the set's metadata (filled from the
// song's own tags only where still empty), its background, the song-select preview point, rate versions, and saving
// the chosen difficulties as one .osz. The window sends store ids and settings only; main writes the file (export-set).
// initExportPanel({ root, metaRoot, player, getSelection }) → { onSongLoaded(song), onSelectionChanged() }
// getSelection() → { song, diffs: [{ id, version, range, result, reachable }] } (the chosen variant per difficulty).
import { pickPreviewMs } from "../../src/gen/previewPoint.js";
import { rateText } from "../../src/rate/rateMap.js";
import { t } from "../../src/i18n/i18n.js";

export const RATE_CHOICES = [1.1, 1.2];
const LISTEN_SEC = 10;
const IMAGE_FILE = /\.(jpe?g|png)$/i;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const META_FIELDS = [
    { key: "artist", label: "create.meta.artist" },
    { key: "title", label: "create.meta.title" },
    { key: "creator", label: "create.meta.creator" },
    { key: "source", label: "create.meta.source" },
    { key: "tags", label: "create.meta.tags" },
];
const BACKGROUNDS = [
    { mode: "none", label: "create.bg.none" },
    { mode: "image", label: "create.bg.image" },
    { mode: "danCourse", label: "create.bg.danCourse" },
];

// 83500 → "1:23.5"
export function formatPreview(ms) {
    const tenths = Math.round(Math.max(0, Number(ms) || 0) / 100);
    return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

// "1:23.5", "83.5", "0:05,25" → ms; anything else → null
export function parsePreview(text) {
    const s = String(text ?? "").trim().replace(",", ".");
    const clock = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    if (clock) return Number(clock[2]) < 60 ? Math.round(Number(clock[1]) * 60000 + Number(clock[2]) * 1000) : null;
    return /^\d+(?:\.\d+)?$/.test(s) ? Math.round(Number(s) * 1000) : null;
}

// the ticked rates plus a custom one (0.5–2, not 1) → sorted, without repeats; bad: the custom one is unusable
export function ratesFrom({ picked = [], custom = "" }) {
    const round = (r) => Math.round(r * 100) / 100;
    const rates = new Set(picked.map(round));
    const raw = String(custom ?? "").trim().replace(",", ".");
    let bad = false;
    if (raw) {
        const r = Number(raw);
        if (Number.isFinite(r) && r >= 0.5 && r <= 2 && Math.abs(r - 1) > 1e-9) rates.add(round(r));
        else bad = true;
    }
    return { rates: [...rates].sort((a, b) => a - b), bad };
}

// the button says how many difficulties the file will hold
export const saveLabel = (diffs, rates) => (diffs <= 1 && rates === 0 ? t("create.save.one") : t("create.save.set", { n: diffs * (1 + rates) }));

function make(tag, { id, className, text, title, type } = {}) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (title) node.title = title;
    if (type) node.type = type;
    return node;
}

export function initExportPanel({ root, metaRoot, player = null, getSelection = () => null }) {
    const state = {
        song: null,
        filledBy: {}, // field → "song" | "tags" while the text is ours, not the user's
        previewMs: null, previewAuto: true, previewBad: false,
        bgMode: "none", imagePath: null,
        picked: new Set(), custom: "", pitch: false,
        last: null, // { key, file } of the last save
        saving: false,
    };
    let tagsToken = 0;

    // ---- metadata, background, preview ----
    const metaBox = make("div", { className: "exp-meta" });
    const inputs = {};
    for (const f of META_FIELDS) {
        const row = make("label", { className: "exp-field" });
        const input = make("input", { id: `exp-meta-${f.key}`, type: "text" });
        input.addEventListener("input", () => {
            state.filledBy[f.key] = null;
            refresh();
        });
        inputs[f.key] = input;
        row.append(make("span", { text: t(f.label) }), input);
        metaBox.append(row);
    }
    const note = make("div", { id: "exp-meta-note", className: "muted" });
    metaBox.append(note);

    const bgRow = make("div", { className: "exp-bg-row" });
    const chips = make("div", { id: "exp-bg", className: "chips" });
    for (const b of BACKGROUNDS) {
        const chip = make("span", { text: t(b.label) });
        chip.dataset.mode = b.mode;
        chip.addEventListener("click", () => {
            state.bgMode = b.mode;
            refresh();
        });
        chips.append(chip);
    }
    const pick = make("label", { className: "link" });
    const file = make("input", { id: "exp-bg-file", type: "file" });
    file.accept = ".jpg,.jpeg,.png";
    file.hidden = true;
    file.addEventListener("change", (e) => pickImage(e.target?.files?.[0]));
    pick.append(make("span", { text: t("create.bg.pick") }), file);
    const thumb = make("img", { id: "exp-bg-thumb", className: "exp-thumb" });
    thumb.hidden = true;
    bgRow.append(make("span", { className: "muted", text: t("create.bg.title") }), chips, pick, thumb);

    const previewRow = make("div", { className: "row exp-preview-row" });
    const previewInput = make("input", { id: "exp-preview", type: "text", title: t("create.previewAt.hint") });
    previewInput.addEventListener("input", () => {
        const ms = parsePreview(previewInput.value);
        state.previewAuto = false;
        state.previewBad = ms === null;
        if (ms !== null) state.previewMs = ms;
        refresh();
    });
    // emptied and left: back to the automatic point
    previewInput.addEventListener("change", () => {
        if (previewInput.value.trim()) return;
        state.previewAuto = true;
        state.previewBad = false;
        autoPreview();
        refresh();
    });
    const previewField = make("label", { className: "field" });
    previewField.append(make("span", { text: `${t("create.previewAt.label")} ` }), previewInput);
    const listen = make("button", { id: "exp-listen", className: "small", text: t("create.previewAt.listen") });
    listen.disabled = !player?.playFrom;
    listen.addEventListener("click", () => {
        if (state.previewBad || !Number.isFinite(state.previewMs)) return status(t("create.previewAt.hint"));
        player?.playFrom?.(state.previewMs / 1000, LISTEN_SEC);
    });
    const previewNote = make("span", { id: "exp-preview-note", className: "muted" });
    previewRow.append(previewField, listen, previewNote);
    metaBox.append(bgRow, previewRow);
    metaRoot?.append(metaBox);

    // ---- rate versions, saving, the result ----
    const saveBox = make("div", { className: "exp-save" });
    const ratesRow = make("div", { className: "row exp-rates" });
    ratesRow.append(make("span", { className: "muted", text: t("create.rates.title") }));
    for (const rate of RATE_CHOICES) {
        const label = make("label", { className: "exp-check" });
        const box = make("input", { id: `exp-rate-${rate}`, type: "checkbox" });
        box.addEventListener("change", () => {
            if (box.checked) state.picked.add(rate);
            else state.picked.delete(rate);
            refresh();
        });
        label.append(box, make("span", { text: `${rateText(rate)}x` }));
        ratesRow.append(label);
    }
    const customLabel = make("label", { className: "field exp-custom" });
    const custom = make("input", { id: "exp-rate-custom", type: "number" });
    Object.assign(custom, { min: "0.5", max: "2", step: "0.05", placeholder: "1.35" });
    custom.addEventListener("input", () => {
        state.custom = custom.value;
        refresh();
    });
    customLabel.append(make("span", { text: `${t("create.rates.custom")} ` }), custom, make("span", { text: "x" }));
    const ncLabel = make("label", { className: "exp-check" });
    const nightcore = make("input", { id: "exp-nightcore", type: "checkbox" });
    nightcore.addEventListener("change", () => {
        state.pitch = Boolean(nightcore.checked);
        refresh();
    });
    ncLabel.append(nightcore, make("span", { text: t("create.rates.nightcore") }));
    ratesRow.append(customLabel, ncLabel);

    const saveButton = make("button", { id: "exp-save", className: "primary", text: t("create.save.one") });
    saveButton.addEventListener("click", () => save());
    // osu!'s ranking criteria want hit objects and timing made by hand, so generated maps are for practice
    const rulesNote = make("div", { id: "exp-ai-note", className: "muted", text: t("create.save.aiNote") });
    const statusLine = make("div", { id: "exp-status", className: "muted" });
    const result = make("div", { id: "exp-result", className: "result" });
    result.hidden = true;
    const lines = make("div", { className: "exp-lines" });
    const links = make("div", { className: "links" });
    const openButton = make("button", { id: "exp-open", className: "small", text: t("create.save.open") });
    openButton.addEventListener("click", () => open());
    const showButton = make("button", { id: "exp-show", className: "small", text: t("create.save.show") });
    showButton.addEventListener("click", () => { if (state.last) window.danApi.showMap(state.last.file); });
    links.append(openButton, showButton);
    result.append(lines, links);
    saveBox.append(ratesRow, saveButton, rulesNote, statusLine, result);
    root?.append(saveBox);

    function status(text) {
        statusLine.textContent = text;
    }

    function autoPreview() {
        const song = state.song;
        state.previewMs = song?.envelope && song.durationMs > 0
            ? pickPreviewMs(song.envelope, { timing: song.timing, durationMs: song.durationMs, parts: song.parts ?? [] })
            : null;
    }

    function pickImage(chosen) {
        if (!chosen) return;
        const path = IMAGE_FILE.test(chosen.name ?? "") && !(chosen.size > MAX_IMAGE_BYTES) ? window.danApi.pathForFile?.(chosen) : null;
        if (!path) return status(t("app.export.badImage"));
        state.imagePath = path;
        if (state.bgMode === "none") state.bgMode = "image";
        status("");
        if (typeof FileReader !== "undefined") {
            const reader = new FileReader();
            reader.onload = () => {
                thumb.src = String(reader.result);
                thumb.hidden = false;
            };
            reader.readAsDataURL(chosen);
        }
        refresh();
    }

    function refresh() {
        const diffs = getSelection()?.diffs ?? [];
        const { rates } = ratesFrom({ picked: [...state.picked], custom: state.custom });
        saveButton.textContent = saveLabel(Math.max(1, diffs.length), rates.length);
        saveButton.disabled = !diffs.length || state.saving;
        for (const chip of chips.children) chip.className = chip.dataset.mode === state.bgMode ? "sel" : "";
        if (state.previewAuto) previewInput.value = Number.isFinite(state.previewMs) ? formatPreview(state.previewMs) : "";
        previewNote.textContent = state.song ? t(state.previewAuto ? "create.previewAt.auto" : "create.previewAt.manual") : "";
    }

    // the export-set request for what the panel shows now, or { error }
    function request() {
        const diffs = getSelection()?.diffs ?? [];
        if (!diffs.length) return { error: t("create.save.nothing") };
        if (state.previewBad) return { error: t("create.previewAt.hint") };
        const { rates, bad } = ratesFrom({ picked: [...state.picked], custom: state.custom });
        if (bad) return { error: t("app.export.badRate") };
        if (state.bgMode === "image" && !state.imagePath) return { error: t("create.bg.needImage") };
        const meta = Object.fromEntries(META_FIELDS.map((f) => [f.key, inputs[f.key].value.trim()]));
        const background = state.bgMode === "none" ? { mode: "none" } : { mode: state.bgMode, ...(state.imagePath ? { imagePath: state.imagePath } : {}) };
        return {
            request: {
                ids: diffs.map((d) => d.id), meta,
                previewMs: Number.isFinite(state.previewMs) ? Math.round(state.previewMs) : null,
                background, rates, pitch: state.pitch,
            },
        };
    }

    function showResult(answer) {
        const rows = [make("div", { className: "ok", text: t("create.save.done", { file: answer.file }) })];
        for (const e of answer.entries ?? []) {
            if (e.rate === 1) continue;
            rows.push(make("div", {
                className: "muted",
                text: t("create.save.rateRow", { rate: rateText(e.rate), label: e.label ?? "—", numeric: Number.isFinite(e.numeric) ? e.numeric.toFixed(1) : "—" }),
            }));
        }
        lines.replaceChildren(...rows);
        result.hidden = false;
    }

    async function save() {
        const built = request();
        if (built.error) {
            status(built.error);
            return null;
        }
        const req = built.request;
        state.saving = true;
        refresh();
        status(req.rates.length ? t("create.rates.preparing", { rate: req.rates.map(rateText).join("x, ") }) : t("create.save.saving"));
        try {
            const answer = await window.danApi.exportSet(req);
            if (!answer?.ok) {
                status(t("create.save.failed", { message: answer?.message ?? "?" }));
                return null;
            }
            state.last = { key: JSON.stringify(req), file: answer.file };
            status("");
            showResult(answer);
            return answer.file;
        } catch (error) {
            status(t("create.save.failed", { message: error?.message ?? String(error) }));
            return null;
        } finally {
            state.saving = false;
            refresh();
        }
    }

    // opens the last file, saving again first when anything changed since
    async function open() {
        const built = request();
        const unchanged = state.last && built.request && JSON.stringify(built.request) === state.last.key;
        const file = unchanged ? state.last.file : await save();
        if (file) await window.danApi.openMap(file);
    }

    refresh();
    return {
        onSongLoaded(song) {
            if (!song) return;
            const same = Boolean(state.song && state.song.path === song.path);
            state.song = song ?? null;
            if (metaRoot) metaRoot.hidden = false;
            if (root) root.hidden = false;
            if (!same) {
                for (const f of META_FIELDS) {
                    if (state.filledBy[f.key]) inputs[f.key].value = "";
                    state.filledBy[f.key] = null;
                }
                note.textContent = "";
                state.previewAuto = true;
                state.previewBad = false;
            }
            if (!inputs.title.value.trim() && song?.title) {
                inputs.title.value = song.title;
                state.filledBy.title = "song";
            }
            if (state.previewAuto) autoPreview();
            refresh();
            if (!song?.path || !window.danApi.songTags) return;
            const token = ++tagsToken;
            Promise.resolve(window.danApi.songTags(song.path)).then((answer) => {
                if (token !== tagsToken || !answer?.ok) return;
                let used = false;
                for (const key of ["artist", "title"]) {
                    const value = String(answer[key] ?? "").trim();
                    if (!value || (inputs[key].value.trim() && state.filledBy[key] !== "song")) continue;
                    inputs[key].value = value;
                    state.filledBy[key] = "tags";
                    used = true;
                }
                if (used) note.textContent = t("create.meta.fromTags");
                refresh();
            }, () => {});
        },
        onSelectionChanged() {
            refresh();
        },
    };
}
