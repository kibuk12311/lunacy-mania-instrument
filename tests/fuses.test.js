// What keeps the packed program from being changed by hand: the fuses in the exe and the hash of app.asar it carries
// (tools/fuses.mjs), the build check that stops an exe without them (tools/after-build.mjs), and the package.json
// settings both read. The exes here are made-up bytes with a fuse wire in them, the way Electron's exe has one.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import afterAllArtifactBuild from "../tools/after-build.mjs";
import { FUSE_NAMES, asarHeaderHash, embeddedAsarHash, fusesWrong, packedWrong, readFuses } from "../tools/fuses.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const WANTED = pkg.build.electronFuses;
const ON = 0x31;
const OFF = 0x30;
// the wire in the order of FUSE_NAMES: runAsNode, cookie encryption, NODE_OPTIONS, --inspect, asar integrity, only app.asar,
// browser V8 snapshot, file protocol privileges
const OPEN = [ON, OFF, ON, ON, OFF, OFF, OFF, ON]; // what a stock Electron exe has
const PROTECTED = [OFF, OFF, OFF, OFF, ON, ON, OFF, ON]; // what build.electronFuses makes of it

// an exe: code, the fuse wire (version 1, its length, a state byte each), more code, and the integrity resource if any
const exeBytes = (states, integrity = null, { version = 1 } = {}) => Buffer.concat([
    Buffer.from("MZ the code before"),
    Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), Buffer.from([version, states.length, ...states]),
    Buffer.from("the code after"),
    integrity ? Buffer.from(`[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${integrity}"}]`) : Buffer.alloc(0),
]);
// an app.asar as electron-builder writes it: a pickled size, the JSON header pickled and padded to 4 bytes, the files
function asarBytes(files, body = "the files") {
    const json = Buffer.from(JSON.stringify({ files }));
    const padded = (json.length + 3) & ~3;
    const head = Buffer.alloc(16 + padded);
    [4, 8 + padded, 4 + padded, json.length].forEach((size, i) => head.writeUInt32LE(size, i * 4));
    json.copy(head, 16);
    return Buffer.concat([head, Buffer.from(body)]);
}
const ASAR = asarBytes({ "main.js": { size: 9, offset: "0" } });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HEADER_HASH = sha(Buffer.from(JSON.stringify({ files: { "main.js": { size: 9, offset: "0" } } })));

