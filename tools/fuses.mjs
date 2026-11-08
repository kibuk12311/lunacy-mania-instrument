// What decides whether the packed program can be changed by hand. electron-builder flips the "fuses" (switches inside
// the Electron exe) from package.json build.electronFuses and writes the hash of app.asar's header into the exe (the
// ELECTRONASAR resource). With the integrity fuse on, Electron refuses an app.asar that no longer matches that hash;
// with onlyLoadAppFromAsar it does not fall back to an app folder or another archive when app.asar is taken away.
// This reads both back from the packed exe, so a build without them is stopped instead of shipped (tools/after-build.mjs).
// By hand: `node tools/fuses.mjs "dist/win-unpacked/Lunacy mania.exe"`.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the marker in front of the fuse wire inside the exe (@electron/fuses SENTINEL); then: the wire's version, its length,
// one state byte for each fuse
const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
// electron-builder's names of the fuses, in the order of the wire (@electron/fuses FuseV1Options)
export const FUSE_NAMES = [
    "runAsNode", "enableCookieEncryption", "enableNodeOptionsEnvironmentVariable", "enableNodeCliInspectArguments",
    "enableEmbeddedAsarIntegrityValidation", "onlyLoadAppFromAsar", "loadBrowserProcessSpecificV8Snapshot", "grantFileProtocolExtraPrivileges",
];
const ON = 0x31; // "1"
const OFF = 0x30; // "0"; anything else (removed, left to inherit) is neither
// the ELECTRONASAR resource electron-builder writes: [{"file":"resources\\app.asar","alg":"SHA256","value":"<hex>"}]
const INTEGRITY_KEY = Buffer.from('"alg":"SHA256","value":"');

// → { fuseName: true | false | null } for the first fuse wire in an exe's bytes (null: not on or off), or null without one
export function readFuses(bytes) {
    const at = bytes.indexOf(SENTINEL);
    if (at === -1) return null;
    const wire = at + SENTINEL.length;
    if (bytes[wire] !== 1) return null;
    const length = bytes[wire + 1];
    const found = {};
    FUSE_NAMES.forEach((name, i) => {
        const state = i < length ? bytes[wire + 2 + i] : undefined;
        found[name] = state === ON ? true : state === OFF ? false : null;
    });
    return found;
}

const word = (on) => (on === true ? "on" : on === false ? "off" : "not set");

// → what differs between the fuses found and the ones wanted (build.electronFuses), or null when they all agree
export function fusesWrong(found, wanted) {
    if (!found) return "the exe has no fuse wire (is it an Electron exe?)";
    const wrong = FUSE_NAMES.filter((name) => typeof wanted[name] === "boolean" && found[name] !== wanted[name])
        .map((name) => `${name} is ${word(found[name])}, it must be ${word(wanted[name])}`);
    return wrong.length ? wrong.join("; ") : null;
}

// the hash Electron compares: SHA-256 of an app.asar's header (the JSON from byte 16, its length at byte 12)
export function asarHeaderHash(asarBytes) {
    return createHash("sha256").update(asarBytes.subarray(16, 16 + asarBytes.readUInt32LE(12))).digest("hex");
}

// → the integrity value for app.asar an exe carries, or null
export function embeddedAsarHash(exeBytes) {
    const at = exeBytes.indexOf(INTEGRITY_KEY);
    if (at === -1) return null;
    const hex = exeBytes.toString("latin1", at + INTEGRITY_KEY.length, at + INTEGRITY_KEY.length + 64);
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

// → what is wrong with a packed exe and its app.asar against build.electronFuses, or null. With the integrity fuse wanted
// the exe must carry the hash of exactly this app.asar: a start that fails on its own hash would be found by a customer
export async function packedWrong(exe, asar, wanted) {
    const bytes = await readFile(exe);
    const wrong = fusesWrong(readFuses(bytes), wanted);
    if (wrong) return `${exe}: ${wrong}`;
    if (wanted.enableEmbeddedAsarIntegrityValidation !== true) return null;
    const carried = embeddedAsarHash(bytes);
    if (!carried) return `${exe} carries no integrity value for resources\\app.asar`;
    const real = asarHeaderHash(await readFile(asar));
    return carried === real ? null : `${exe} carries the integrity value ${carried}, ${asar} has ${real}`;
}

// node tools/fuses.mjs <exe> [<app.asar, default resources\app.asar beside the exe>]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const exe = process.argv[2];
    if (!exe) {
        console.error("usage: node tools/fuses.mjs <exe> [app.asar]");
        process.exit(2);
    }
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const wanted = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).build.electronFuses ?? {};
    const found = readFuses(readFileSync(exe));
    for (const name of FUSE_NAMES) console.log(`${name.padEnd(40)} ${found ? word(found[name]) : "?"}`);
    const asar = process.argv[3] ?? path.join(path.dirname(exe), "resources", "app.asar");
    const wrong = await packedWrong(exe, asar, wanted);
    console.log(wrong ? `WRONG: ${wrong}` : "as package.json wants it");
    process.exit(wrong ? 1 : 0);
}
