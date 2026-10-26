// The tab modules' IPC registrars, called the way main.js calls them but with stubs: every channel is hung once,
// the base channels are there, registering does no I/O, and every channel the preload uses has a handler.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./helpers/source.js";
import { registerProfileIpc } from "../app/profileService.js";
import { registerAnalysisIpc } from "../app/analysisIpc.js";
import { registerRateIpc } from "../app/rateIpc.js";
import { registerMarathonIpc } from "../app/marathonIpc.js";
import { registerRecommendIpc } from "../app/recommendIpc.js";
import { registerCreateIpc } from "../app/createIpc.js";
import { registerExportIpc } from "../app/exportIpc.js";
import { registerInterludeIpc } from "../app/interludeIpc.js";
import { registerLocalProfileIpc } from "../app/localProfileIpc.js";
import { registerSessionIpc } from "../app/sessionIpc.js";
import { OVERLAY_CHANNELS } from "../app/overlay/overlayManager.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => stripComments(readFileSync(path.join(root, file), "utf8"));
const REGISTRARS = { registerProfileIpc, registerAnalysisIpc, registerRateIpc, registerMarathonIpc, registerRecommendIpc, registerCreateIpc, registerExportIpc, registerInterludeIpc, registerLocalProfileIpc, registerSessionIpc };
// deps whose use means I/O (worker, network, disk, the window, shell); none may be called while registering
const IO_DEPS = ["worker", "analysis", "resultCache", "trackerApi", "recommender", "downloader", "profile", "tosu", "shell", "ffmpegPath", "renderPng", "send", "generatorClient", "generatedStore", "interlude", "dialog", "card", "localProfile"];

// Any property of a stub is another stub, any call is recorded under its path; as text a stub reads "stub:<path>".
function stubDeps(ipcMain) {
    const calls = [];
    const stub = (name) => new Proxy(function stubbed() {}, {
        get(_target, key) {
            if (key === Symbol.toPrimitive) return () => `stub:${name}`;
            if (typeof key === "symbol" || key === "then") return undefined;
            return stub(`${name}.${key}`);
        },
        apply() {
            calls.push(name);
            return stub(`${name}()`);
        },
    });
    const deps = new Proxy({ ipcMain }, { get: (target, key) => (key in target ? target[key] : stub(String(key))) });
    return { deps, calls };
}

function fakeIpcMain() {
    const handled = [];
    const listened = [];
    return { handled, listened, handle: (channel) => handled.push(channel), on: (channel) => listened.push(channel) };
}

function registerAll() {
    const ipcMain = fakeIpcMain();
    const { deps, calls } = stubDeps(ipcMain);
    for (const register of Object.values(REGISTRARS)) register(deps);
    return { ipcMain, calls };
}

