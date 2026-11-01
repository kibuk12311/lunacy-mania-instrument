// Where osu! stable is, the pure parts (app/osuFolder.js): any folder in or under the game to the game folder, and what
// Windows knows of it, reg.exe's OEM code page included. No test here runs reg.exe or reads the registry.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gameFolderOf, exeFolder, regValue, decodeReg, associationReader } from "../../app/osuFolder.js";

const COMMAND_KEY = "HKCR\\osustable.File.osz\\shell\\open\\command";

async function tree(t, files) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lm-osu-folder-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const rel of files) {
        const file = path.join(root, rel);
        await mkdir(rel.endsWith("/") ? file : path.dirname(file), { recursive: true });
        if (!rel.endsWith("/")) await writeFile(file, "x");
    }
    return root;
}

test("the game folder is the nearest of the folder and four parents with osu!.exe and a folder of the game's", async (t) => {
    const root = await tree(t, ["osu!/osu!.exe", "osu!/Songs/1 Map/map.osu", "osu!/Songs/a/b/c/d/e/", "osu!/Skins/One/Notes/", "bare/osu!.exe", "bare/Other/"]);
    const game = path.join(root, "osu!");
    assert.equal(await gameFolderOf(game), game);
    assert.equal(await gameFolderOf(`${game}${path.sep}`), game);
    assert.equal(await gameFolderOf(path.join(game, "Songs", "1 Map")), game);
    assert.equal(await gameFolderOf(path.join(game, "Skins", "One", "Notes")), game);
    assert.equal(await gameFolderOf(path.join(game, "Songs", "a", "b", "c")), game, "four parents up");
    assert.equal(await gameFolderOf(path.join(game, "Songs", "a", "b", "c", "d")), null, "five is too far");
    assert.equal(await gameFolderOf(path.join(root, "bare")), null, "an exe with none of the game's folders: lazer's current");
    assert.equal(await gameFolderOf(path.join(root, "bare", "Other")), null);
});

test("each of the game's folders beside the exe is enough, and a Songs that is a file is none", async (t) => {
    for (const part of ["Songs", "Skins", "Data", "Replays"]) {
        const root = await tree(t, ["osu!.exe", `${part}/`]);
        assert.equal(await gameFolderOf(root), root, part);
    }
    const root = await tree(t, ["osu!.exe", "Songs"]);
    assert.equal(await gameFolderOf(root), null);
    const folderNamedExe = await tree(t, ["osu!.exe/", "Songs/"]);
    assert.equal(await gameFolderOf(folderNamedExe), null, "osu!.exe must be a file");
});

test("a copy without the exe: only the folder itself, with Replays, Data\\r or Skins", async (t) => {
    for (const part of ["Replays/", "Data/r/", "Skins/"]) {
        const root = await tree(t, [part]);
        assert.equal(await gameFolderOf(root), root, part);
    }
    const data = await tree(t, ["Data/"]);
    assert.equal(await gameFolderOf(data), null, "Data without r is not a copy");
    const inCopy = await tree(t, ["Replays/x/"]);
    assert.equal(await gameFolderOf(path.join(inCopy, "Replays")), null, "and no walk up to one");
});

test("the walk up goes first: a folder in the game with a Replays or a Skins of its own leads to the game, not to a copy", async (t) => {
    const root = await tree(t, ["osu!/osu!.exe", "osu!/Songs/1 Map/Replays/", "osu!/Skins/One/Skins/"]);
    const game = path.join(root, "osu!");
    assert.equal(await gameFolderOf(path.join(game, "Songs", "1 Map")), game);
    assert.equal(await gameFolderOf(path.join(game, "Skins", "One")), game);
});

test("not a folder at all: null", async () => {
    for (const value of [null, undefined, "", "   ", 5, "relative\\folder"]) assert.equal(await gameFolderOf(value), null, String(value));
});

test("a relative value is no place, however much it would hold: it would mean wherever the app was started from", async () => {
    const stat = async (p) => (p.endsWith("osu!.exe") ? { isFile: () => true, isDirectory: () => false } : { isFile: () => false, isDirectory: () => true });
    assert.equal(await gameFolderOf(String.raw`D:\Games\osu!`, { stat }), String.raw`D:\Games\osu!`, "the same answers do hold a game");
    for (const value of ["osu!", String.raw`Games\osu!`, "..", String.raw`D:Games\osu!`]) assert.equal(await gameFolderOf(value, { stat }), null, value);
});

test("the game at the root of a drive, as a value saved without its backslash", async () => {
    const stat = async (p) => ({
        "Q:\\osu!.exe": { isFile: () => true, isDirectory: () => false },
        "Q:\\Songs": { isFile: () => false, isDirectory: () => true },
    })[p] ?? Promise.reject(new Error("no"));
    assert.equal(await gameFolderOf("Q:", { stat }), "Q:\\");
    assert.equal(await gameFolderOf("Q:\\", { stat }), "Q:\\");
    assert.equal(await gameFolderOf("Q:\\Songs", { stat }), "Q:\\");
});

