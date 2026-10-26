// electron-builder afterPack hook: our icon and version info into the packed Windows exe.
// win.signAndEditExecutable is off because electron-builder's own rcedit comes inside the winCodeSign archive, whose
// macOS symlinks fail to unpack here; without it the exe kept Electron's icon. This runs the npm rcedit instead, on
// win-unpacked before the NSIS and portable targets pack it, so the installer, its shortcuts and the portable exe
// all carry the icon.
import { existsSync, readdirSync } from "node:fs";
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

export default async function afterPack(context) {
    if (context.electronPlatformName !== "win32") return;
    const missing = readerMissing(context.appOutDir);
    if (missing) throw new Error(`afterPack: the Interlude reader is missing: ${missing}`);
    const { appInfo } = context.packager;

    const exe = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
    const { rcedit } = await import("rcedit");
    await rcedit(exe, exeResources(appInfo));
    console.log(`  • afterPack: icon and version ${appInfo.version} → ${path.basename(exe)}`);
}
