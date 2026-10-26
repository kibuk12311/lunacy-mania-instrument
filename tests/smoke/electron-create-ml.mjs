// Run with: npx electron tests/smoke/electron-create-ml.mjs <outDir> [lang=en]
// The create tab's wave-3 parts (stream U) in a real window, 480 px wide, with nothing real behind it: a 60 s click
// track is loaded through the file input (the renderer works out its stems for real), generator-info answers with
// the 0.9.0 models (Classic, XGBoost v3, Neural net S and M; L not there yet) and two styles, generate-map answers
// from tests/fixtures/generateResult.json with a critic and a song structure, and the ratings channels answer like
// main does. It checks that Classic is picked by default and L is greyed out, that the request carries the options and
// the stems, that 12 candidates (set on the slider; the default is 1) make 2 cards with the critic line, and that
// 👎 + a tag reach rate-variant; then it captures the model picker, the first card with its rating bar and the timeline
// (create-ml-<part>-<lang>.png) and lists whatever sticks out of the tab sideways. Exits 1 when the tab scrolls
// sideways or a check fails. User data stays in outDir.
// The mapper style (0.9.5): generator-info's stylesBySize comes from the real model files in models/ when they are
// there (app/modelStyles.js, as main reads them), else from two made-up styles. Before any run it checks that Classic
// leaves the style list off and says why, that XGBoost v3 shows its styles at once (most maps first, «Name · N карт»),
// that the search box finds one and Enter picks it, and that Neural net S keeps it with a proper name (not "n:…");
// it captures the three (create-ml-style-<classic|xgb3|nn-s>-<lang>.png), and the card names the style used.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clickTrack } from "../fixtures/clickTrack.js";
import { createStyleCatalog } from "../../app/modelStyles.js";
import { listModelFiles, modelDirs } from "../../app/generatorJobs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const outDir = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("-") && !a.includes("=") && !a.endsWith(".mjs")) ?? "smoke-out");
const lang = process.argv.includes("lang=en") ? "en" : "ru";
const fixture = JSON.parse(readFileSync(path.join(here, "..", "fixtures", "generateResult.json"), "utf8"));
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));