async function withDir(body) {
    const dir = await mkdtemp(path.join(tmpdir(), "lm-fuses-"));
    try {
        return await body(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
// a build output folder as electron-builder leaves it: win-unpacked\Lunacy mania.exe and resources\app.asar
async function unpacked(dir, exe, asar = ASAR) {
    const folder = path.join(dir, "win-unpacked");
    await mkdir(path.join(folder, "resources"), { recursive: true });
    await writeFile(path.join(folder, "Lunacy mania.exe"), exe);
    await writeFile(path.join(folder, "resources", "app.asar"), asar);
    return folder;
}

test("the fuse wire is read by name: on, off, and what is neither", () => {
    assert.deepEqual(readFuses(exeBytes(PROTECTED)), {
        runAsNode: false, enableCookieEncryption: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, loadBrowserProcessSpecificV8Snapshot: false, grantFileProtocolExtraPrivileges: true,
    });
    assert.equal(readFuses(exeBytes(OPEN)).onlyLoadAppFromAsar, false);
    assert.equal(readFuses(exeBytes([0x72, ...OPEN.slice(1)])).runAsNode, null, "a removed fuse is not on or off");
    assert.equal(readFuses(exeBytes([0x90, ...OPEN.slice(1)])).runAsNode, null, "nor one left to inherit");
    const short = readFuses(exeBytes(OPEN.slice(0, 5)));
    assert.equal(short.enableEmbeddedAsarIntegrityValidation, false);
    assert.equal(short.onlyLoadAppFromAsar, null, "a wire shorter than the names has no state for the rest");
    assert.deepEqual(Object.keys(readFuses(exeBytes(OPEN))), FUSE_NAMES);
});

test("no fuse wire, or one of a version we do not know, reads as none", () => {
    assert.equal(readFuses(Buffer.from("MZ an exe that is not Electron's")), null);
    assert.equal(readFuses(exeBytes(OPEN, null, { version: 2 })), null);
});

test("fusesWrong names each fuse that is not as wanted, and leaves the ones nobody asked for", () => {
    assert.equal(fusesWrong(readFuses(exeBytes(PROTECTED)), WANTED), null);
    const open = fusesWrong(readFuses(exeBytes(OPEN)), WANTED);
    for (const what of [
        "runAsNode is on, it must be off", "enableNodeOptionsEnvironmentVariable is on, it must be off", "enableNodeCliInspectArguments is on, it must be off",
        "enableEmbeddedAsarIntegrityValidation is off, it must be on", "onlyLoadAppFromAsar is off, it must be on",
    ]) assert.ok(open.includes(what), `${what} in: ${open}`);
    assert.ok(!open.includes("enableCookieEncryption"), "not asked for, not named");
    // one wrong
    const onlyOne = fusesWrong(readFuses(exeBytes([OFF, OFF, OFF, OFF, ON, OFF, OFF, ON])), WANTED);
    assert.equal(onlyOne, "onlyLoadAppFromAsar is off, it must be on");
    // a fuse that is not set at all is not "off"
    assert.equal(fusesWrong(readFuses(exeBytes([OFF, OFF, OFF, OFF, 0x72, ON, OFF, ON])), WANTED), "enableEmbeddedAsarIntegrityValidation is not set, it must be on");
    assert.match(fusesWrong(null, WANTED), /no fuse wire/);
    assert.equal(fusesWrong(readFuses(exeBytes(OPEN)), { resetAdHocDarwinSignature: true, somethingNew: false }), null, "options that are not fuses are not checked");
});

test("the hash Electron compares is the hash of app.asar's header, whatever is in the files", () => {
    assert.equal(asarHeaderHash(ASAR), HEADER_HASH);
    assert.equal(asarHeaderHash(asarBytes({ "main.js": { size: 9, offset: "0" } }, "ANOTHER FILE BODY, LONGER")), HEADER_HASH, "the files are not in the hash");
    assert.notEqual(asarHeaderHash(asarBytes({ "main.js": { size: 9, offset: "0" }, "extra.js": { size: 1, offset: "9" } })), HEADER_HASH, "a changed header is");
});

test("the integrity value an exe carries is found, and only a real one", () => {
    assert.equal(embeddedAsarHash(exeBytes(PROTECTED, HEADER_HASH)), HEADER_HASH);
    assert.equal(embeddedAsarHash(exeBytes(PROTECTED)), null, "none written");
    assert.equal(embeddedAsarHash(exeBytes(PROTECTED, "not-a-sha-256-value")), null);
    assert.equal(embeddedAsarHash(exeBytes(PROTECTED, "A".repeat(64))), null, "lower-case hex only, as written");
});

test("packedWrong: the fuses, the integrity resource and that it is this app.asar's", async () => {
    await withDir(async (dir) => {
        const exe = path.join(dir, "Lunacy mania.exe");
        const asar = path.join(dir, "app.asar");
        await writeFile(asar, ASAR);
        const check = async (bytes, wanted = WANTED) => { await writeFile(exe, bytes); return packedWrong(exe, asar, wanted); };
        assert.equal(await check(exeBytes(PROTECTED, HEADER_HASH)), null);
        assert.match(await check(exeBytes(OPEN, HEADER_HASH)), /Lunacy mania\.exe: runAsNode is on/, "stock fuses, named with the exe");
        assert.match(await check(exeBytes(PROTECTED)), /carries no integrity value/);
        const other = sha(Buffer.from("some other archive's header"));
        const mismatch = await check(exeBytes(PROTECTED, other));
        assert.ok(mismatch.includes(other) && mismatch.includes(HEADER_HASH), `both values named: ${mismatch}`);
        // the integrity resource is looked for only when the integrity fuse is wanted
        assert.equal(await check(exeBytes([OFF, OFF, OFF, OFF, OFF, OFF, OFF, ON]), { runAsNode: false }), null);
    });
});

test("the build hook passes a packed exe that is as wanted, and stops one that is not", async () => {
    const config = { productName: "Lunacy mania", electronFuses: WANTED };
    await withDir(async (dir) => {
        await unpacked(dir, exeBytes(PROTECTED, HEADER_HASH));
        assert.deepEqual(await afterAllArtifactBuild({ outDir: dir, configuration: config }), []);
    });
    await withDir(async (dir) => {
        await unpacked(dir, exeBytes(OPEN, HEADER_HASH));
        await assert.rejects(afterAllArtifactBuild({ outDir: dir, configuration: config }), /afterAllArtifactBuild: .*onlyLoadAppFromAsar is off/);
    });
    await withDir(async (dir) => {
        await unpacked(dir, exeBytes(PROTECTED, HEADER_HASH), asarBytes({ "main.js": { size: 9, offset: "0" }, "edited.js": { size: 1, offset: "9" } }));
        await assert.rejects(afterAllArtifactBuild({ outDir: dir, configuration: config }), /carries the integrity value/);
    });
    await withDir(async (dir) => {
        await assert.rejects(afterAllArtifactBuild({ outDir: dir, configuration: config }), /Lunacy mania\.exe is not there to check/);
        await assert.rejects(afterAllArtifactBuild({ outDir: dir, configuration: { productName: "Lunacy mania" } }), /build\.electronFuses is not set/);
    });
});

test("build config: the exe is packed with the fuses that keep app.asar from being changed", () => {
    assert.deepEqual(WANTED, {
        runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
    });
    assert.ok(WANTED.enableEmbeddedAsarIntegrityValidation && WANTED.onlyLoadAppFromAsar, "the two go together: a checked app.asar can be walked round with an app folder, an app folder can only be refused if app.asar is the only place");
    assert.ok(Object.keys(WANTED).every((name) => FUSE_NAMES.includes(name)), "only names electron-builder knows");
    assert.equal(pkg.build.asar, true, "integrity is of app.asar");
    assert.equal(pkg.build.afterAllArtifactBuild, "tools/after-build.mjs");
    assert.ok(existsSync(path.join(root, pkg.build.afterAllArtifactBuild)));
});
