// The afterPack hook (tools/after-pack.mjs): what rcedit writes into the packed exe, and the build config that runs it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import afterPack, { exeResources } from "../tools/after-pack.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const APP = { productName: "Lunacy mania", productFilename: "Lunacy mania", version: "0.8.0", companyName: "Sneezey", copyright: "Copyright © 2026 Sneezey" };

test("icon and version info for the exe", () => {
    const r = exeResources(APP, "icon.ico");
    assert.equal(r.icon, "icon.ico");
    assert.equal(r["file-version"], "0.8.0.0");
    assert.equal(r["product-version"], "0.8.0.0");
    assert.deepEqual(r["version-string"], {
        ProductName: "Lunacy mania", FileDescription: "Lunacy mania", CompanyName: "Sneezey",
        LegalCopyright: "Copyright © 2026 Sneezey", OriginalFilename: "Lunacy mania.exe", InternalName: "Lunacy mania",
    });
    assert.equal(exeResources({ ...APP, version: "1.2.3-beta.4" })["file-version"], "1.2.3.0");
    assert.equal(path.basename(exeResources(APP).icon), "icon.ico");
});

test("only Windows packs are edited", async () => {
    await afterPack({ electronPlatformName: "darwin", appOutDir: "nowhere", packager: { appInfo: APP } });
});

test("build config: the hook runs, both Windows targets, updates published to our GitHub repo", () => {
    const b = pkg.build;
    assert.equal(b.afterPack, "tools/after-pack.mjs");
    assert.equal(b.appId, "io.github.kibuk12311.lunacymania");
    assert.equal(pkg.name, "dan-analyzer", "the userData folder stays the same");
    assert.deepEqual(b.win.target.map((x) => [x.target, x.arch]), [["nsis", ["x64"]], ["portable", ["x64"]]]);
    assert.equal(b.nsis.perMachine, false);
    assert.equal(b.nsis.oneClick, false);
    assert.equal(b.nsis.deleteAppDataOnUninstall, false);
    assert.equal(b.nsis.artifactName, "Lunacy-mania-Setup-${version}.exe");
    assert.equal(b.portable.artifactName, "Lunacy-mania-Portable-${version}.exe");
    assert.deepEqual(b.publish, [{ provider: "github", owner: "kibuk12311", repo: "lunacy-mania-instrument", releaseType: "release" }]);
    assert.match(pkg.scripts.dist, /--publish never/);
    assert.match(pkg.dependencies["electron-updater"], /^6\.\d+\.\d+$/, "pinned exactly");
    const ffmpeg = b.extraResources.find((r) => r.to === "ffmpeg");
    assert.deepEqual(ffmpeg.filter, ["ffmpeg.exe", "ffmpeg.exe.LICENSE", "ffmpeg.exe.README"]);
    assert.deepEqual(b.extraFiles, ["LICENSE", "THIRD_PARTY_NOTICES.md"]);
});
