// Run with: npx electron tests/smoke/electron-skin.mjs <out-dir> [lang=en]   (SMOKE_LANG=en works too)
// The Skin tab through the real window, fully offline, over fixture folders made here only (<out-dir>/osu with a
// Skins folder, <out-dir>/docs as Documents, <out-dir>/user-data): the tab bar with seven tabs at 320 px and
// narrower (and gone in compact mode); a skin made from scratch with the builder; an edit in the editor (the hit
// position) that the preview and the working copy's skin.ini follow; upscroll; undo; the .osk export (opened with a
// stub instead of osu!) and the Interlude .isk; an osu! skin of the fixture Skins folder opened as a copy (its
// original untouched), the user's own pictures dropped on thumbnails (a note for all columns, a WebP judgement,
// reset, undo) and carried into the .osk; the recent list. Screenshots go to <out-dir>. Exits 1 on any failed check.
import { app, BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSkinService } from "../../app/skinIpc.js";
import { buildSkin, skinIniText } from "../../src/skin/build.js";
import { readSkinArchive } from "../../src/skin/skinArchive.js";
import { parseSkinIni, getValue } from "../../src/skin/skinIni.js";
import { setLang, t } from "../../src/i18n/i18n.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("electron-skin.mjs")) + 1);
const outDir = path.resolve(args.find((a) => !a.includes("=")) ?? path.join(here, "skin-out"));
const lang = setLang(args.includes("lang=en") || process.env.SMOKE_LANG === "en" ? "en" : "ru");
mkdirSync(outDir, { recursive: true });
for (const dir of ["user-data", "osu", "docs"]) rmSync(path.join(outDir, dir), { recursive: true, force: true });
app.setPath("userData", path.join(outDir, "user-data"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, what) => {
    console.log(`SMOKE ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed = true;
};

// ---- fixtures: an osu! folder with one skin of the builder's (bars) and a skin.ini with other key counts ----
const game = path.join(outDir, "osu");
const fixtureSkin = path.join(game, "Skins", "Fixture Bars");
const built = buildSkin({ shape: "bar", palette: "sunset", name: "Fixture Bars", author: "TestPlayer", judgements: "words", font: "pixel" }, { dir: "art" });
for (const f of built.files) {
    const target = path.join(fixtureSkin, ...f.name.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.data);
}
const fixtureIni = `${skinIniText(built)}\r\n// 7K, left alone\r\n[Mania]\r\nKeys: 7\r\nColumnWidth: 30\r\n`;
writeFileSync(path.join(fixtureSkin, "skin.ini"), fixtureIni, "utf8");
mkdirSync(path.join(game, "Skins", "Empty one"), { recursive: true });
const docsDir = path.join(outDir, "docs");
const skinsOut = path.join(docsDir, "скины");

app.whenReady().then(async () => {
    const blocked = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const offline = /^(file|devtools|data|blob|chrome|about):/i.test(details.url);
        if (!offline) blocked.push(details.url);
        callback({ cancel: !offline });
    });
    ipcMain.on("get-lang", (event) => { event.returnValue = lang; });
    ipcMain.on("tab", () => {});
    const opened = [];
    const shown = [];
    const service = createSkinService({
        userData: path.join(outDir, "user-data"), docsDir, env: {}, gameFolder: async () => game,
        shell: { openPath: async (f) => { opened.push(f); return ""; }, showItemInFolder: (f) => shown.push(f) },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        log: (l) => console.log("log", l),
    });
    const channels = {
        "skin-list": "list", "skin-open": "open", "skin-import": "importArchive", "skin-create": "create", "skin-build": "build",
        "skin-save": "save", "skin-images": "images", "skin-replace-image": "replaceImage", "skin-export-osk": "exportOsk",
        "skin-save-copy": "saveCopy", "skin-export-interlude": "exportInterlude", "skin-reopen": "reopen", "skin-recent": "recent", "skin-show": "show",
    };
    for (const [channel, method] of Object.entries(channels)) ipcMain.handle(channel, (_e, req) => service[method](req));
    // every other channel the preload invokes answers "nothing here", so the other tabs start quietly
    const preload = readFileSync(path.join(appDir, "preload.cjs"), "utf8");
    for (const m of preload.matchAll(/ipcRenderer\.invoke\("([\w-]+)"/g)) {
        if (!channels[m[1]]) ipcMain.handle(m[1], () => ({ ok: false, message: "smoke" }));
    }
    for (const m of preload.matchAll(/ipcRenderer\.send\("([\w-]+)"/g)) if (!["tab"].includes(m[1])) ipcMain.on(m[1], () => {});

    const win = new BrowserWindow({ width: 320, height: 900, show: false, backgroundColor: "#14121c",
        webPreferences: { preload: path.join(appDir, "preload.cjs"), contextIsolation: true, sandbox: true } });
    const errors = [];
    win.webContents.on("console-message", (_e, level, msg) => {
        if (level >= 2) console.log("console", level, msg);
        if (level >= 3 && /skin/i.test(msg)) errors.push(msg);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(250);
        writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (code, ms = 20000) => {
        for (let waited = 0; waited < ms; waited += 150) {
            if (await js(code)) return true;
            await sleep(150);
        }
        return false;
    };
    const tab = (name) => js(`document.querySelector('[data-tab=${name}]').click(); true`);
    const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
    const clickChip = (box, label) => js(`(() => { const c = [...document.querySelectorAll(${JSON.stringify(`${box} .chips span`)})].find((s) => s.textContent.trim() === ${JSON.stringify(label)}); c?.click(); return Boolean(c); })()`);
    const workIni = async () => {
        const id = (await service.recent()).items[0].id;
        return readFileSync(path.join(outDir, "user-data", "skin-work", id, readdirSync(path.join(outDir, "user-data", "skin-work", id)).find((n) => n.toLowerCase() === "skin.ini")), "utf8");
    };
    const canvasPrint = () => js(`document.getElementById("sk-preview").toDataURL().length + ":" + document.getElementById("sk-preview").toDataURL().slice(-200)`);
    // pause the preview at a fixed moment of its loop (the play button), so two pictures compare
    const pausePreview = () => js(`(() => { const b = document.querySelector("#sk-preview-controls button"); if (b && b.textContent === ${JSON.stringify(t("skin.preview.pause"))}) b.click(); return true; })()`);
    const sideways = () => js(`Math.max(document.documentElement.scrollWidth - innerWidth, (() => { const s = document.getElementById("skin-tab"); return s.scrollWidth - s.clientWidth; })())`);

    await win.loadFile(path.join(appDir, "renderer", "index.html"));
    await js("localStorage.clear(); true");
    await win.loadFile(path.join(appDir, "renderer", "index.html"));

    // ---- the tab bar: seven tabs at the default 320 px, narrower, and compact mode ----
    const barAt = () => js(`(() => { const n = document.querySelector(".tabs"); return { over: n.scrollWidth - n.clientWidth, labels: [...n.children].map((b) => b.textContent), heights: [...n.children].map((b) => b.offsetHeight), cut: [...n.children].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent) }; })()`);
    const bar = await barAt();
    console.log("tabs:", JSON.stringify(bar));
    check(bar.labels.length === 7 && bar.labels.at(-1) === t("skin.html.tab"), `seven tabs, the last «${t("skin.html.tab")}»`);
    check(bar.over <= 0, `the tab bar fits at 320 px (overflow ${bar.over})`);
    check(new Set(bar.heights).size === 1, "every tab is one line high at 320 px");
    check(bar.cut.length === 0, `no tab label is cut (${bar.cut.join(", ") || "none"})`);
    await shot(`1-tabs-320-${lang}.png`);
    for (const width of [260, 240, 220]) {
        win.setContentSize(width, 900);
        await sleep(300);
        const narrow = await barAt();
        check(narrow.over <= 0 && narrow.cut.length === 0, `the tab bar fits at ${width} px (${narrow.over}, cut: ${narrow.cut.join(", ") || "none"})`);
        if (width === 220) await shot(`2-tabs-220-${lang}.png`);
    }
    win.setContentSize(320, 900);
    win.webContents.send("settings", { alwaysOnTop: false, compact: true, lang });
    await sleep(300);
    check(await js(`getComputedStyle(document.querySelector(".tabs")).display === "none"`), "compact mode hides the tab bar");
    win.webContents.send("settings", { alwaysOnTop: false, compact: false, lang });
    await sleep(200);

    // ---- the Skin tab at the size the app gives the other tabs ----
    win.setContentSize(480, 900);
    await sleep(200);
    await tab("skin");
    await sleep(400);
    check(await js(`!document.getElementById("skin-tab").hidden && !document.getElementById("sk-pane-new").hidden`), "the Skin tab opens on «from scratch»");
    check(await clickChip("#sk-builder-new", t("skin.b.shapeArrow")), "arrows chosen");
    check(await clickChip("#sk-builder-new", t("skin.b.keyRing")), "keys with an icon chosen");
    check(await clickChip("#sk-builder-new", t("skin.b.judgeWords")), "word judgements chosen");
    await shot(`3-builder-${lang}.png`);
    check((await sideways()) <= 0, "nothing scrolls sideways on the start page");
    await js(`document.getElementById("sk-create").click(); true`);
    check(await waitFor(`!document.getElementById("sk-session").hidden`), "the skin is made and opened");
    await sleep(600);
    check((await text("sk-name")) === "Lunacy 4K", "its name is shown");
    check(await js(`!document.getElementById("sk-export-il").hidden`), "Interlude is offered for a skin made here");
    await pausePreview();
    await sleep(300);
    const before = await canvasPrint();
    await shot(`4-made-preview-${lang}.png`);

    // ---- an edit: the hit position, through the editor's number box ----
    const setNumber = (label, value) => js(`(() => {
        const row = [...document.querySelectorAll("#sk-editor .sk-row")].find((r) => r.querySelector(".sk-label")?.textContent === ${JSON.stringify(label)});
        const input = row?.querySelector("input.sk-num");
        if (!input) return false;
        input.value = ${JSON.stringify(String(value))};
        input.dispatchEvent(new Event("change"));
        return true;
    })()`);
    check(await setNumber(t("skin.f.hitPosition"), 360), "the hit position is set in the editor");
    await sleep(900);
    check(getValue(parseSkinIni(await workIni()), { mania: 4 }, "HitPosition") === "360", "the working copy's skin.ini has HitPosition: 360");
    const after = await canvasPrint();
    check(before !== after, "the preview follows the edit");
    await shot(`5-hit-position-${lang}.png`);
    await js(`[...document.querySelectorAll("#sk-preview-controls button")][1].click(); true`);
    await sleep(300);
    check(await js(`[...document.querySelectorAll("#sk-preview-controls button")][1].textContent === ${JSON.stringify(t("skin.preview.upscroll"))}`), "upscroll in the preview");
    await shot(`6-upscroll-${lang}.png`);
    await js(`[...document.querySelectorAll("#sk-preview-controls button")][1].click(); true`);
    await js(`document.getElementById("sk-undo").click(); true`);
    await sleep(900);
    check(getValue(parseSkinIni(await workIni()), { mania: 4 }, "HitPosition") === "410", "undo takes it back to 410");
    await js(`document.getElementById("sk-redo").click(); document.getElementById("sk-undo").click(); true`);
    await sleep(600);
    // ---- the user's own pictures: a note for all four columns (PNG) and the MAX judgement (WebP), dropped ----
    const dropPicture = (key, name, type, shape) => js(`(async () => {
        const c = document.createElement("canvas");
        c.width = 96; c.height = ${shape === "wide" ? 40 : 96};
        const g = c.getContext("2d");
        g.fillStyle = "#ff5fd2"; g.beginPath(); g.ellipse(48, c.height / 2, 44, c.height / 2 - 4, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = "#ffffff"; g.fillRect(40, c.height / 2 - 4, 16, 8);
        const blob = await new Promise((r) => c.toBlob(r, ${JSON.stringify(type)}));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
        const thumb = document.querySelector('#sk-editor .sk-thumb[data-key="${key}"]');
        if (!thumb) return false;
        thumb.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        return true;
    })()`);
    const beforeOwn = await canvasPrint();
    await js(`document.getElementById("sk-all-columns").click(); true`);
    check(await dropPicture("NoteImage0", "my-note.png", "image/png", "round"), "a note picture dropped on column 1's thumbnail");
    const ownNote = async () => getValue(parseSkinIni(await workIni()), { mania: 4 }, "NoteImage3") ?? "";
    for (let i = 0; i < 30 && !(await ownNote()).startsWith("lunacy-mania/custom/"); i += 1) await sleep(200);
    const noteValue = await ownNote();
    check(noteValue.startsWith("lunacy-mania/custom/NoteImage0-"), `«apply to all columns»: column 4 has it too (${noteValue})`);
    const madeId = (await service.recent()).items[0].id;
    const workOf = (value, suffix) => path.join(outDir, "user-data", "skin-work", madeId, ...`${value}${suffix}.png`.split("/"));
    check(existsSync(workOf(noteValue, "")) && existsSync(workOf(noteValue, "@2x")), "saved as PNG and @2x");
    check(await dropPicture("Hit300g", "max.webp", "image/webp", "wide"), "a WebP judgement picture dropped on MAX");
    const ownHit = async () => getValue(parseSkinIni(await workIni()), { mania: 4 }, "Hit300g") ?? "";
    for (let i = 0; i < 30 && !(await ownHit()).startsWith("lunacy-mania/custom/"); i += 1) await sleep(200);
    const hitValue = await ownHit();
    check(hitValue.startsWith("lunacy-mania/custom/Hit300g-") && existsSync(workOf(hitValue, "@2x")), `the MAX judgement is the user's (${hitValue})`);
    await sleep(500);
    check((await canvasPrint()) !== beforeOwn, "the preview shows the new pictures");
    check((await text("sk-status")).includes("Hit300g"), "the status line says what was replaced");
    await js(`document.querySelectorAll("#sk-editor details").forEach((d, i) => { d.open = i === 4 || i === 6; }); document.getElementById("sk-preview").scrollIntoView(); true`);
    await sleep(300);
    await shot(`7a-own-pictures-preview-${lang}.png`);
    await js(`document.querySelectorAll("#sk-editor details")[4].scrollIntoView(); true`);
    await shot(`7b-own-pictures-editor-${lang}.png`);
    // «Сбросить» on column 2 (with «all columns» on) takes all four back
    await js(`document.querySelector('#sk-editor .sk-thumb[data-key="NoteImage1"]').parentElement.querySelector(".sk-reset").click(); true`);
    await sleep(900);
    check(!(await ownNote()).startsWith("lunacy-mania/custom/"), "reset takes the builder's note back");
    await js(`document.getElementById("sk-undo").click(); document.getElementById("sk-all-columns").click(); true`);
    await sleep(900);
    check((await ownNote()) === noteValue, "undo brings the own note back");
    // the editor's groups open
    await js(`document.querySelectorAll("#sk-editor details").forEach((d, i) => { d.open = i === 3 || i === 4; }); document.getElementById("sk-editor").scrollIntoView(); true`);
    await sleep(300);
    await shot(`7-editor-colours-columns-${lang}.png`);
    check((await sideways()) <= 0, "nothing scrolls sideways in the editor");

    // ---- exports ----
    await js(`document.getElementById("sk-export-osk").click(); true`);
    check(await waitFor(`!document.getElementById("sk-result").hidden`), "the .osk is saved");
    const osk = path.join(skinsOut, "Lunacy 4K.osk");
    check(existsSync(osk), "Lunacy 4K.osk is in Documents\\…\\скины");
    check(opened.includes(osk), "and opened (osu! would import it)");
    const inOsk = existsSync(osk) ? readSkinArchive(readFileSync(osk)).map((e) => e.name) : [];
    check(inOsk.includes("skin.ini") && inOsk.some((n) => /note-0-.*@2x\.png$/.test(n)) && inOsk.some((n) => /b1\/hit300@2x\.png$/.test(n)), `the .osk holds skin.ini and the @2x pictures (${inOsk.length} files)`);
    await js(`document.getElementById("sk-result").scrollIntoView(); true`);
    await shot(`8-exported-${lang}.png`);
    await js(`document.getElementById("sk-result").hidden = true; document.getElementById("sk-export-il").click(); true`);
    check(await waitFor(`!document.getElementById("sk-result").hidden`), "the Interlude skin is saved");
    const isk = path.join(skinsOut, "Lunacy 4K.isk");
    const inIsk = existsSync(isk) ? readSkinArchive(readFileSync(isk)).map((e) => e.name) : [];
    check(inIsk.includes("skin.json") && inIsk.includes("Noteskin/noteskin.json") && inIsk.includes("Noteskin/receptor[1x8].png"), "Lunacy 4K.isk holds skin.json and the noteskin");
    check(inOsk.includes(`${noteValue}@2x.png`) && inOsk.includes(`${hitValue}@2x.png`), "the .osk carries the user's pictures");

    // ---- an osu! skin of the Skins folder, opened as a copy ----
    await js(`document.getElementById("sk-close").click(); true`);
    await sleep(400);
    check(await waitFor(`document.querySelectorAll("#sk-recent .sk-recent-row").length === 1`), "the made skin is in the recent list");
    await js(`(() => { const c = [...document.querySelectorAll("#sk-source .chips span")][0]; c.click(); return true; })()`);
    check(await waitFor(`document.getElementById("sk-osu-list").options.length === 2`), "the fixture Skins folder is listed");
    await js(`document.getElementById("sk-osu-list").value = "Fixture Bars"; true`);
    await shot(`9-osu-skins-${lang}.png`);
    await js(`document.getElementById("sk-open").click(); true`);
    check(await waitFor(`!document.getElementById("sk-session").hidden && document.getElementById("sk-name").textContent === "Fixture Bars"`), "the osu! skin is opened");
    await sleep(500);
    check(await js(`document.getElementById("sk-export-il").hidden`), "no Interlude button for an osu! skin");
    check((await text("sk-il-note")) === t("skin.interlude.onlyBuilt"), "the reason is said");
    await pausePreview();
    await shot(`10-osu-skin-${lang}.png`);
    // a picture replaced: dropped on the first note's thumbnail
    check(await dropPicture("NoteImage0", "mine@2x.png", "image/png", "round"), "a picture dropped on the osu! skin's note");
    for (let i = 0; i < 30 && !(getValue(parseSkinIni(await workIni()), { mania: 4 }, "NoteImage0") ?? "").startsWith("lunacy-mania/custom/"); i += 1) await sleep(200);
    const replaced = getValue(parseSkinIni(await workIni()), { mania: 4 }, "NoteImage0") ?? "";
    check(replaced.startsWith("lunacy-mania/custom/NoteImage0-"), `the note picture is replaced (${replaced})`);
    check((getValue(parseSkinIni(await workIni()), { mania: 4 }, "NoteImage1") ?? "").startsWith("art/"), "only column 1 (all columns off)");
    await js(`document.querySelectorAll("#sk-editor details")[4].open = true; document.querySelectorAll("#sk-editor details")[4].scrollIntoView(); true`);
    await sleep(300);
    await shot(`11-replaced-${lang}.png`);
    check(readFileSync(path.join(fixtureSkin, "skin.ini"), "utf8") === fixtureIni, "the osu! skin's own skin.ini is untouched");
    check(getValue(parseSkinIni(await workIni()), { mania: 7 }, "ColumnWidth") === "30", "its 7K section is kept");
    if (lang === "en") {
        const cyr = await js(`(document.getElementById("skin-tab").innerText.match(/[А-Яа-яЁё][^\\n]{0,40}/g) || []).join(" ‖ ")`);
        check(!cyr, `no Russian on the Skin tab in English (${cyr || "none"})`);
    }
    check(errors.length === 0, `no errors from the tab (${errors.join(" | ") || "none"})`);
    check(blocked.length === 0, `no network from the window (${blocked.join(", ") || "none"})`);
    app.exit(failed ? 1 : 0);
});