function wav(samples, sampleRate) {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i += 1) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
    const head = Buffer.alloc(44);
    head.write("RIFF", 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write("WAVEfmt ", 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(sampleRate, 24);
    head.writeUInt32LE(sampleRate * 2, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36);
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
}
const song = path.join(outDir, "click174.wav");
const { samples, sampleRate } = clickTrack({ bpm: 174, offsetMs: 312, seconds: 60, sampleRate: 22050 });
writeFileSync(song, wav(samples, sampleRate));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(win, expr, ms = 15000) {
    for (let waited = 0; waited < ms; waited += 100) {
        if (await win.webContents.executeJavaScript(expr)) return true;
        await sleep(100);
    }
    return false;
}

const STYLES = [{ key: "mapperA", name: "Mapper A", maps: 48 }, { key: "u:4242", name: null, user: "4242", maps: 31 }];
const MODEL_INFO = { kind: "nn-v2", grid: "snap-v2", maps: 81234, size: "s", styles: STYLES, critic: "critic-v1", stems: true };
// the styles per model choice: the real model files' when they are here, else the two above for every experimental one
const realFiles = await listModelFiles(modelDirs({ env: {} })).catch(() => []);
const realStyles = realFiles.includes("mapper-xgb3.json")
    ? await createStyleCatalog({ dirs: modelDirs({ env: {} }), cacheFile: path.join(outDir, "user-data", "model-styles.json") }).bySize(realFiles).catch(() => null)
    : null;
const STYLES_BY_SIZE = realStyles ?? { auto: [], xgb3: STYLES, s: STYLES, m: STYLES, l: STYLES };
const SEARCH = realStyles ? "crz" : "4242";

app.whenReady().then(async () => {
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    ipcMain.on("tab", () => {});
    ipcMain.handle("detect-timing", async () => ({
        ok: true, timing: { sections: [{ timeMs: 312, bpm: 174, meter: 4 }], bpm: 174, offsetMs: 312 }, modelInfo: MODEL_INFO,
    }));
    ipcMain.handle("generator-info", async () => ({
        ok: true,
        modelInfo: {
            ...MODEL_INFO, engines: ["neural", "learned", "rules"], modelSizes: ["auto", "xgb3", "s", "m", "l"], stylesBySize: STYLES_BY_SIZE,
            sizes: { auto: true, xgb3: true, s: true, m: true, l: false, distilled: false },
            files: ["mapper-nn2-m.json", "mapper-nn2-s.json", "mapper-xgb3.json", "mapper.json", "critic.json"],
        },
    }));
    let made = 0;
    const requests = [];
    ipcMain.handle("generate-map", async (event, req) => {
        made += 1;
        requests.push(req);
        for (const [phase, i, n] of [["prepare", 0, 1], ["search", 0, 1], ["candidates", 3, 12], ["candidates", 11, 12], ["critic", 0, 1], ["describe", 0, 1]]) {
            event.sender.send("generate-progress", { jobId: req.jobId, phase, i, n });
            await sleep(40);
        }
        const k = (made - 1) % 2;
        // the parts asked for come back as the worker reports them, so the timeline can lock them
        const parts = (req.request.parts ?? []).map((p, index) => ({
            index, startMs: p.startMs, endMs: p.endMs, kind: p.kind, families: ["Jumpstream"], wanted: p.range ?? null, empty: Boolean(p.empty),
            locked: Boolean(req.request.lock?.parts.includes(index)), noteCount: 240, patternScore: 0.8,
            dan: { numeric: 12.9, label: "Gamma mid", top3: [] }, inRange: p.range ? true : null, issues: 0, retried: 0,
        }));
        return {
            ...fixture, id: `smoke-${made}`, planSeed: req.request.planSeed, noteSeed: req.request.noteSeed,
            patternScore: [0.84, 0.79][k], result: { ...fixture.result, numeric: [13.04, 12.86][k] }, range: req.request.range,
            modelInfo: MODEL_INFO, ms: 3400, ...(parts.length ? { parts } : {}),
            // the style used, as main names it
            style: (() => { const s = Object.values(STYLES_BY_SIZE).flat().find((x) => x.key === req.request.style); return s ? { key: s.key, name: s.name ?? null, user: s.user ?? null } : null; })(),
            styleAsked: null,
            critic: { kind: "critic-v1", score: 1.2, human: [0.83, 0.77][k], fun: [0.31, -0.12][k], play: [-0.2, -0.45][k], personal: null, style: null, picked: 4, of: req.request.candidates ?? 1, analysed: 3, ms: 960 },
            structure: {
                phrases: Array.from({ length: 8 }, (_, p) => ({ startMs: 312 + p * 11034, bars: 8 })),
                repeats: [{ aMs: 11346, bMs: 33415, lenMs: 11034, sim: 0.88 }, { aMs: 22380, bMs: 44449, lenMs: 5517, sim: 0.8 }],
            },
        };
    });
    const rated = [];
    let ratings = 0;
    ipcMain.handle("rate-variant", async (_e, r) => { rated.push(r); ratings = r.vote ? Math.max(ratings, 1) : ratings; return { ok: true, n: ratings }; });
    ipcMain.handle("ratings-summary", async () => ({ ok: true, n: ratings, up: 0, down: ratings, active: false, auc: null }));
    ipcMain.handle("ratings-export", async () => ({ ok: false, code: "empty", message: "smoke" }));
    ipcMain.handle("song-tags", async () => ({ ok: true, artist: "Unknown", title: "click174" }));
    ipcMain.handle("export-set", async () => ({ ok: false, message: "smoke test: nothing is saved" }));

    const win = new BrowserWindow({ width: 480, height: 900, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const problems = [];
    win.webContents.setAudioMuted(true);
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) problems.push(msg); });
    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab=create]').click(); true`);
    await sleep(300);

    const dbg = win.webContents.debugger;
    dbg.attach("1.3");
    const { root } = await dbg.sendCommand("DOM.getDocument", {});
    const { nodeId } = await dbg.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
    const t0 = Date.now();
    await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: [song] });
    dbg.detach();
    const loaded = await until(win, `!document.getElementById("generate").disabled`, 30000);
    const loadMs = Date.now() - t0;

    // two parts: split the song's one part at 0:30 (the cursor), so «only this part» has another part to keep
    const split = JSON.stringify(lang === "en" ? "Split at the cursor" : "Разрезать на курсоре");
    const clickTimeline = (share) => win.webContents.executeJavaScript(`(() => {
        const c = document.getElementById("timeline");
        c.scrollIntoView({ block: "center" });
        const r = c.getBoundingClientRect();
        const at = { clientX: r.left + r.width * ${share}, clientY: r.top + 20, button: 0, buttons: 1, bubbles: true, pointerId: 1 };
        c.dispatchEvent(new PointerEvent("pointerdown", at));
        c.dispatchEvent(new PointerEvent("pointerup", { ...at, buttons: 0 }));
        return true;
    })()`);
    await clickTimeline(0.5);
    await sleep(150);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll("#part-editor button")].find((b) => b.textContent === ${split})?.click(); true`);
    await sleep(150);

    // the picker before any run: what each size says here
    const picker = await win.webContents.executeJavaScript(`(() => [...document.querySelectorAll("#gen-options .ml-size")].map((b) => ({
        size: b.dataset.size, on: b.classList.contains("sel"), disabled: b.disabled, text: b.textContent })))()`);
    const shots = {};
    const capture = async (name, selector) => {
        const rect = await win.webContents.executeJavaScript(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            el.scrollIntoView({ block: "start" });
            const r = el.getBoundingClientRect();
            return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(Math.min(r.height, window.innerHeight - Math.max(0, r.top))) };
        })()`);
        await sleep(400);
        await win.webContents.capturePage();
        const pad = 6;
        const box = { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: Math.min(480, rect.width + 2 * pad), height: rect.height + 2 * pad };
        const file = path.join(outDir, `create-ml-${name}-${lang}.png`);
        writeFileSync(file, (await win.webContents.capturePage(box)).toPNG());
        shots[name] = file;
    };
    await capture("picker-default", "#gen-options");

    // the mapper style per model, before any run: Classic, XGBoost v3 (search + Enter), Neural net S
    const styleState = () => win.webContents.executeJavaScript(`(() => {
        const sel = document.querySelector("#gen-options [data-role=style]");
        const filter = document.querySelector("#gen-options [data-role=style-filter]");
        const hint = document.querySelector("#gen-options [data-role=style-hint]");
        return { disabled: sel.disabled, value: sel.value, options: [...sel.options].map((o) => o.textContent), filterShown: !filter.hidden && filter.offsetParent !== null,
            hint: hint.hidden ? "" : hint.textContent };
    })()`);
    const pickSize = (size) => win.webContents.executeJavaScript(`document.querySelector('#gen-options .ml-size[data-size="${size}"]').click(); true`);
    const styleClassic = await styleState();
    await capture("style-classic", ".ml-style-field");
    await pickSize("xgb3");
    await sleep(100);
    const styleXgb = await styleState();
    // the search box: type, then Enter takes the first match
    await win.webContents.executeJavaScript(`(() => {
        const f = document.querySelector("#gen-options [data-role=style-filter]");
        f.focus();
        f.value = ${JSON.stringify(SEARCH)};
        f.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    })()`);
    await sleep(100);
    const styleSearch = await styleState();
    await capture("style-xgb3", ".ml-style-field");
    await win.webContents.executeJavaScript(`(() => {
        const f = document.querySelector("#gen-options [data-role=style-filter]");
        f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        f.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return true;
    })()`);
    await sleep(100);
    const stylePicked = await styleState();
    await pickSize("s");
    await sleep(100);
    const styleNn = await styleState();
    await capture("style-nn-s", ".ml-style-field");
    const styleOptions = styleNn.options;
    const ruOrEn = lang === "en" ? / · \d+ maps?$/ : / · \d+ карт[аы]?$/;
    const styleOk = styleClassic.disabled && !styleClassic.filterShown && styleClassic.options.length === 1
        && styleClassic.hint === (lang === "en" ? "the classic model has no styles — pick XGBoost v3 or a neural net" : "у классической модели нет стилей — выбери XGBoost v3 или нейросеть")
        && !styleXgb.disabled && styleXgb.filterShown && styleXgb.options.length === 1 + STYLES_BY_SIZE.xgb3.length
        && styleXgb.options.slice(1).every((o) => ruOrEn.test(o))
        && styleSearch.options.length >= 2 && styleSearch.options.length < styleXgb.options.length
        && stylePicked.value !== "" && styleNn.value === stylePicked.value
        && !styleNn.options.some((o) => o.startsWith("n:") || o.startsWith("u:"));
    for (const [name, st] of Object.entries({ styleClassic, styleXgb, styleSearch, stylePicked, styleNn })) console.log(name, JSON.stringify({ ...st, options: st.options.slice(0, 4), count: st.options.length }));
    // 12 candidates on the slider (the default is 1: no critic)
    const defaultCandidates = await win.webContents.executeJavaScript(`document.querySelector("#gen-options [data-role=candidates]").value`);
    await win.webContents.executeJavaScript(`(() => {
        const c = document.querySelector("#gen-options [data-role=candidates]");
        c.value = "12";
        c.dispatchEvent(new Event("input", { bubbles: true }));
        c.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    })()`);
    await win.webContents.executeJavaScript(`document.getElementById("generate").click(); true`);
    const stop = JSON.stringify(lang === "en" ? "Stop" : "Стоп");
    const generated = await until(win, `document.querySelectorAll(".cr-card").length >= 2 && document.getElementById("generate").textContent !== ${stop}`, 20000);

    // 👎 on the first card, then a tag
    await win.webContents.executeJavaScript(`document.querySelector(".cr-card [data-vote='-1']").click(); true`);
    await sleep(200);
    await win.webContents.executeJavaScript(`document.querySelector(".cr-card [data-tag=tooJacky]")?.click(); true`);
    await sleep(200);
    // the part editor: pick the first part so «only this part» shows
    await clickTimeline(0.25);
    await sleep(200);

    await capture("picker", "#gen-options");
    await capture("card", ".cr-card");
    await capture("parts", "#parts-group");
    // the whole window once, at the cards
    await win.webContents.executeJavaScript(`document.getElementById("gen-result").scrollIntoView({ block: "start" }); true`);
    await sleep(300);
    await win.webContents.capturePage();
    shots.window = path.join(outDir, `create-ml-window-${lang}.png`);
    writeFileSync(shots.window, (await win.webContents.capturePage()).toPNG());

    // «only this part» on the first part: a third variant with the second part locked
    const onlyText = JSON.stringify(lang === "en" ? "Regenerate only this part" : "Перегенерировать только эту часть");
    await win.webContents.executeJavaScript(`[...document.querySelectorAll("#part-editor button")].find((b) => b.textContent === ${onlyText})?.click(); true`);
    const regenerated = await until(win, `document.querySelectorAll(".cr-card").length >= 3 && document.getElementById("generate").textContent !== ${stop}`, 20000);
    const onlyLock = requests[2]?.request.lock ?? null;

    const report = await win.webContents.executeJavaScript(`(() => {
        const tab = document.getElementById("create-tab");
        const edge = tab.getBoundingClientRect().right;
        const wide = [...tab.querySelectorAll("*")].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > edge + 1)
            .map((el) => (el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + el.className) + " " + Math.round(el.getBoundingClientRect().right - edge) + "px").slice(0, 20);
        return {
            scrollWidth: tab.scrollWidth, clientWidth: tab.clientWidth, wide,
            status: document.getElementById("gen-status").textContent,
            cards: document.querySelectorAll(".cr-card").length,
            critic: [...document.querySelectorAll(".cr-card .ml-critic")].map((n) => n.textContent),
            rateBar: document.querySelector(".cr-card .ml-rate")?.textContent,
            ratingsLine: document.querySelector(".ml-ratings")?.textContent,
            partButtons: [...document.querySelectorAll("#part-editor button")].map((b) => b.textContent),
            cardStyle: [...document.querySelectorAll(".cr-card div")].map((n) => n.textContent).find((x) => /^(Стиль маппера|Mapper style): /.test(x)) ?? null,
        };
    })()`);
    const first = requests[0] ?? null;
    const sent = first ? {
        stems: Boolean(first.stems), stemsFrames: first.stems?.frames ?? null, envelopeFrames: first.envelope?.values?.length ?? null,
        modelSize: first.request.modelSize, candidates: first.request.candidates, style: first.request.style, repeats: first.request.repeats,
    } : null;
    const pickerOk = picker.length === 5 && picker.find((p) => p.size === "auto")?.on === true && picker.find((p) => p.size === "l")?.disabled === true
        && picker.filter((p) => p.size !== "l").every((p) => !p.disabled) && defaultCandidates === "1";
    const styleLine = report.cardStyle;
    const ok = pickerOk && styleOk && sent?.modelSize === "s" && sent?.style === stylePicked.value && Boolean(styleLine) && loaded && generated && regenerated && report.cards === 3 && made === 3 && sent?.stems && sent.candidates === 12 && sent.repeats === true
        && first.request.parts?.length === 2 && onlyLock?.fromId === "smoke-1" && JSON.stringify(onlyLock?.parts) === "[1]"
        && rated.length >= 2 && rated[0].vote === -1 && rated.at(-1).tags.includes("tooJacky") && report.critic.length === report.cards;
    console.log(JSON.stringify({ lang, loaded, loadMs, generated, made, sent, rated, picker, pickerOk, defaultCandidates, styleOk, styleLine, styleOptions: styleOptions.slice(0, 6), regenerated, onlyLock, ...report, ok, shots, problems: problems.slice(0, 10) }, null, 2));
    app.exit(report.wide.length || report.scrollWidth > report.clientWidth || !ok ? 1 : 0);
});
