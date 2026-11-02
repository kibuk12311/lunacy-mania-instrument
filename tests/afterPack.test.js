// The afterPack hook (tools/after-pack.mjs): what rcedit writes into the packed exe, and the build config that runs it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import afterPack, { asarFiles, exeResources, keyReaderMissing, modelsMisplaced, readerMissing } from "../tools/after-pack.mjs";
import { readerPath, READER_EXE } from "../app/interludeReader.js";
import { keyReaderPath, KEY_READER_EXE } from "../app/keyReader.js";
import { CLASSIC_FILE, MODEL_FILES, CRITIC_FILE } from "../app/generatorJobs.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const APP = { productName: "Lunacy mania", productFilename: "Lunacy mania", version: "0.8.0", companyName: "Sneezey", copyright: "Copyright © 2026 Sneezey" };
// an app.asar as electron-builder writes it: a pickled size, the JSON header pickled and padded to 4 bytes, the files
function asarBytes(files) {
    const json = Buffer.from(JSON.stringify({ files }));
    const padded = (json.length + 3) & ~3;
    const head = Buffer.alloc(16 + padded);
    [4, 8 + padded, 4 + padded, json.length].forEach((size, i) => head.writeUInt32LE(size, i * 4));
    json.copy(head, 16);
    return Buffer.concat([head, Buffer.from("the files")]);
}

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

test("the Interlude reader ships as an extra resource where the app looks for it, from where a dev run finds it", () => {
    const reader = pkg.build.extraResources.find((r) => r.to === "interlude-reader");
    assert.equal(reader.from, "native/interlude-reader/out/reader");
    assert.deepEqual(reader.filter, ["interlude-reader.exe", "dac/**"]);
    // packaged: resources\interlude-reader\interlude-reader.exe; dev: the same folder electron-builder copies from
    assert.equal(readerPath({ packaged: true, resourcesPath: "R:\app\resources", appDir: "x" }), path.join("R:\app\resources", "interlude-reader", READER_EXE));
    assert.equal(path.resolve(readerPath({ packaged: false, appDir: path.join(root, "app") })), path.resolve(root, reader.from, READER_EXE));
    assert.match(pkg.scripts["build:reader"], /native\/interlude-reader\/build\.ps1/);
});

test("afterPack refuses a build without the reader or its DAC", () => {
    const out = "W:\win-unpacked";
    const dir = path.join(out, "resources", "interlude-reader");
    const have = (files) => ({ exists: (f) => files.includes(f), list: () => ["9.0.22"] });
    assert.match(readerMissing(out, have([])), /interlude-reader\.exe.*build:reader/);
    assert.match(readerMissing(out, have([path.join(dir, "interlude-reader.exe")])), /mscordaccore\.dll/);
    assert.equal(readerMissing(out, have([path.join(dir, "interlude-reader.exe"), path.join(dir, "dac", "9.0.22", "mscordaccore.dll")])), null);
});

test("the keyboard reader ships as an extra resource where the app looks for it, from where a dev run finds it", () => {
    const keys = pkg.build.extraResources.find((r) => r.to === "key-reader");
    assert.equal(keys.from, "native/key-reader/out");
    assert.deepEqual(keys.filter, ["key-reader.exe"], "the exe alone");
    assert.equal(keyReaderPath({ packaged: true, resourcesPath: "R:\app\resources", appDir: "x" }), path.join("R:\app\resources", "key-reader", KEY_READER_EXE));
    assert.equal(path.resolve(keyReaderPath({ packaged: false, appDir: path.join(root, "app") })), path.resolve(root, keys.from, KEY_READER_EXE));
    assert.match(pkg.scripts["build:keys"], /native\/key-reader\/build\.ps1/);
});

test("the big models ship beside the asar, where a code change leaves their bytes alone; the dan model stays inside it", () => {
    const b = pkg.build;
    const glob = (g) => new RegExp(`^${g.replace(/\./g, "\\.").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replaceAll("\0", ".*")}$`);
    // a files / filter list: later rules go over earlier ones
    const keeps = (rules, file) => rules.reduce((on, rule) => (rule.startsWith("!") ? on && !glob(rule.slice(1)).test(file) : on || glob(rule).test(file)), false);
    const models = b.extraResources.find((r) => r.to === "models");
    assert.equal(models?.from, "models");
    for (const name of [...MODEL_FILES, CRITIC_FILE]) {
        assert.equal(keeps(b.files, `models/${name}`), false, `${name} out of the asar`);
        assert.equal(keeps(models.filter, name), true, `${name} in resources/models`);
    }
    assert.equal(keeps(b.files, "models/dan_model.json"), true, "src/core/model.js reads it by URL, the analyzer fingerprint hashes it");
    assert.equal(keeps(models.filter, "dan_model.json"), false, "in the asar alone");
    assert.equal(keeps(models.filter, "mapper-nn3-xl.json"), true, "a new mapper file ships");
    // electron-builder runs the filter over the app files too, as an exclude list with each rule joined to the folder:
    // models/<rule> in POSIX form, models\<rule> on Windows, which minimatch reads with the backslash gone. A "!" rule
    // is no negation there (models/!name), so every rule has to miss the dan model by what it names
    for (const rule of models.filter) {
        assert.equal(rule.startsWith("!"), false, `${rule} is no negation once joined`);
        for (const joined of [`${models.from}/${rule}`, `${models.from}${rule}`]) {
            assert.equal(glob(joined).test("models/dan_model.json"), false, `${joined} would take the dan model out of the asar`);
        }
    }
    assert.equal(keeps(b.files, "models/archive/mapper-v1.json"), false, "the archive stays out of the build");
    assert.equal(keeps(models.filter, "archive/mapper-v1.json"), false, "the archive stays out of the build");
    assert.deepEqual(b.extraResources.map((r) => r.to), ["tosu", "ffmpeg", "interlude-reader", "key-reader", "models"]);
});

