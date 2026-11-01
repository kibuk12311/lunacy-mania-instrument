// Where osu! stable is, for the tabs that read it (app/replayIpc.js, app/skinIpc.js): the check that leads any folder in or
// under the game to the game folder, and what Windows knows, the program stable's .osz files open with (asked of reg.exe,
// only ever read). lazer registers .osz under another name, so what comes from here is stable's or nothing.
import path from "node:path";
import * as nodeFs from "node:fs/promises";
import { execFile } from "node:child_process";

const PARENTS_MAX = 4; // a skin's Notes folder is three up from the game
const GAME_PARTS = ["Songs", "Skins", "Data", "Replays"]; // beside osu!.exe: lazer's current folder has the exe and none of these
const COPY_PARTS = ["Replays", path.join("Data", "r"), "Skins"]; // a copy of the game's folders, without the exe
const REG_EXE = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
const REG_TIMEOUT_MS = 4000;
const OSZ_COMMAND = "HKCR\\osustable.File.osz\\shell\\open\\command";
const CODE_PAGES = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage";
// The OEM code pages a TextDecoder has. Western ones have none: non-ASCII there reads wrong, so the folder check turns it down.
const OEM_LABELS = { 866: "ibm866", 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5" };

const isDir = async (p, fs) => Boolean((await fs.stat(p).catch(() => null))?.isDirectory());
const isFile = async (p, fs) => Boolean((await fs.stat(p).catch(() => null))?.isFile());

async function holdsGame(dir, fs) {
    if (!(await isFile(path.join(dir, "osu!.exe"), fs))) return false;
    for (const part of GAME_PARTS) if (await isDir(path.join(dir, part), fs)) return true;
    return false;
}

// The game folder a folder leads to, or null: the nearest of it and PARENTS_MAX parents holding the game, else the folder
// itself when it is a copy. (The separator added: a value saved as "D:" is that drive's root, not its current folder.)
export async function gameFolderOf(folder, fs = nodeFs) {
    if (typeof folder !== "string" || !folder.trim()) return null;
    const given = `${folder.trim()}${path.sep}`;
    if (!path.isAbsolute(given)) return null;
    const start = path.resolve(given);
    let dir = start;
    for (let up = 0; up <= PARENTS_MAX; up += 1) {
        if (await holdsGame(dir, fs)) return dir;
        if (path.dirname(dir) === dir) break;
        dir = path.dirname(dir);
    }
    for (const part of COPY_PARTS) if (await isDir(path.join(start, part), fs)) return start;
    return null;
}

// A shell\open\command → the folder of its program, or null: quoted or not, spaces and "%1" or nothing after it.
export function exeFolder(command) {
    const m = /^\s*(?:"([^"]+)"|(.+?\.exe)(?=\s|$))/i.exec(String(command ?? ""));
    const exe = m?.[1] ?? m?.[2];
    return exe && path.win32.isAbsolute(exe) ? path.win32.dirname(exe) : null;
}

// reg.exe's answer → the value it prints, or null. The name before it is in the system's language, the type is not.
export const regValue = (text) => /\bREG(?:_EXPAND)?_SZ[ \t]+(.*\S)/.exec(String(text ?? ""))?.[1] ?? null;

// reg.exe's bytes → text: the system's OEM code page when there is a table for it, else UTF-8 (a system set to it), else
// Western. The table goes first: OEM bytes of a Cyrillic path can happen to be valid UTF-8.
export function decodeReg(bytes, codePage) {
    if (!bytes) return null;
    for (const label of [OEM_LABELS[codePage], "utf-8", "windows-1252"].filter(Boolean)) {
        try {
            return new TextDecoder(label, { fatal: true }).decode(bytes);
        } catch {
            // the next one
        }
    }
    return null;
}

export const regQuery = (args) => new Promise((resolve) => {
    execFile(REG_EXE, ["query", ...args], { encoding: "buffer", windowsHide: true, timeout: REG_TIMEOUT_MS }, (error, stdout) => resolve(error ? null : stdout));
});

// () → the folder of the program stable's .osz files open with, or null (Windows only, a failure is null). It may be gone
// since: it goes through gameFolderOf like any other. Once found it is kept for the app's run; until then it is asked again,
// as osu! may be installed meanwhile. A path that is not plain ASCII needs the code page: with none read it is a failure too.
export function associationReader({ query = regQuery, platform = process.platform } = {}) {
    let known = null;
    async function codePage() {
        return Number(regValue(decodeReg(await query([CODE_PAGES, "/v", "OEMCP"]).catch(() => null), null)));
    }
    return async () => {
        if (known || platform !== "win32") return known;
        try {
            const bytes = await query([OSZ_COMMAND, "/ve"]);
            if (!bytes) return null;
            const page = await codePage();
            const value = regValue(decodeReg(bytes, page));
            if (!page && /[^ -~]/.test(value)) return null;
            known = exeFolder(value);
            return known;
        } catch {
            return null;
        }
    };
}

// the app's one reader, the Replay and Skin tabs' both
export const osuAssociation = associationReader();