test("a command's program: quoted, unquoted, spaces, with and without \"%1\"", () => {
    assert.equal(exeFolder(String.raw`"D:\Games\osu!\osu!.exe" "%1"`), String.raw`D:\Games\osu!`);
    assert.equal(exeFolder(String.raw`"D:\My Games\osu! stable\osu!.exe" "%1"`), String.raw`D:\My Games\osu! stable`);
    assert.equal(exeFolder(String.raw`"D:\Games\osu!\osu!.exe"`), String.raw`D:\Games\osu!`);
    assert.equal(exeFolder(String.raw`D:\Games\osu!\osu!.exe "%1"`), String.raw`D:\Games\osu!`);
    assert.equal(exeFolder(String.raw`D:\Games\osu!\osu!.exe %1`), String.raw`D:\Games\osu!`);
    assert.equal(exeFolder(String.raw`D:\My Games\osu! stable\osu!.exe "%1"`), String.raw`D:\My Games\osu! stable`);
    assert.equal(exeFolder(String.raw`D:\Games\osu!\OSU!.EXE`), String.raw`D:\Games\osu!`);
    assert.equal(exeFolder(String.raw`  "D:\osu!.exe" "%1"`), "D:\\");
    assert.equal(exeFolder(String.raw`D:\Games\osu!\osu!.exe D:\Tools\other.exe`), String.raw`D:\Games\osu!`, "the program is the first .exe, not the last");
    assert.equal(exeFolder(String.raw`osu!.exe "%1"`), null, "no folder in it");
    assert.equal(exeFolder("(value not set)"), null);
    assert.equal(exeFolder(""), null);
    assert.equal(exeFolder(null), null);
});

test("reg.exe's answer: the value, whatever the (default) line is called", () => {
    const answer = (line) => `\r\nHKEY_CLASSES_ROOT\\osustable.File.osz\\shell\\open\\command\r\n    ${line}\r\n\r\n`;
    assert.equal(regValue(answer(String.raw`(Default)    REG_SZ    "D:\Games\osu!\osu!.exe" "%1"`)), String.raw`"D:\Games\osu!\osu!.exe" "%1"`);
    assert.equal(regValue(answer(String.raw`(по умолчанию)    REG_SZ    D:\Games\osu!\osu!.exe "%1"`)), String.raw`D:\Games\osu!\osu!.exe "%1"`);
    assert.equal(regValue(answer(String.raw`(Default)    REG_EXPAND_SZ    "D:\osu!\osu!.exe"`)), String.raw`"D:\osu!\osu!.exe"`);
    assert.equal(regValue(answer("OEMCP    REG_SZ    866")), "866");
    assert.equal(regValue(answer("(Default)    REG_SZ    ")), null);
    assert.equal(regValue(""), null);
    assert.equal(regValue(null), null);
});

// "D:\Игры\osu!\osu!.exe" "%1" as a Russian Windows' reg.exe prints it: code page 866
const CYRILLIC_LINE = Buffer.concat([
    Buffer.from("\r\nHKEY_CLASSES_ROOT\\osustable.File.osz\\shell\\open\\command\r\n    (", "latin1"),
    Buffer.from([0xaf, 0xae, 0x20, 0xe3, 0xac, 0xae, 0xab, 0xe7, 0xa0, 0xad, 0xa8, 0xee]), // по умолчанию
    Buffer.from(")    REG_SZ    \"D:\\", "latin1"),
    Buffer.from([0x88, 0xa3, 0xe0, 0xeb]), // Игры
    Buffer.from("\\osu!\\osu!.exe\" \"%1\"\r\n\r\n", "latin1"),
]);

test("the OEM code page: a Cyrillic path comes out whole", () => {
    assert.equal(exeFolder(regValue(decodeReg(CYRILLIC_LINE, 866))), String.raw`D:\Игры\osu!`);
});

test("the OEM table goes first: a Cyrillic path whose bytes happen to be valid UTF-8 is not misread", () => {
    // "D:\сам\osu!.exe" "%1" in code page 866 under an English value name: its с, а, м make one three-byte UTF-8 character
    const line = Buffer.concat([
        Buffer.from("    (Default)    REG_SZ    \"D:\\", "latin1"),
        Buffer.from([0xe1, 0xa0, 0xac]),
        Buffer.from("\\osu!\\osu!.exe\" \"%1\"\r\n", "latin1"),
    ]);
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(line));
    assert.equal(exeFolder(regValue(decodeReg(line, 866))), String.raw`D:\сам\osu!`);
});

