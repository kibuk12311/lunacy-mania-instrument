// electron-builder afterPack hook: our icon and version info into the packed Windows exe.
// win.signAndEditExecutable is off because electron-builder's own rcedit comes inside the winCodeSign archive, whose
// macOS symlinks fail to unpack here; without it the exe kept Electron's icon. This runs the npm rcedit instead, on
// win-unpacked before the NSIS and portable targets pack it, so the installer, its shortcuts and the portable exe
// all carry the icon.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// appInfo (electron-builder's AppInfo) → rcedit options; version "0.8.0" → "0.8.0.0" for the fixed version fields.
export function exeResources(appInfo, icon = path.join(root, "build", "icon.ico")) {
    const four = [...String(appInfo.version).split(/[.+-]/).slice(0, 3).map((n) => String(Number.parseInt(n, 10) || 0)), "0"].join(".");
    return {
        icon,
        "file-version": four,
        "product-version": four,
        "version-string": {
            ProductName: appInfo.productName,
            FileDescription: appInfo.productName,
            CompanyName: appInfo.companyName ?? "",
            LegalCopyright: appInfo.copyright ?? "",
            OriginalFilename: `${appInfo.productFilename}.exe`,
            InternalName: appInfo.productFilename,
        },
    };
}

// The Interlude reader must be in the build (extraResources from native/interlude-reader/out/reader): a build made
// before `npm run build:reader` would ship without it and the live card / overlay would never start. → the missing
// part's description, or null
export function readerMissing(appOutDir, { exists = existsSync, list = (d) => readdirSync(d) } = {}) {
    const dir = path.join(appOutDir, "resources", "interlude-reader");
    if (!exists(path.join(dir, "interlude-reader.exe"))) return `${path.join(dir, "interlude-reader.exe")} (run npm run build:reader first)`;
    let dacs = [];
    try {
        dacs = list(path.join(dir, "dac")).filter((v) => exists(path.join(dir, "dac", v, "mscordaccore.dll")));
    } catch {
        // no dac folder
    }
    return dacs.length ? null : `${path.join(dir, "dac", "<version>", "mscordaccore.dll")} (run npm run build:reader first)`;
}

// The keyboard reader too (extraResources from native/key-reader/out): without it osu! stable's key lines would fall
// back to the judgements for everyone. → the missing file's description, or null
export function keyReaderMissing(appOutDir, { exists = existsSync } = {}) {
    const exe = path.join(appOutDir, "resources", "key-reader", "key-reader.exe");
    return exists(exe) ? null : `${exe} (run npm run build:keys first)`;
}

// The files of an app.asar, "/" between folders, from its header: past three size fields, at byte 12 the length of the
// JSON that starts at byte 16 (padding after it).
export function asarFiles(file) {
    const bytes = readFileSync(file);
    const names = (files, at) => Object.entries(files).flatMap(([name, entry]) => (entry.files ? names(entry.files, `${at}${name}/`) : [`${at}${name}`]));
    return names(JSON.parse(bytes.toString("utf8", 16, 16 + bytes.readUInt32LE(12))).files, "");
}

// The models' two places: dan_model.json inside app.asar (src/core/model.js reads it by URL, the analyzer fingerprint
// hashes it), the big ones beside it (appModelDir, app/generatorJobs.js). `files` and extraResources decide that and
// nothing else looks: a rule gone wrong would ship every copy without its dan model, or put 50 MB back into each
// update. → the description of what is wrong, or null
export function modelsMisplaced(appOutDir, { inAsar = asarFiles, list = (d) => readdirSync(d) } = {}) {
    const asar = path.join(appOutDir, "resources", "app.asar");
    const beside = path.join(appOutDir, "resources", "models");
    let files;
    try {
        files = inAsar(asar);
    } catch (error) {
        return `${asar} does not read: ${error.message}`;
    }
    if (!files.includes("models/dan_model.json")) return `models/dan_model.json is not in ${asar}`;
    const inside = files.find((f) => f.startsWith("models/") && f.endsWith(".json") && f !== "models/dan_model.json");
    if (inside) return `${inside} is in ${asar}, its place is ${beside}`;
    let there = [];
    try {
        there = list(beside);
    } catch {
        // no folder
    }
    const gone = ["critic.json", "mapper.json"].find((name) => !there.includes(name));
    if (gone) return `${path.join(beside, gone)} (a build needs the models in models/)`;
    return there.includes("dan_model.json") ? `${path.join(beside, "dan_model.json")}: a copy, its place is ${asar} alone` : null;
}

export default async function afterPack(context) {
    if (context.electronPlatformName !== "win32") return;
    const missing = readerMissing(context.appOutDir);
    if (missing) throw new Error(`afterPack: the Interlude reader is missing: ${missing}`);
    const keysMissing = keyReaderMissing(context.appOutDir);
    if (keysMissing) throw new Error(`afterPack: the keyboard reader is missing: ${keysMissing}`);
    const misplaced = modelsMisplaced(context.appOutDir);
    if (misplaced) throw new Error(`afterPack: the models are in the wrong place: ${misplaced}`);
    const { appInfo } = context.packager;

    const exe = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
    const { rcedit } = await import("rcedit");
    await rcedit(exe, exeResources(appInfo));
    console.log(`  • afterPack: icon and version ${appInfo.version} → ${path.basename(exe)}`);
}