// channels main.js still hangs itself (window, settings, opening a saved map)
const mainSource = source("app/main.js");
const mainHandled = [...mainSource.matchAll(/ipcMain\.handle\("([\w-]+)"/g)].map((m) => m[1]);
const mainListened = [...mainSource.matchAll(/ipcMain\.on\("([\w-]+)"/g)].map((m) => m[1]);

test("no channel is registered twice, across all registrars and main.js", () => {
    const { ipcMain } = registerAll();
    const all = [...ipcMain.handled, ...mainHandled];
    assert.deepEqual(all.filter((c, i) => all.indexOf(c) !== i), []);
    const events = [...ipcMain.listened, ...mainListened];
    assert.deepEqual(events.filter((c, i) => events.indexOf(c) !== i), []);
});

test("the base channels are all there", () => {
    const { ipcMain } = registerAll();
    const base = [
        "profile-get", "profile-ensure",
        "rate-info", "rate-preview", "rate-create",
        "marathon-add-current", "marathon-add-file", "marathon-dan", "marathon-create",
        "rec-player", "rec-me", "rec-start", "rec-more", "rec-ours", "rec-open", "rec-download", "rec-show",
        "generate-map", "detect-timing", "export-set", "song-tags", "remap-load", "remap-create",
    ];
    assert.deepEqual(base.filter((c) => !ipcMain.handled.includes(c)), []);
    for (const own of ["open-map"]) assert.ok(mainHandled.includes(own), own);
    for (const own of ["get-lang", "set-lang", "toggle-always-on-top", "toggle-compact", "tab", "show-map"]) assert.ok(mainListened.includes(own), own);
});

test("registering does no I/O: no worker, tracker, downloader or other service is called", () => {
    const { calls } = registerAll();
    assert.deepEqual(calls.filter((name) => IO_DEPS.some((dep) => name === dep || name.startsWith(`${dep}.`))), []);
});

test("main.js registers the profile and every tab through one register call each", () => {
    for (const name of Object.keys(REGISTRARS)) {
        assert.equal(mainSource.split(`${name}(deps)`).length - 1, 1, name);
    }
    const block = /\/\/ >>> tabs v2[^\n]*\n([\s\S]*?)\/\/ <<< tabs v2/.exec(readFileSync(path.join(root, "app/main.js"), "utf8"));
    assert.ok(block, "marked block in main.js");
    // the block holds register calls only: the four tabs in this order (another tab may add its own line)
    const lines = block[1].split("\n").map((l) => l.trim()).filter(Boolean);
    assert.deepEqual(lines.filter((l) => !/^register\w+Ipc\(deps\);(\s*\/\/.*)?$/.test(l)), []);
    const calls = lines.map((l) => /^(register\w+Ipc)/.exec(l)[1]);
    const tabs = ["registerAnalysisIpc", "registerRateIpc", "registerMarathonIpc", "registerRecommendIpc"];
    assert.deepEqual(calls.filter((name) => tabs.includes(name)), tabs);
});

// ---- preload ----

const preloadRaw = readFileSync(path.join(root, "app/preload.cjs"), "utf8");
const preload = stripComments(preloadRaw);

test("every channel the preload invokes or sends has a handler in main", () => {
    const { ipcMain } = registerAll();
    // the overlay block uses the overlay's own channels, registered by app/overlay/overlayManager.js
    const handled = new Set([...ipcMain.handled, ...mainHandled, ...OVERLAY_CHANNELS.handle]);
    const listened = new Set([...ipcMain.listened, ...mainListened, ...OVERLAY_CHANNELS.on]);
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\("([\w-]+)"/g)].map((m) => m[1]);
    const sent = [...preload.matchAll(/ipcRenderer\.send(?:Sync)?\("([\w-]+)"/g)].map((m) => m[1]);
    assert.ok(invoked.length >= 19, `only ${invoked.length} invokes found`);
    assert.deepEqual(invoked.filter((c) => !handled.has(c)), []);
    assert.deepEqual(sent.filter((c) => !listened.has(c)), []);
});

test("every event the preload listens to is sent by main or a tab module", () => {
    const appCode = ["app/main.js", "app/profileService.js", "app/analysisIpc.js", "app/rateIpc.js", "app/marathonIpc.js", "app/recommendIpc.js",
        "app/createIpc.js", "app/exportIpc.js", "app/interludeIpc.js", "app/sessionIpc.js", "app/overlay/overlayManager.js", "app/localProfileService.js"]
        .map(source).join("\n");
    const events = [...preload.matchAll(/ipcRenderer\.on\("([\w-]+)"/g)].map((m) => m[1]);
    assert.ok(events.includes("profile-changed"));
    assert.ok(events.includes("generate-progress"));
    assert.deepEqual(events.filter((c) => !appCode.includes(`"${c}"`)), []);
});

test("the preload groups its methods in marked blocks, one per tab", () => {
    const names = [...preloadRaw.matchAll(/\/\/ >>> (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(names, ["shared", "create", "analysis", "rate", "marathon", "picks", "interlude", "profile", "overlay"]);
    for (const name of names) {
        assert.equal(preloadRaw.split(`// >>> ${name}`).length - 1, 1, name);
        assert.ok(preloadRaw.indexOf(`// >>> ${name}`) < preloadRaw.indexOf(`// <<< ${name}`), `${name} is closed after it opens`);
    }
    const inBlock = (name) => preloadRaw.slice(preloadRaw.indexOf(`// >>> ${name}`), preloadRaw.indexOf(`// <<< ${name}`));
    assert.match(inBlock("shared"), /profileGet[\s\S]*profileEnsure[\s\S]*onProfileChanged/);
    assert.match(inBlock("create"), /generateMap[\s\S]*openMap[\s\S]*showMap/);
    assert.match(inBlock("create"), /onGenerateProgress[\s\S]*detectTiming[\s\S]*exportSet[\s\S]*songTags[\s\S]*remapLoad[\s\S]*remapCreate/);
    assert.match(inBlock("rate"), /rateInfo[\s\S]*ratePreview[\s\S]*rateCreate/);
    assert.match(inBlock("marathon"), /marathonAddCurrent[\s\S]*marathonDan[\s\S]*marathonCreate/);
    assert.match(inBlock("picks"), /recPlayer[\s\S]*onRecDownloadProgress/);
    assert.match(inBlock("overlay"), /overlayGet[\s\S]*overlaySet[\s\S]*overlaySetEdit[\s\S]*overlayOpenSettings[\s\S]*onOverlaySettings/);
});
