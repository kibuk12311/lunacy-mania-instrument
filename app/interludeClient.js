// Interlude as a source of maps beside osu! stable and lazer (which tosu reads). Interlude has no "now playing"
// API (what is selected and played is read from its memory by app/interludeReader.js); its only outside channel is
// a named pipe "Interlude" that takes "version" and "focus" (interlude/src/Features/Printerlude/Printerlude.fs
// register_ipc_commands), so a file path cannot be handed to it to import. What this does instead:
//   - the folder: picked or found, kept in userData\interlude.json; only Songs\charts.db is required there;
//   - following it live: the same file keeps whether the app reads the running game (app/interludeReader.js, on by
//     default while a folder is linked) and whether that reader may fetch .NET's DAC file once (off by default);
//   - the selection: select(hash) makes a chart of the library the map the tabs work on (picked in the IL
//     panel, or by app/interludeLive.js for what is selected in the running game), copied out with its audio into
//     Documents\<app>\interlude\ like a lazer map, so the tabs that need a folder keep working;
//   - sending a map: the .osz is packed in Documents\<app>\карты, Interlude is brought to the front (the pipe's
//     "focus") or started, and the .osz is shown in Explorer to be dropped onto Interlude's window, which is how
//     Interlude imports (interlude/src/Features/Import/FileDrop.fs). Nothing is put in Songs\ or charts.db;
//   - collections: a playlist or folder added to Data\collections.json, only while Interlude is closed (it writes
//     the file back on exit, Library.Save), after a dated backup, next to everything already there.
import { execFile, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterludeLibrary, interludeFolderOf, folderCandidates, detectFolder, COLLECTIONS_JSON } from "./interludeLibrary.js";
import { packLazerOsz } from "./lazerMaps.js";
import { safeFileName } from "./mapExport.js";
import { addCollection, emptyCollections, parseCollections, stringifyCollections } from "../src/interlude/collections.js";
import { t } from "../src/i18n/i18n.js";

export const PIPE = "\\\\.\\pipe\\Interlude";
export const interludeDirOf = (docsDir) => path.join(docsDir, "interlude");
const statOf = (file) => stat(file).catch(() => null);
const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";