test("afterPack refuses a build without the keyboard reader", () => {
    const out = "W:\win-unpacked";
    const exe = path.join(out, "resources", "key-reader", "key-reader.exe");
    assert.match(keyReaderMissing(out, { exists: () => false }), /key-reader\.exe.*build:keys/);
    assert.equal(keyReaderMissing(out, { exists: (f) => f === exe }), null);
});

test("afterPack refuses a build with the models in the wrong place", () => {
    const out = "W:\\win-unpacked";
    const check = (files, beside) => modelsMisplaced(out, { inAsar: () => files, list: () => beside });
    const asar = ["app/main.js", "models/dan_model.json"];
    const big = [CRITIC_FILE, CLASSIC_FILE];
    assert.equal(check(asar, big), null, "the two the app cannot do without are enough");
    assert.equal(check(asar, [...MODEL_FILES, CRITIC_FILE]), null);
    assert.equal(check([...asar, "vendor/leoblack/models/x.json", "models/notes.txt"], big), null, "only a .json under the asar's models folder is a model");

    assert.match(check(["app/main.js"], big), /models\/dan_model\.json/);
    assert.match(check(["app/main.js", "src/models/dan_model.json"], big), /models\/dan_model\.json/, "its own path, not one like it");
    assert.match(check([...asar, `models/${CLASSIC_FILE}`], big), /models\/mapper\.json/);
    assert.match(check([...asar, "models/archive/mapper-v1.json"], big), /models\/archive\/mapper-v1\.json/);
    assert.match(check(asar, [CLASSIC_FILE]), /critic\.json/);
    assert.match(check(asar, [CRITIC_FILE, ...MODEL_FILES.filter((name) => name !== CLASSIC_FILE)]), /mapper\.json/);
    assert.match(check(asar, [...big, "dan_model.json"]), /dan_model\.json/);
    assert.match(modelsMisplaced(out, { inAsar: () => asar, list: () => { throw new Error("no folder"); } }), /critic\.json/);
    assert.match(modelsMisplaced(out, { inAsar: () => { throw new Error("no archive"); }, list: () => big }), /app\.asar.*no archive/);
});

test("the file list of an app.asar, from its header", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lunacy-asar-"));
    const file = path.join(dir, "app.asar");
    const tree = {
        "package.json": { size: 2, offset: "0" },
        app: { files: { "main.js": { size: 2, offset: "2" }, "пустая папка": { files: {} } } },
        node_modules: { unpacked: true, files: { realm: { unpacked: true, files: { "realm.node": { size: 2, unpacked: true } } } } },
    };
    // every padding of the JSON's length
    for (const pad of ["", "x", "xx", "xxx"]) {
        await writeFile(file, asarBytes({ ...tree, [`${pad}.json`]: { size: 0, offset: "4" } }));
        assert.deepEqual(asarFiles(file).sort(), [`${pad}.json`, "app/main.js", "node_modules/realm/realm.node", "package.json"].sort());
    }
    await writeFile(file, "not an archive, and long enough to hold the size fields");
    assert.throws(() => asarFiles(file));
    await rm(dir, { recursive: true, force: true });
});

test("the hook stops a build with the models in the wrong place, from what really is on disk", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "lunacy-after-pack-"));
    const resources = path.join(out, "resources");
    for (const [dir, name] of [["interlude-reader", "interlude-reader.exe"], ["interlude-reader/dac/9.0.22", "mscordaccore.dll"], ["key-reader", "key-reader.exe"], ["models", CRITIC_FILE], ["models", CLASSIC_FILE]]) {
        await mkdir(path.join(resources, dir), { recursive: true });
        await writeFile(path.join(resources, dir, name), "");
    }
    await writeFile(path.join(resources, "app.asar"), asarBytes({ models: { files: { "dan_model.json": { size: 0, offset: "0" } } } }));
    assert.equal(modelsMisplaced(out), null);

    await writeFile(path.join(resources, "app.asar"), asarBytes({ models: { files: { "mapper.json": { size: 0, offset: "0" } } } }));
    await assert.rejects(afterPack({ electronPlatformName: "win32", appOutDir: out, packager: { appInfo: APP } }), /afterPack: .*models\/dan_model\.json/);
    await rm(out, { recursive: true, force: true });
});
