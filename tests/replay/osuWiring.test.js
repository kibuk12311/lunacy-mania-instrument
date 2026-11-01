// The folder search as main.js hangs it: the Replay and Skin tabs registered with nothing of it injected, the local profile's
// real service, the app's one association reader. Only reg.exe's answer is made up (execFile, swapped under
// node:child_process), so no test here touches the registry. The reader keeps what it finds for the process: one install
// for the whole file.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerReplayIpc } from "../../app/replayIpc.js";
import { registerSkinIpc } from "../../app/skinIpc.js";
import { createLocalProfile } from "../../app/localProfileIpc.js";

const realExecFile = childProcess.execFile;
const realLocalAppData = process.env.LOCALAPPDATA;
const calls = [];
let root = null;
let linked = null; // the install Windows knows, under a Cyrillic name

// as a Russian Windows' reg.exe prints it: code page 866, the Cyrillic this file uses
const cp866 = (text) => Buffer.from([...text].map((char) => {
    const code = char.codePointAt(0);
    if (code < 0x80) return code;
    if (code >= 0x410 && code <= 0x43f) return code - 0x410 + 0x80;
    if (code >= 0x440 && code <= 0x44f) return code - 0x440 + 0xe0;
    throw new Error(`not in code page 866 here: ${char}`);
}));

function fakeReg(file, args, options, done) {
    calls.push({ file, args, options });
    const line = args.includes("/ve") ? `(по умолчанию)    REG_SZ    "${path.join(linked, "osu!.exe")}" "%1"` : "OEMCP    REG_SZ    866";
    const bytes = cp866(`\r\n${args[0]}\r\n    ${line}\r\n\r\n`);
    setImmediate(() => done(null, options?.encoding === "buffer" ? bytes : bytes.toString("utf8"), Buffer.alloc(0)));
}

async function install(game) {
    await mkdir(path.join(game, "Songs"), { recursive: true });
    await mkdir(path.join(game, "Skins", "Their Skin"), { recursive: true });
    await writeFile(path.join(game, "osu!.exe"), "exe");
    return game;
}

function handlersOf(register, deps) {
    const handlers = {};
    register({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } }, tosu: {}, log: () => {}, send: () => {}, ...deps });
    return handlers;
}

before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lm-osu-wiring-"));
    linked = await install(path.join(root, "Игры", "osu!"));
    process.env.LOCALAPPDATA = path.join(root, "local"); // nothing there: the machine's own osu! stays out of it
    childProcess.execFile = fakeReg;
    syncBuiltinESMExports();
});

after(async () => {
    childProcess.execFile = realExecFile;
    syncBuiltinESMExports();
    if (realLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = realLocalAppData;
    await rm(root, { recursive: true, force: true });
});

test("nothing picked, osu! closed: the Replay tab, as registered, finds the install Windows knows", async () => {
    const handlers = handlersOf(registerReplayIpc, { paths: { userData: path.join(root, "replay-data") } });
    const status = await handlers["replay-status"]();
    assert.deepEqual([status.folder, status.source, status.picked], [linked, "association", null]);
    assert.deepEqual((await handlers["replay-skin"]()).skins, ["Their Skin"]);
});

test("nothing picked, osu! closed: the Skin tab, as registered, finds it too", async () => {
    const handlers = handlersOf(registerSkinIpc, { paths: { userData: path.join(root, "skin-data"), docsDir: path.join(root, "docs") } });
    const list = await handlers["skin-list"]();
    assert.equal(list.folder, path.join(linked, "Skins"));
    assert.deepEqual(list.skins.map((s) => s.folder), ["Their Skin"]);
});

test("reg.exe itself: asked by name with no shell, hidden, cut off in a few seconds, its bytes left for the code page", async () => {
    assert.ok(calls.length >= 2, "the two questions were asked");
    for (const { file, args, options } of calls) {
        assert.match(file, /[\\/]System32[\\/]reg\.exe$/i);
        assert.equal(args[0], "query", "only ever a question");
        assert.equal(options.encoding, "buffer");
        assert.equal(options.windowsHide, true);
        assert.ok(options.timeout > 0 && options.timeout <= 5000, `timeout ${options.timeout}`);
        assert.equal(options.shell, undefined);
    }
});

test("the local profile's folder, from its real service and saved settings, comes before the association", async () => {
    const userData = path.join(root, "profile-data");
    const game = await install(path.join(root, "imported", "osu!"));
    await mkdir(path.join(userData, "local-profile"), { recursive: true });
    await writeFile(path.join(userData, "local-profile", "settings.json"), JSON.stringify({ record: true, osuFolder: game, imports: {} }));
    const localProfile = createLocalProfile({ userData, analysis: { bulk: async () => null }, port: null, env: {} });
    const handlers = handlersOf(registerReplayIpc, { paths: { userData }, localProfile });
    const status = await handlers["replay-status"]();
    assert.deepEqual([status.folder, status.source, status.picked], [game, "profile", null]);
});
