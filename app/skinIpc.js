// The Skin tab's main side: skins are opened as working copies in userData\skin-work\<id> (an osu! skin is copied
// out of osu!'s Skins folder, which is only ever read; an .osk / .zip is unpacked; a new one is drawn by the
// builder), edited there, and exported into Documents\<app>\скины: an .osk osu! (stable and lazer) imports when it
// is opened, a plain folder copy, or — for a skin made with the builder — an Interlude .isk. Nothing is written into
// osu!'s or Interlude's folders.
import path from "node:path";
import * as nodeFs from "node:fs/promises";
import { createJsonStore } from "./jsonStore.js";
import { readSkinArchive, packOsk, exportedFiles, MAX_FILES, MAX_TOTAL_BYTES } from "../src/skin/skinArchive.js";
import { buildSkin, skinIniText, normalizeOptions, PARTS } from "../src/skin/build.js";
import { buildInterludeSkin } from "../src/skin/interludeSkin.js";
import { parseSkinIni, getValue, pairsOf, maniaSections } from "../src/skin/skinIni.js";
import { maniaConfig, imageCandidates, fieldByKey, MANIA_FIELDS } from "../src/skin/maniaFields.js";
import { pngSize, decodePng } from "../src/skin/png.js";
import { fromRgba } from "../src/skin/raster.js";
import { t } from "../src/i18n/i18n.js";

export const SKINS_FOLDER = "скины";
export const OWN_DIR = "lunacy-mania";
const RECENT_MAX = 8;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_INI_CHARS = 2 * 1024 * 1024;
const fail = (error) => ({ ok: false, message: String(error?.message ?? error) });
const ID = /^[a-z0-9]{6,32}$/;

// A file or folder name made of a skin's name: no characters Windows refuses, not empty, not too long.
export function safeName(name, fallback = "skin") {
    const s = String(name ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim().slice(0, 80);
    return s || fallback;
}

// skin.ini bytes → { text, encoding }: UTF-8 when it is valid UTF-8 (a BOM kept in the text), else read byte for
// byte (latin1), so writing it back changes nothing that was not edited.
export function decodeIni(buffer) {
    try {
        return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer), encoding: "utf8" };
    } catch {
        return { text: Buffer.from(buffer).toString("latin1"), encoding: "latin1" };
    }
}
export const encodeIni = (text, encoding) => Buffer.from(String(text), encoding === "latin1" ? "latin1" : "utf8");

