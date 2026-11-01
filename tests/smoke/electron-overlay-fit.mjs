// Run with: npx electron tests/smoke/electron-overlay-fit.mjs <out dir> [--full] [--real-only] — do the numbers on the
// overlay's widgets push anything around, and does everything fit? Real widget windows (widget.html with its real CSS,
// preload and modules; hidden, never on the screen, no osu!, no tosu): the rect of each graph and of each text while the
// numbers go through 0, 8, 12, 99, 123, 1234 (and 111, 777, 888, 1111: the digits of a font without tabular ones differ).
// Step one goes through the page's own paths (a config and snapshots over IPC, the window at its real size) for each
// widget and style. Step two (the sweep) mounts every combination in that page: the styles, the fonts and weights of
// the settings, the scales, both languages, what can be shown, long labels (tests/smoke/overlay-fit-probe.js does the
// measuring in the page). --full: every font × weight × scale. Step three: main's new size lands after the config (a
// new style or scale), so a widget that fitted itself to the old window fits itself again.
// Passes when a graph's rect is the same to the pixel at every value, the labels beside the numbers do not move, no
// text is cut off or left without room, nothing lies over anything else, a value over the boxes and a map before leave
// nothing smaller than a mount at the next value shows, and hidden judgements leave three digits at full size. Writes <out dir>/fit-report.json, prints a table. Exits 1 on a failure.
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FONTS, STYLES, WEIGHTS, WIDGETS, normalizeOverlaySettings, sizeOf, sessionOptions } from "../../src/overlay/settings.js";

const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith("-") && !a.endsWith(".mjs")) ?? "overlay-fit");
const FULL = args.includes("--full");
const REAL_ONLY = args.includes("--real-only");
const LIMIT_MS = FULL ? 40 * 60_000 : 8 * 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.join(here, "..", "..", "app", "overlay");
mkdirSync(outDir, { recursive: true });
rmSync(path.join(outDir, "fit-user-data"), { recursive: true, force: true });
app.setPath("userData", path.join(outDir, "fit-user-data"));
setTimeout(() => {
    console.error("timed out");
    app.exit(3);
}, LIMIT_MS).unref?.();

const VALUES = [0, 8, 12, 99, 111, 123, 777, 888, 1111, 1234];
const SCALES = FULL ? [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5] : [0.5, 1, 2.5];
const LANGS = ["ru", "en"];
const FONT_LIST = [null, ...Object.keys(FONTS)];
const WEIGHT_LIST = FULL ? WEIGHTS : [0, 900];
const LONG_MAP = {
    ru: {
        title: "Очень длинное название песни, которое никак не влезает в одну строку виджета и даже в две (Extended Mix)",
        artist: "Исполнитель с очень длинным именем и ещё тремя приглашёнными гостями feat. Кто-то Ещё",
        difficulty: "4K Безумно Длинное Название Сложности Для Проверки",
        mapper: "Картограф_С_Длинным_Именем",
        mods: ["HD", "HR", "DT", "NF", "FL", "MR"],
        rate: 1.25,
        lengthMs: 13_330_000,
        bpm: { common: 180, min: 120, max: 1234 },
        stars: 12.34,
    },
    en: {
        title: "Everything Will Freeze And Then Some More Words That Never End In One Line (Extended Long Version)",
        artist: "Somebody With A Really Long Name feat. Three More Guests And A Choir",
        difficulty: "4K Extremely Long Difficulty Name For The Fit Check",
        mapper: "Mapper_With_A_Very_Long_Name",
        mods: ["HD", "HR", "DT", "NF", "FL", "MR"],
        rate: 1.25,
        lengthMs: 13_330_000,
        bpm: { common: 180, min: 120, max: 1234 },
        stars: 12.34,
    },
};
// everything at once on the numbers' line: a one-line panel with few fields is narrower than this line alone
const BUSY_MAP = (lang) => ({ ...LONG_MAP[lang], mods: ["HD", "HR", "DT", "NF", "FL", "MR", "NC", "EZ"], lengthMs: 3_753_000, bpm: { common: 180, min: 120, max: 240 } });
const LONG_DAN = { numeric: 21.3, primary: "Technical Jumpstream Chordjack", tech: true, fit: { delta: -12.3, playerDan: 21, band: "hard" } };
const LN_DAN = { state: "ln" };
const INTERLUDE_SIX = { mapped: true, names: ["Marvellous", "Perfect", "Great", "Good", "Bad", "Miss"], labels: ["MARV", "PERF", "GREAT", "GOOD", "BAD", "MISS"] };
const INTERLUDE_LONG = { mapped: false, names: ["Fantastic", "Excellent", "Great", "Decent", "Way Off", "Terrible"] };
const INTERLUDE_EIGHT = { mapped: false, names: ["Ridiculous", "Marvellous", "Perfect", "OK", "Great", "Good", "Bad", "Miss"] };