// "20261026-153012" for a backup's name
const stamp = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
    + `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

// Is Interlude.exe running? From the process list (tasklist), read only.
export function isInterludeRunning({ exec = execFile } = {}) {
    return new Promise((resolve) => {
        exec("tasklist", ["/FI", "IMAGENAME eq Interlude.exe", "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
            resolve(!error && /"Interlude\.exe"/i.test(String(stdout)));
        });
    });
}

// "focus" over Interlude's own pipe (what a second launch of Interlude.exe sends). → true when it answered.
export function sendPipe(message, { connect = createConnection, timeoutMs = 1500 } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try {
                socket.destroy();
            } catch {
                // gone
            }
            resolve(ok);
        };
        const socket = connect(PIPE);
        socket.setTimeout?.(timeoutMs, () => finish(false));
        socket.on("connect", () => socket.write(`${message}\n`));
        socket.on("data", () => finish(true));
        socket.on("end", () => finish(true));
        socket.on("error", () => finish(false));
    });
}

// The live settings as kept → { live: true | false | null (null: on while a folder is linked), allowDownload }.
export function liveSettingsOf(saved) {
    return {
        live: typeof saved?.live === "boolean" ? saved.live : null,
        allowDownload: saved?.allowDownload === true,
    };
}

// store: { get, set } of { folder, live, allowDownload }; docsDir, mapsDir, cacheDir: the app's folders; home/env: for finding the folder.
export function createInterludeClient({
    store, docsDir, mapsDir, cacheDir, home = "", env = {}, log = () => {}, onChange = () => {},
    running = () => isInterludeRunning(), pipe = sendPipe, launch = null, reveal = () => {}, now = () => new Date(),
    sqlite,
}) {
    let folder = null; // the linked folder, once read
    let loaded = null;
    let live = liveSettingsOf(null);
    let selection = null; // { hash, path, dir, audioPath, backgroundPath, label } of the chart the tabs work on
    const library = createInterludeLibrary({ folder: () => folder, cacheDir, log, ...(sqlite ? { sqlite } : {}) });

    const ready = () => (loaded ??= store.get().then((s) => {
        folder = typeof s?.folder === "string" ? s.folder : null;
        live = liveSettingsOf(s);
    }, () => {}));
    const save = () => store.set({ folder, ...live });

    async function status() {
        await ready();
        if (!folder) return { linked: false, folder: null, selected: selection ? selection.label : null };
        const ok = await interludeFolderOf(folder);
        if (!ok) return { linked: false, folder, missing: true, message: t("app.interlude.folderGone", { folder }), selected: null };
        let size = null;
        try {
            size = await library.size();
        } catch (error) {
            log(`interlude: library not read: ${error?.message}`);
            return { linked: true, folder, size: null, message: t("app.interlude.dbFailed", { message: error?.message ?? "" }), selected: selection?.label ?? null };
        }
        return { linked: true, folder, size, selected: selection?.label ?? null };
    }

    async function setFolder(dir) {
        folder = dir;
        library.forget();
        if (!dir) selection = null;
        await save();
        log(`interlude: folder ${dir ?? "unlinked"}`);
        onChange();
    }

    async function link(picked) {
        const dir = await interludeFolderOf(picked);
        if (!dir) return { ok: false, message: t("app.interlude.notFolder") };
        await setFolder(dir);
        return { ok: true, ...(await status()) };
    }

    async function detect() {
        const dir = await detectFolder(folderCandidates({ home, env }));
        if (!dir) return { ok: false, message: t("app.interlude.notFound") };
        await setFolder(dir);
        return { ok: true, ...(await status()) };
    }

    const need = async () => {
        await ready();
        if (!folder || !(await interludeFolderOf(folder))) throw new Error(t("app.interlude.noFolder"));
    };

    // The chart copied out into Documents\<app>\interlude\<hash…> <artist - title>\ (the .osu, its audio and
    // background), so whatever needs a folder like stable's (a marathon, a rate copy) can read it.
    // → { meta, path, dir, audioPath, backgroundPath, text, original }
    async function copyOut(hash) {
        await need();
        const osu = await library.osuFor(hash);
        if (!osu) throw new Error(t("app.interlude.noChart"));
        const { meta } = osu;
        const dir = path.join(interludeDirOf(docsDir), safeFileName(`${meta.hash.slice(0, 8)} ${meta.artist} - ${meta.title}`));
        await mkdir(dir, { recursive: true });
        const copyIn = async (from, name) => {
            if (!from || !name || path.basename(name) !== name) return null;
            const to = path.join(dir, name);
            const [a, b] = await Promise.all([statOf(from), statOf(to)]);
            if (!a) return null;
            if (!b || b.size !== a.size) await copyFile(from, to);
            return to;
        };
        const audioPath = await copyIn(osu.audio, osu.audioName);
        const backgroundPath = await copyIn(osu.background, osu.backgroundName);
        const file = path.join(dir, `${safeFileName(`${meta.artist} - ${meta.title} (${meta.creator}) [${meta.version}]`)}.osu`);
        await writeFile(file, osu.text, "utf8");
        return { meta, path: file, dir, audioPath, backgroundPath, text: osu.text, original: osu.original };
    }

    // The chart copied out (copyOut), made the map the tabs work on. → the selection
    async function select(hash) {
        const { meta, path: file, dir, audioPath, backgroundPath, text, original } = await copyOut(hash);
        selection = {
            hash: meta.hash, path: file, dir, audioPath, backgroundPath, text, original,
            label: `${meta.artist} - ${meta.title} [${meta.version}]`,
        };
        log(`interlude: selected ${meta.hash} ${selection.label}${original ? " (original .osu)" : " (made from the chart)"}${audioPath ? "" : ", no audio"}`);
        onChange();
        return selection;
    }

    function clearSelection() {
        if (!selection) return;
        selection = null;
        onChange();
    }

    // Brings Interlude to the front, or starts it. → "focused" | "started" | "none"
    async function wake() {
        if (await running()) return (await pipe("focus")) ? "focused" : "running";
        const exe = folder ? path.join(folder, "Interlude.exe") : null;
        if (!exe || !(await statOf(exe))?.isFile()) return "none";
        try {
            (launch ?? ((file, cwd) => spawn(file, [], { cwd, detached: true, stdio: "ignore" }).unref()))(exe, folder);
            return "started";
        } catch (error) {
            log(`interlude: start failed: ${error?.message}`);
            return "none";
        }
    }

    // An .osz to drop onto Interlude: an .osz as it is (one the app made), or .osu files of one folder packed into
    // one with the files they name. → the .osz path
    async function oszOf(files) {
        const list = files.map((f) => path.resolve(String(f)));
        if (list.length === 1 && list[0].toLowerCase().endsWith(".osz")) return list[0];
        if (!list.length || !list.every((f) => f.toLowerCase().endsWith(".osu"))) throw new Error(t("app.interlude.badFile"));
        const dir = path.dirname(list[0]);
        if (!list.every((f) => path.dirname(f) === dir)) throw new Error(t("app.interlude.badFile"));
        const charts = [];
        for (const f of list) charts.push({ name: path.basename(f), osuText: await readFile(f, "utf8") });
        const first = charts[0].osuText;
        return packLazerOsz({
            charts, dir, outDir: mapsDir,
            baseName: `${field(first, "Artist")} - ${field(first, "Title")}${charts.length === 1 ? ` [${field(first, "Version")}]` : ""} (Interlude)`,
        });
    }

    // files: one .osz, or .osu files from one folder. → { ok, osz, woke, message }
    async function send(files) {
        try {
            await need();
            const osz = await oszOf(Array.isArray(files) ? files : [files]);
            if (!(await statOf(osz))?.isFile()) throw new Error(t("app.noSuchFile"));
            const woke = await wake();
            reveal(osz);
            log(`interlude: send ${osz} (${woke})`);
            const key = woke === "none" ? "app.interlude.sentNoGame" : woke === "started" ? "app.interlude.sentStarted" : "app.interlude.sent";
            return { ok: true, osz, woke, message: t(key, { file: path.basename(osz) }) };
        } catch (error) {
            log(`interlude: send failed: ${error?.message}`);
            return { ok: false, message: String(error?.message ?? error) };
        }
    }

    // A playlist (entries [{ hash, rate }]) or folder added to Data\collections.json. Refused while Interlude runs;
    // the file as it was is kept as collections.json.bak-<date> first. → { ok, name, count, backup, file }
    async function writeCollection({ kind = "playlist", name, entries }) {
        await need();
        if (await running()) return { ok: false, running: true, message: t("app.interlude.closeFirst") };
        const file = path.join(folder, COLLECTIONS_JSON);
        const before = await readFile(file, "utf8").catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
        let data;
        try {
            data = before === null ? emptyCollections() : parseCollections(before);
        } catch (error) {
            return { ok: false, message: t("app.interlude.badCollections", { message: error?.message ?? "" }) };
        }
        const added = addCollection(data, { kind, name, entries });
        let backup = null;
        if (before !== null) {
            backup = `${file}.bak-${stamp(now())}`;
            await copyFile(file, backup);
        }
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, stringifyCollections(added.data), "utf8");
        await rename(`${file}.tmp`, file);
        log(`interlude: ${kind} "${added.name}" with ${added.count} charts → ${file}${backup ? `, backup ${backup}` : ""}`);
        return { ok: true, name: added.name, count: added.count, backup, file };
    }

    // { live, allowDownload, follow }: follow = whether the reader should run now
    async function liveSettings() {
        await ready();
        return { ...live, follow: live.live ?? Boolean(folder) };
    }

    async function setLiveSettings(patch) {
        await ready();
        if (typeof patch?.live === "boolean") live.live = patch.live;
        if (typeof patch?.allowDownload === "boolean") live.allowDownload = patch.allowDownload;
        await save();
        log(`interlude: live ${live.live ?? "default"}, download ${live.allowDownload}`);
        onChange();
        return liveSettings();
    }

    return {
        status, link, detect, liveSettings, setLiveSettings, unlink: () => setFolder(null), select, copyOut, clearSelection, send, writeCollection, wake,
        library, folder: () => folder, ready,
        selection: () => selection,
        // the source the tabs read their map from while an Interlude chart is selected (tosu's beatmap() shape)
        beatmap: () => (selection ? { client: "interlude", path: selection.path, audioPath: selection.audioPath, backgroundPath: selection.backgroundPath, hash: selection.hash } : null),
    };
}