// tosu's osu! stable folder: { game } (null when tosu reads lazer, osu! is closed or tosu is down).
async function osuGameFolder(port, fetchImpl = globalThis.fetch) {
    if (!port) return null;
    try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/json/v2`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return null;
        const j = await res.json();
        if (String(j?.client ?? "stable").toLowerCase() === "lazer") return null;
        const game = j?.folders?.game;
        return typeof game === "string" && game.trim() ? game.trim().replace(/[\\/]+$/, "") : null;
    } catch {
        return null;
    }
}

export const MAX_PICTURE_SIDE = 4096;
const BIG_SIDE = 2048;
const BIG_BYTES = 4 * 1024 * 1024;
const SQUARE_PARTS = new Set(["note", "head", "tail", "key", "keyD"]);
const toBuffer = (v) => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v instanceof ArrayBuffer ? Buffer.from(v) : null);

// Two PNGs of one picture, @1x and @2x: both PNG, the @2x twice the size (±1 px for odd sizes), within the limits.
// → { ok, size: @1x { width, height } } | { ok: false, message }
export function checkPicturePair(one, two) {
    const a = one ? pngSize(one) : null;
    const b = two ? pngSize(two) : null;
    if (!a || !b) return { ok: false, message: t("skin.err.notImage") };
    if (one.length > MAX_IMAGE_BYTES || two.length > MAX_IMAGE_BYTES) return { ok: false, message: t("skin.err.tooBig") };
    if (b.width > MAX_PICTURE_SIDE || b.height > MAX_PICTURE_SIDE || a.width < 1 || a.height < 1) return { ok: false, message: t("skin.err.pictureSize", { max: MAX_PICTURE_SIDE }) };
    if (Math.abs(b.width - a.width * 2) > 1 || Math.abs(b.height - a.height * 2) > 1) return { ok: false, message: t("skin.err.notPair") };
    return { ok: true, size: a, bytes: one.length + two.length };
}

// What to tell about a picture the user gave: very large, or not square where Interlude needs square frames.
export function pictureWarnings(size, keys, forInterlude = false) {
    const out = [];
    if (size.width * 2 > BIG_SIDE || size.height * 2 > BIG_SIDE) out.push("large");
    const parts = keys.map((k) => fieldByKey.get(k.toLowerCase())?.part);
    if (forInterlude && parts.some((p) => SQUARE_PARTS.has(p)) && Math.abs(size.width - size.height) > Math.max(size.width, size.height) * 0.1) out.push("notSquare");
    return out;
}

// A picture of the working copy as a raster image (its @2x when there is one), or null.
async function loadPicture(dir, value, fs = nodeFs) {
    for (const name of imageCandidates(value).filter((n) => n.endsWith(".png"))) {
        const data = await fs.readFile(path.join(dir, ...name.split("/"))).catch(() => null);
        if (!data) continue;
        try {
            const { width, height, data: rgba } = decodePng(data);
            return fromRgba(width, height, rgba);
        } catch {
            return null;
        }
    }
    return null;
}

export function createSkinService({
    userData, docsDir, env = process.env, port = null, fs = nodeFs, shell = null, dialog = null, window = () => null,
    log = () => {}, gameFolder = () => osuGameFolder(port), now = () => Date.now(),
}) {
    const workRoot = path.join(userData, "skin-work");
    const outDir = path.join(docsDir, SKINS_FOLDER);
    const recent = createJsonStore({
        file: path.join(userData, "skin-recent.json"),
        fallback: [],
        normalize: (v) => (Array.isArray(v) ? v.filter((e) => e && ID.test(String(e.id))).slice(0, RECENT_MAX) : []),
    });
    const exists = async (p) => Boolean(await fs.stat(p).catch(() => null));
    const workDir = (id) => {
        if (!ID.test(String(id))) throw new Error(t("skin.err.noSkin"));
        return path.join(workRoot, id);
    };
    const inside = (root, p) => path.resolve(p).startsWith(path.resolve(root) + path.sep);
    const newId = () => `${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toLowerCase().replace(/[^a-z0-9]/g, "");

    // osu!'s Skins folder: from the running stable (tosu), else %LOCALAPPDATA%\osu!\Skins; null when neither is there
    async function skinsFolder() {
        const game = await gameFolder();
        const candidates = [game ? path.join(game, "Skins") : null, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "osu!", "Skins") : null].filter(Boolean);
        for (const dir of candidates) if (await exists(dir)) return dir;
        return null;
    }

    // every file under dir as a relative path with "/" (capped like an archive)
    async function walk(dir) {
        const out = [];
        let total = 0;
        const visit = async (sub) => {
            for (const entry of await fs.readdir(path.join(dir, sub), { withFileTypes: true })) {
                const rel = sub ? `${sub}/${entry.name}` : entry.name;
                if (entry.isDirectory()) await visit(rel);
                else if (entry.isFile()) {
                    if (out.length >= MAX_FILES) throw new Error(t("skin.err.tooBig"));
                    total += (await fs.stat(path.join(dir, rel))).size;
                    if (total > MAX_TOTAL_BYTES) throw new Error(t("skin.err.tooBig"));
                    out.push(rel);
                }
            }
        };
        await visit("");
        return out;
    }

    // the skin.ini of a working copy (found whatever its case), or null
    async function iniPath(dir) {
        const names = await fs.readdir(dir).catch(() => []);
        const name = names.find((n) => n.toLowerCase() === "skin.ini");
        return name ? path.join(dir, name) : null;
    }

    async function remember(entry) {
        const list = await recent.update((all) => [entry, ...all.filter((e) => e.id !== entry.id)].slice(0, RECENT_MAX));
        // working copies no longer on the list go
        const keep = new Set(list.map((e) => e.id));
        for (const name of await fs.readdir(workRoot).catch(() => [])) {
            if (ID.test(name) && !keep.has(name)) await fs.rm(path.join(workRoot, name), { recursive: true, force: true }).catch(() => {});
        }
    }

    // The session the tab works on: the working copy's skin.ini text and what is known of it.
    async function session(id) {
        const entry = (await recent.get()).find((e) => e.id === id);
        if (!entry) throw new Error(t("skin.err.noSkin"));
        const dir = workDir(id);
        const file = await iniPath(dir);
        const { text, encoding } = file ? decodeIni(await fs.readFile(file)) : { text: "", encoding: "utf8" };
        const doc = parseSkinIni(text);
        return {
            ok: true, id, origin: entry.origin, source: entry.source, encoding,
            name: getValue(doc, "General", "Name") || entry.name, ini: text,
            builder: entry.builder ?? null, interlude: entry.origin === "template",
            mania4: maniaSections(doc).some((s) => s.keys === 4),
        };
    }

    async function start(entry) {
        await remember({ ...entry, at: now() });
        log(`skin: ${entry.origin} ${entry.name}`);
        return session(entry.id);
    }

    async function list() {
        const folder = await skinsFolder();
        if (!folder) return { ok: true, folder: null, skins: [] };
        const skins = [];
        for (const entry of (await fs.readdir(folder, { withFileTypes: true })).filter((e) => e.isDirectory()).slice(0, 500)) {
            const dir = path.join(folder, entry.name);
            const file = await iniPath(dir);
            let name = entry.name;
            let mania4 = false;
            if (file) {
                const doc = parseSkinIni(decodeIni(await fs.readFile(file)).text);
                name = getValue(doc, "General", "Name") || entry.name;
                mania4 = maniaSections(doc).some((s) => s.keys === 4);
            }
            skins.push({ folder: entry.name, name, mania4 });
        }
        skins.sort((a, b) => a.name.localeCompare(b.name));
        return { ok: true, folder, skins };
    }

    // a skin of osu!'s Skins folder by its folder name, copied out (the original is only read)
    async function open({ folder } = {}) {
        const root = await skinsFolder();
        const name = String(folder ?? "");
        if (!root || !name || /[\\/]/.test(name) || name === "." || name === "..") return { ok: false, message: t("skin.err.noSkin") };
        const from = path.join(root, name);
        if (!inside(root, from) || !(await exists(from))) return { ok: false, message: t("skin.err.noSkin") };
        const id = newId();
        const dir = workDir(id);
        const files = await walk(from);
        for (const rel of files) {
            const target = path.join(dir, ...rel.split("/"));
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(path.join(from, ...rel.split("/")), target);
        }
        if (!(await iniPath(dir))) await fs.writeFile(path.join(dir, "skin.ini"), `[General]\r\nName: ${name}\r\n`, "utf8");
        return start({ id, origin: "osu", source: name, name });
    }

    // an .osk / .zip: picked in a dialog, or a file dropped on the tab (only read)
    async function importArchive({ file = null } = {}) {
        let chosen = file ? String(file) : null;
        if (!chosen) {
            const r = await dialog?.showOpenDialog(window(), { title: t("skin.import.title"), properties: ["openFile"], filters: [{ name: "osu! skin", extensions: ["osk", "zip"] }] });
            if (!r || r.canceled || !r.filePaths?.[0]) return { ok: false, cancelled: true };
            chosen = r.filePaths[0];
        }
        if (!/\.(osk|zip)$/i.test(chosen)) return { ok: false, message: t("skin.err.notArchive") };
        let entries;
        try {
            entries = readSkinArchive(await fs.readFile(chosen));
        } catch {
            return { ok: false, message: t("skin.err.badArchive") };
        }
        const id = newId();
        const dir = workDir(id);
        for (const e of entries) {
            const target = path.join(dir, ...e.name.split("/"));
            if (!inside(dir, target)) continue;
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, e.read());
        }
        const stem = path.basename(chosen).replace(/\.(osk|zip)$/i, "");
        if (!(await iniPath(dir))) await fs.writeFile(path.join(dir, "skin.ini"), `[General]\r\nName: ${stem}\r\n`, "utf8");
        return start({ id, origin: "archive", source: path.basename(chosen), name: stem });
    }

    async function writeFiles(dir, files) {
        for (const f of files) {
            const target = path.join(dir, ...f.name.split("/"));
            if (!inside(dir, target)) continue;
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, f.data);
        }
    }

    // a skin from scratch: the builder draws it all, skin.ini says where everything is
    async function create({ options } = {}) {
        const id = newId();
        const dir = workDir(id);
        const result = buildSkin(options, { dir: `${OWN_DIR}/b1` });
        await writeFiles(dir, result.files);
        await fs.writeFile(path.join(dir, "skin.ini"), skinIniText(result), "utf8");
        return start({ id, origin: "template", source: null, name: result.options.name, builder: result.options, builds: 1 });
    }

    // the builder redraws parts of the open skin: new files in a new folder (undo keeps the old ones), the values
    // for skin.ini handed back for the tab to apply as one step
    async function build({ id, options, parts } = {}) {
        const entry = (await recent.get()).find((e) => e.id === id);
        if (!entry) return { ok: false, message: t("skin.err.noSkin") };
        const chosen = Array.isArray(parts) && parts.length ? parts.filter((p) => PARTS.includes(p)) : PARTS;
        if (!chosen.length) return { ok: false, message: t("skin.err.noParts") };
        const n = (entry.builds ?? 0) + 1;
        const result = buildSkin(options, { dir: `${OWN_DIR}/b${n}`, parts: chosen });
        await writeFiles(workDir(id), result.files);
        await recent.update((all) => all.map((e) => (e.id === id ? { ...e, builds: n, builder: result.options, at: now() } : e)));
        return { ok: true, options: result.options, general: result.general, mania: result.mania, files: result.files.length };
    }

    async function save({ id, ini } = {}) {
        if (typeof ini !== "string" || ini.length > MAX_INI_CHARS) return { ok: false, message: t("skin.err.badIni") };
        const dir = workDir(id);
        if (!(await exists(dir))) return { ok: false, message: t("skin.err.noSkin") };
        const current = (await iniPath(dir)) ?? path.join(dir, "skin.ini");
        const { encoding } = (await exists(current)) ? decodeIni(await fs.readFile(current)) : { encoding: "utf8" };
        await fs.writeFile(current, encodeIni(ini, encoding));
        const name = getValue(parseSkinIni(ini), "General", "Name");
        if (name) await recent.update((all) => all.map((e) => (e.id === id ? { ...e, name } : e)));
        return { ok: true };
    }

    // values of skin.ini → { value: { url, hd } | null }: the file each one loads, best candidate first
    async function images({ id, values } = {}) {
        const dir = workDir(id);
        const files = await walk(dir).catch(() => []);
        const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));
        const out = {};
        for (const value of (Array.isArray(values) ? values : []).slice(0, 200)) {
            if (typeof value !== "string" || !value.trim()) continue;
            const hit = imageCandidates(value).map((c) => byLower.get(c.toLowerCase())).find(Boolean);
            if (!hit) {
                out[value] = null;
                continue;
            }
            const full = path.join(dir, ...hit.split("/"));
            const { size } = await fs.stat(full);
            if (size > MAX_IMAGE_BYTES) {
                out[value] = null;
                continue;
            }
            const type = /\.jpe?g$/i.test(hit) ? "image/jpeg" : "image/png";
            out[value] = { url: `data:${type};base64,${(await fs.readFile(full)).toString("base64")}`, hd: /@2x\.(png|jpe?g)$/i.test(hit), file: hit };
        }
        return { ok: true, images: out };
    }

    // a picture from the user's own files for one image value: copied in, the value to set handed back
    // The user's own picture for one or more skin.ini keys (one key, or the same part of every column): two PNGs
    // made by the tab from any picture (PNG / JPG / WebP, transparency kept) — @1x and @2x, twice its size — written
    // as <own folder>/custom/<key>-<time>.png and @2x.png; the value for skin.ini comes back with what to warn about.
    async function replaceImage({ id, keys, png1x, png2x } = {}) {
        const dir = workDir(id);
        if (!(await exists(dir))) return { ok: false, message: t("skin.err.noSkin") };
        const list = (Array.isArray(keys) ? keys : [keys]).map(String).filter((k) => fieldByKey.get(k.toLowerCase())?.type === "image");
        if (!list.length) return { ok: false, message: t("skin.err.notImage") };
        const one = toBuffer(png1x);
        const two = toBuffer(png2x);
        const check = checkPicturePair(one, two);
        if (!check.ok) return check;
        const stem = `${OWN_DIR}/custom/${safeName(list[0], "image").replace(/\s+/g, "_")}-${now().toString(36)}`;
        await writeFiles(dir, [{ name: `${stem}.png`, data: one }, { name: `${stem}@2x.png`, data: two }]);
        const entry = (await recent.get()).find((e) => e.id === id);
        const warnings = pictureWarnings(check.size, list, entry?.origin === "template");
        return { ok: true, value: stem, keys: list, width: check.size.width, height: check.size.height, warnings };
    }

    async function exportList(id, ini) {
        const saved = await save({ id, ini });
        if (!saved.ok) throw new Error(saved.message);
        const dir = workDir(id);
        const files = exportedFiles(await walk(dir), ini, OWN_DIR);
        const name = safeName(getValue(parseSkinIni(ini), "General", "Name") || (await session(id)).name);
        return { dir, files, name };
    }

    // a name in the skins folder that is not taken: name.osk, then name (2).osk and so on
    async function freeName(base, ext) {
        await fs.mkdir(outDir, { recursive: true });
        for (let i = 1; i < 1000; i += 1) {
            const target = path.join(outDir, `${base}${i > 1 ? ` (${i})` : ""}${ext}`);
            if (!(await exists(target))) return target;
        }
        throw new Error(t("skin.err.noName"));
    }

    async function exportOsk({ id, ini, open: openIt = true } = {}) {
        const { dir, files, name } = await exportList(id, ini);
        const data = packOsk(await Promise.all(files.map(async (rel) => ({ name: rel, data: await fs.readFile(path.join(dir, ...rel.split("/"))) }))));
        const target = await freeName(name, ".osk");
        await fs.writeFile(target, data);
        log(`skin: exported ${path.basename(target)} (${files.length} files)`);
        // osu! stable and lazer import an .osk opened with them
        const opened = openIt && shell ? await shell.openPath(target) : "";
        return { ok: true, file: target, files: files.length, opened: !opened };
    }

    async function saveCopy({ id, ini } = {}) {
        const { dir, files, name } = await exportList(id, ini);
        const target = await freeName(name, "");
        for (const rel of files) {
            const to = path.join(target, ...rel.split("/"));
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.copyFile(path.join(dir, ...rel.split("/")), to);
        }
        shell?.showItemInFolder?.(target);
        return { ok: true, dir: target, files: files.length };
    }

    // Interlude: only for a skin made with the builder (an edited osu! skin goes on in Interlude's own editor)
    async function exportInterlude({ id, ini } = {}) {
        const entry = (await recent.get()).find((e) => e.id === id);
        if (!entry) return { ok: false, message: t("skin.err.noSkin") };
        if (entry.origin !== "template" || !entry.builder) return { ok: false, message: t("skin.interlude.onlyBuilt") };
        await save({ id, ini });
        const doc = parseSkinIni(ini);
        const cfg = maniaConfig(pairsOf(doc, { mania: 4 }));
        const name = getValue(doc, "General", "Name") || entry.builder.name;
        const author = getValue(doc, "General", "Author") || entry.builder.author;
        // the user's own pictures (in the custom folder) stand in for the drawn ones
        const overrides = {};
        const pairs = pairsOf(doc, { mania: 4 });
        for (const field of MANIA_FIELDS) {
            const value = field.type === "image" ? pairs.get(field.key.toLowerCase())?.value : null;
            if (!value || !value.replace(/\\/g, "/").toLowerCase().startsWith(`${OWN_DIR}/custom/`)) continue;
            const image = await loadPicture(workDir(id), value);
            if (image) overrides[field.key] = image;
        }
        const { entries } = buildInterludeSkin({ ...entry.builder, name, author }, cfg, overrides);
        const target = await freeName(safeName(name), ".isk");
        await fs.writeFile(target, packOsk(entries));
        log(`skin: Interlude ${path.basename(target)}`);
        shell?.showItemInFolder?.(target);
        return { ok: true, file: target };
    }

    async function reopen({ id } = {}) {
        if (!(await exists(workDir(id)))) return { ok: false, message: t("skin.err.noSkin") };
        const entry = (await recent.get()).find((e) => e.id === id);
        if (!entry) return { ok: false, message: t("skin.err.noSkin") };
        await remember({ ...entry, at: now() });
        return session(id);
    }

    const recentList = async () => ({ ok: true, items: (await recent.get()).map(({ id, name, origin, source, at }) => ({ id, name, origin, source, at })) });

    function show({ file } = {}) {
        if (typeof file === "string" && inside(outDir, file)) shell?.showItemInFolder?.(file);
        return { ok: true };
    }

    const safe = (fn) => async (req) => {
        try {
            return await fn(req ?? {});
        } catch (error) {
            log(`skin: ${error?.message}`);
            return fail(error);
        }
    };

    return {
        list: safe(list), open: safe(open), importArchive: safe(importArchive), create: safe(create), build: safe(build),
        save: safe(save), images: safe(images), replaceImage: safe(replaceImage), exportOsk: safe(exportOsk),
        saveCopy: safe(saveCopy), exportInterlude: safe(exportInterlude), reopen: safe(reopen), recent: safe(recentList),
        show: safe(show), defaults: async () => ({ ok: true, options: normalizeOptions({}) }),
        paths: { workRoot, outDir },
    };
}