const showAll = (widget) => {
    const all = { judgements: ["counts", "ratio", "accuracy", "ur"], kps: ["now", "max", "graph"], nps: ["now", "peak", "graph"], keys: ["lines", "counts"], dan: ["map", "pattern", "forYou", "play"], map: [] }[widget];
    return Object.fromEntries(all.map((k) => [k, true]));
};
// the shapes each widget comes in: what it shows and the data that is hardest on it
function variantsOf(widget, lang) {
    switch (widget) {
        case "kps": return [
            { name: "all", show: {} }, { name: "no max", show: { max: false } }, { name: "no now", show: { now: false } }, { name: "no graph", show: { graph: false } },
        ];
        case "nps": return [{ name: "all", show: {} }, { name: "no peak", show: { peak: false } }];
        case "keys": return [
            { name: "4K", show: {}, data: { keys: 4 } }, { name: "7K", show: {}, data: { keys: 7 } }, { name: "10K", show: {}, data: { keys: 10 } }, { name: "18K", show: {}, data: { keys: 18 } },
            { name: "no counts", show: { counts: false }, data: { keys: 4 } },
        ];
        case "judgements": return [
            { name: "all", show: {} }, { name: "interlude six", show: {}, data: { judgeNames: INTERLUDE_SIX } },
            { name: "interlude own", show: {}, data: { judgeNames: INTERLUDE_LONG } },
            { name: "interlude eight", show: {}, data: { judgeNames: INTERLUDE_EIGHT } },
            { name: "two rows", show: {}, rows: { n300: false, n200: false, n100: false, n50: false } },
            { name: "no 50", show: {}, rows: { n50: false } }, { name: "no 100 50", show: {}, rows: { n100: false, n50: false } },
            { name: "no miss", show: {}, rows: { miss: false } },
            { name: "small screen", show: {}, screen: 1366 },
        ];
        case "dan": return [
            { name: "head", show: {} }, { name: "extras", show: { pattern: true, forYou: true, play: true } },
            { name: "long", show: { pattern: true, forYou: true, play: true }, data: { dan: LONG_DAN } }, { name: "ln", show: {}, data: { dan: LN_DAN } },
        ];
        case "map": return [
            { name: "made-up", show: {} }, { name: "long", show: {}, data: { map: LONG_MAP[lang] } },
            { name: "numbers only", show: { title: false, artist: false, difficulty: false, mapper: false } },
            { name: "title and numbers", show: { artist: false, difficulty: false, mapper: false, stars: false, dan: false }, data: { map: BUSY_MAP(lang) } },
            { name: "title and mods", show: { artist: false, difficulty: false, mapper: false, stars: false, dan: false, bpm: false, length: false, rate: false }, data: { map: BUSY_MAP(lang) } },
            { name: "names and numbers", show: { title: false, stars: false, dan: false }, data: { map: BUSY_MAP(lang) } },
        ];
        default: return [{ name: "all", show: {} }];
    }
}

function comboFor(widget, { style, font, weight, scale, lang, variant }) {
    const raw = { widgets: { [widget]: { style, font, weight, scale, show: variant.show, ...(variant.rows ? { rows: variant.rows } : {}) } } };
    if (widget === "dan") raw.widgets.dan.show = { map: true, ...variant.show };
    const settings = normalizeOverlaySettings(raw);
    const w = settings.widgets[widget];
    const size = sizeOf(widget, w);
    // settings.js withinScreen(): a widget larger than the screen is as large as the screen
    if (variant.screen) size.width = Math.min(size.width, variant.screen);
    return { widget, style, font, weight, scale, lang, show: w.show, look: w, ...size, values: VALUES, variant: variant.data ?? {}, name: variant.name };
}