test("other code pages: what a TextDecoder knows, UTF-8 on a system set to it, plain ASCII under any", () => {
    assert.equal(decodeReg(Buffer.from("ё"), 65001), "ё", "valid UTF-8 is read as UTF-8");
    assert.equal(decodeReg(Buffer.from("ё"), Number.NaN), "ё", "and so with no code page known");
    assert.equal(decodeReg(Buffer.from([0x83, 0x51]), 932), "ゲ");
    const ascii = Buffer.from(String.raw`    (Default)    REG_SZ    "D:\Games\osu!\osu!.exe" "%1"`);
    assert.equal(regValue(decodeReg(ascii, 437)), String.raw`"D:\Games\osu!\osu!.exe" "%1"`);
    assert.equal(regValue(decodeReg(ascii, Number.NaN)), String.raw`"D:\Games\osu!\osu!.exe" "%1"`);
    assert.equal(decodeReg(Buffer.from([0xe9]), 437), "é", "a page it has no table for reads as Western, not as broken UTF-8: the folder check says the rest");
    assert.equal(decodeReg(null, 866), null);
});

function fakeReg(answers) {
    const calls = [];
    const query = async (args) => {
        calls.push(args);
        const answer = answers[args[0]];
        if (answer instanceof Error) throw answer;
        return answer ?? null;
    };
    return { calls, query };
}
const CODE_PAGE = Buffer.from("\r\nHKEY_LOCAL_MACHINE\\...\r\n    OEMCP    REG_SZ    866\r\n\r\n");
const cp = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage";

test("the association: read through reg.exe with its code page, and kept once found", async () => {
    const reg = fakeReg({ [COMMAND_KEY]: CYRILLIC_LINE, [cp]: CODE_PAGE });
    const read = associationReader({ query: reg.query, platform: "win32" });
    assert.equal(await read(), String.raw`D:\Игры\osu!`);
    assert.equal(await read(), String.raw`D:\Игры\osu!`);
    assert.deepEqual(reg.calls, [[COMMAND_KEY, "/ve"], [cp, "/v", "OEMCP"]], "two questions, once");
});

test("the association: only ever a question, never on another system, a failure is null and asked again", async () => {
    const away = fakeReg({ [COMMAND_KEY]: CYRILLIC_LINE, [cp]: CODE_PAGE });
    assert.equal(await associationReader({ query: away.query, platform: "linux" })(), null);
    assert.deepEqual(away.calls, []);

    const none = fakeReg({});
    const read = associationReader({ query: none.query, platform: "win32" });
    assert.equal(await read(), null);
    assert.deepEqual(none.calls, [[COMMAND_KEY, "/ve"]], "no key: nothing more to ask");
    assert.equal(await read(), null);
    assert.equal(none.calls.length, 2, "nothing found is not kept: osu! may be installed later");

    const broken = fakeReg({ [COMMAND_KEY]: new Error("reg.exe is not there") });
    assert.equal(await associationReader({ query: broken.query, platform: "win32" })(), null);

    const noPage = fakeReg({ [COMMAND_KEY]: Buffer.from(String.raw`    (Default)    REG_SZ    "D:\Games\osu!\osu!.exe" "%1"`), [cp]: new Error("no") });
    assert.equal(await associationReader({ query: noPage.query, platform: "win32" })(), String.raw`D:\Games\osu!`, "plain ASCII needs no code page");

    const nonsense = fakeReg({ [COMMAND_KEY]: Buffer.from("    (Default)    REG_SZ    (value not set)"), [cp]: CODE_PAGE });
    assert.equal(await associationReader({ query: nonsense.query, platform: "win32" })(), null);
});

test("the association: a path that is not plain ASCII, with the code page not read, is a failure: not given, not kept, asked again", async () => {
    for (const noPage of [new Error("reg.exe timed out"), null]) {
        const answers = { [COMMAND_KEY]: CYRILLIC_LINE, [cp]: noPage };
        const reg = fakeReg(answers);
        const read = associationReader({ query: reg.query, platform: "win32" });
        assert.equal(await read(), null, "no path that may read wrong");
        assert.equal(await read(), null);
        assert.equal(reg.calls.length, 4, "nothing was kept");
        answers[cp] = CODE_PAGE;
        assert.equal(await read(), String.raw`D:\Игры\osu!`, "the next read gets it right");
        assert.equal(await read(), String.raw`D:\Игры\osu!`);
        assert.equal(reg.calls.length, 6, "and that one is kept");
    }
});

test("the association: only the path has to be plain, the name printed before it may be in the system's language", async () => {
    const line = Buffer.concat([
        Buffer.from("    (", "latin1"),
        Buffer.from([0xaf, 0xae, 0x20, 0xe3, 0xac, 0xae, 0xab, 0xe7, 0xa0, 0xad, 0xa8, 0xee]), // по умолчанию
        Buffer.from(String.raw`)    REG_SZ    "D:\Games\osu!\osu!.exe" "%1"`, "latin1"),
    ]);
    const reg = fakeReg({ [COMMAND_KEY]: line, [cp]: new Error("no") });
    const read = associationReader({ query: reg.query, platform: "win32" });
    assert.equal(await read(), String.raw`D:\Games\osu!`);
    assert.equal(await read(), String.raw`D:\Games\osu!`);
    assert.equal(reg.calls.length, 2, "kept: plain ASCII reads the same under any page");
});