export function registerSkinIpc({ ipcMain, paths, shell, dialog, window, log, tosu }) {
    // made on the first call: registering does no I/O and reads no paths
    let service = null;
    const get = () => (service ??= createSkinService({ userData: paths.userData, docsDir: paths.docsDir, port: tosu.port, shell, dialog, window, log }));
    const s = new Proxy({}, { get: (_t, key) => (req) => get()[key](req) });
    ipcMain.handle("skin-list", () => s.list());
    ipcMain.handle("skin-open", (_e, req) => s.open(req));
    ipcMain.handle("skin-import", (_e, req) => s.importArchive(req));
    ipcMain.handle("skin-create", (_e, req) => s.create(req));
    ipcMain.handle("skin-build", (_e, req) => s.build(req));
    ipcMain.handle("skin-save", (_e, req) => s.save(req));
    ipcMain.handle("skin-images", (_e, req) => s.images(req));
    ipcMain.handle("skin-replace-image", (_e, req) => s.replaceImage(req));
    ipcMain.handle("skin-export-osk", (_e, req) => s.exportOsk(req));
    ipcMain.handle("skin-save-copy", (_e, req) => s.saveCopy(req));
    ipcMain.handle("skin-export-interlude", (_e, req) => s.exportInterlude(req));
    ipcMain.handle("skin-reopen", (_e, req) => s.reopen(req));
    ipcMain.handle("skin-recent", () => s.recent());
    ipcMain.handle("skin-show", (_e, req) => s.show(req));
    ipcMain.handle("skin-defaults", () => s.defaults());
}