function openWindow(widget, { width, height }) {
    const win = new BrowserWindow({
        x: 0, y: 0, width, height, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
        resizable: false, skipTaskbar: true, focusable: false,
        webPreferences: { preload: path.join(OVERLAY, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
    });
    return win;
}

async function load(win, widget) {
    await win.loadFile(path.join(OVERLAY, "widget.html"), { query: { w: widget } });
    await win.webContents.executeJavaScript(readFileSync(path.join(here, "overlay-fit-probe.js"), "utf8"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const px = (x) => Math.round(x * 100) / 100;

// A config lands in the window of the old size, the new size after it: what shrank for the old one is back at full size.
async function resizeStep(failures) {
    const widget = "judgements";
    const win = openWindow(widget, { width: 200, height: 200 });
    await load(win, widget);
    const c = comboFor(widget, { style: "compact", font: null, weight: 0, scale: 1, lang: "ru", variant: variantsOf(widget, "ru")[0] });
    const config = { widget, style: c.style, scale: 1, show: c.show, look: c.look, lang: "ru", options: sessionOptions(normalizeOverlaySettings({})), edit: false, hotkey: "" };
    const scales = () => win.webContents.executeJavaScript(`[...document.querySelectorAll(".num, .fit")].map((n) => n.style.scale).filter(Boolean)`);
    win.webContents.send("overlay-config", config);
    win.webContents.send("overlay-visible", true);
    win.webContents.send("overlay-state", await win.webContents.executeJavaScript("window.__fit.snapshotAt(123, {})"));
    await win.webContents.executeJavaScript("window.__fit.frame()");
    const small = await scales();
    win.setContentSize(c.width, c.height);
    await sleep(300);
    const full = await scales();
    console.log(`resize: ${small.length} texts drawn smaller in the old window, ${full.length} in the new one`);
    if (!small.length || full.length) failures.push(`resize: ${small.length} shrank in the old window, still ${full.length} in the new one`);
    win.hide();
}

// the page's own paths: its config and snapshots over IPC, drawn by its own paint loop, the window at its size
async function realStep(failures) {
    const rows = [];
    for (const widget of WIDGETS) {
        const win = openWindow(widget, { width: 300, height: 200 });
        await load(win, widget);
        for (const style of STYLES) {
            for (const [font, scale, lang] of [[null, 1, "ru"], [null, 1, "en"], ["bahnschrift", 1, "ru"], ["impact", 2.5, "ru"], ["arialBlack", 0.5, "en"]]) {
                const c = comboFor(widget, { style, font, weight: 0, scale, lang, variant: variantsOf(widget, lang)[0] });
                win.setContentSize(c.width, c.height);
                const config = { widget, style, scale, show: c.show, look: c.look, lang, options: sessionOptions(normalizeOverlaySettings({})), edit: false, hotkey: "" };
                win.webContents.send("overlay-config", config);
                win.webContents.send("overlay-visible", true);
                await win.webContents.executeJavaScript("window.__fit.frame()");
                const seen = [];
                for (const v of VALUES) {
                    const s = await win.webContents.executeJavaScript(`window.__fit.snapshotAt(${v}, ${JSON.stringify(c.variant)})`);
                    win.webContents.send("overlay-state", s);
                    await win.webContents.executeJavaScript("window.__fit.frame()");
                    await win.webContents.executeJavaScript("window.__fit.jump()");
                    win.webContents.send("overlay-state", s);
                    await win.webContents.executeJavaScript("window.__fit.frame()");
                    // the window is the one measured here, not a sized box
                    seen.push({ v, m: await win.webContents.executeJavaScript("window.__fit.measure()") });
                }
                const first = seen[0].m;
                let graph = 0;
                let label = 0;
                let cut = 0;
                let who = "";
                const moves = [];
                for (const { v, m } of seen) {
                    m.graphs.forEach((g, i) => {
                        const d = Math.max(...["left", "top", "right", "bottom"].map((k) => Math.abs(g[k] - first.graphs[i][k])));
                        if (d > graph) graph = d;
                    });
                    for (const [name, r] of Object.entries(m.labels)) {
                        if (!first.labels[name]) continue;
                        const d = Math.max(...["left", "top", "right", "bottom"].map((k) => Math.abs(r[k] - first.labels[name][k])));
                        if (d > label) {
                            label = d;
                            moves[0] = `${name} at ${v}`;
                        }
                    }
                    for (const t of m.texts) {
                        if (t.cut > cut) {
                            cut = t.cut;
                            who = `${t.name} "${t.text.slice(0, 20)}" at ${v}`;
                        }
                    }
                }
                const row = { widget, style, font: font ?? "own", scale, lang, size: `${c.width}×${c.height}`, seen: first.size.join("×"), graph: px(graph), label: px(label), cut: px(cut), who: moves[0] ?? who };
                rows.push(row);
                if (graph > 0.01) failures.push(`real ${widget} ${style} ${font} ${scale} ${lang}: the graph moved ${px(graph)} px`);
                if (label > 0.01) failures.push(`real ${widget} ${style} ${font} ${scale} ${lang}: ${moves[0]} moved ${px(label)} px`);
                if (cut > 0.5) failures.push(`real ${widget} ${style} ${font} ${scale} ${lang}: ${who} cut by ${px(cut)} px`);
            }
        }
        win.hide();
    }
    return rows;
}

async function sweepStep(failures) {
    const totals = {};
    const worst = [];
    let combos = 0;
    for (const widget of WIDGETS) {
        const win = openWindow(widget, { width: 300, height: 200 });
        await load(win, widget);
        for (const style of STYLES) {
            const batch = [];
            for (const lang of LANGS) {
                for (const variant of variantsOf(widget, lang)) {
                    for (const font of FONT_LIST) {
                        for (const weight of WEIGHT_LIST) {
                            for (const scale of SCALES) batch.push(comboFor(widget, { style, font, weight, scale, lang, variant }));
                        }
                    }
                }
            }
            const key = `${widget}/${style}`;
            const t = (totals[key] = { combos: 0, graphShift: 0, labelShift: 0, cut: 0, cutCombos: 0, overCombos: 0, moved: 0, stale: 0, small: 0 });
            for (let i = 0; i < batch.length; i += 200) {
                const part = batch.slice(i, i + 200);
                const results = await win.webContents.executeJavaScript(`window.__fit.sweep(${JSON.stringify(part)})`);
                results.forEach((r, j) => {
                    const c = part[j];
                    combos += 1;
                    t.combos += 1;
                    t.graphShift = Math.max(t.graphShift, r.graphShift);
                    t.labelShift = Math.max(t.labelShift, r.labelShift);
                    t.cut = Math.max(t.cut, r.cut);
                    if (r.graphShift > 0.01 || r.labelShift > 0.01) t.moved += 1;
                    // the size a widget comes in: up to three digits have room in its own font, in both languages
                    if (c.font === null && c.weight === 0 && c.scale === 1 && c.name === variantsOf(widget, c.lang)[0].name) {
                        if (r.smallest.k < (t.ownSmallest ?? 1)) {
                            t.ownSmallest = r.smallest.k;
                            t.ownWho = `${r.smallest.who} ${c.lang}`;
                        }
                    }
                    // hidden judgements leave the room of three digits as it was
                    if (widget === "judgements" && style === "compact" && c.font === null && c.weight === 0 && c.scale === 1 && /^(all|no )/.test(c.name) && r.smallest.k < 1) t.small += 1;
                    if (r.cut > 0.5) t.cutCombos += 1;
                    if (r.over.length) t.overCombos += 1;
                    if (r.stale) t.stale += 1;
                    if (r.graphShift > 0.01 || r.labelShift > 0.01 || r.cut > 0.5 || r.over.length || r.stale) {
                        worst.push({
                            combo: `${widget} ${style} ${c.name} ${c.font ?? "own"} ${c.weight} ${c.scale} ${c.lang} ${c.width}×${c.height}`,
                            graph: px(r.graphShift), label: px(r.labelShift), who: r.labelWho, cut: px(r.cut), cutWho: r.cutWho, over: r.over.slice(0, 2), stale: r.stale,
                        });
                    }
                });
            }
            console.log(key, JSON.stringify({ ...t, graphShift: px(t.graphShift), labelShift: px(t.labelShift), cut: px(t.cut) }));
        }
        win.hide();
    }
    for (const [key, t] of Object.entries(totals)) {
        if (t.moved || t.cutCombos || t.overCombos || t.stale || t.small) failures.push(`sweep ${key}: moved in ${t.moved}, cut in ${t.cutCombos}, overlapping in ${t.overCombos}, left smaller in ${t.stale}, under full size in ${t.small} of ${t.combos}`);
    }
    worst.sort((a, b) => Math.max(b.graph, b.label, b.cut) - Math.max(a.graph, a.label, a.cut));
    return { combos, totals, worst: worst.slice(0, 400), bad: worst.length };
}

app.whenReady().then(async () => {
    ipcMain.on("get-lang", (event) => { event.returnValue = "en"; });
    const failures = [];
    let code = 0;
    try {
        const real = await realStep(failures);
        console.table(real.filter((r) => r.graph || r.label || r.cut).slice(0, 40));
        await resizeStep(failures);
        const sweep = REAL_ONLY ? null : await sweepStep(failures);
        writeFileSync(path.join(outDir, "fit-report.json"), JSON.stringify({ real, sweep, failures }, null, 1));
        console.log(`real: ${real.length} windows; sweep: ${sweep?.combos ?? 0} combinations; ${failures.length} failures`);
        for (const f of failures.slice(0, 60)) console.log("FAIL", f);
        if (failures.length) code = 1;
    } catch (error) {
        console.error(error);
        code = 2;
    }
    await sleep(10);
    app.exit(code);
});
