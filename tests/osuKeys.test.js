// osu! stable's key layouts for the keyboard reader: every key name osu! can write in its cfg → the Windows
// virtual-key code (src/overlay/osuKeys.js), the ManiaLayouts<N>K lines of a made-up cfg, which cfg of a game folder
// is the one in use (app/overlay/osuConfig.js, made-up files only), the labels and the keys pressed in the settings
// window, and the keyboard part of the overlay settings.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    KEY_NAMES, OSU_DEFAULT_LAYOUTS, canonicalName, keyLabel, nameOfKeyEvent, nameOfVk, laneVks, parseManiaLayouts, selectedLayout, vkOf, vksOf,
} from "../src/overlay/osuKeys.js";
import { cfgCandidates, createOsuConfigReader } from "../app/overlay/osuConfig.js";
import { applyPatch, cleanManualKeys, normalizeOverlaySettings } from "../src/overlay/settings.js";

// XNA's Keys (what osu! stable writes) and WinForms' spellings → winuser.h's VK_* values
const TABLE = {
    Back: 8, Tab: 9, Enter: 13, Return: 13, Pause: 19, CapsLock: 20, Capital: 20, Kana: 21, Kanji: 25, Escape: 27,
    ImeConvert: 28, ImeNoConvert: 29, Space: 32, PageUp: 33, Prior: 33, PageDown: 34, Next: 34, End: 35, Home: 36,
    Left: 37, Up: 38, Right: 39, Down: 40, Select: 41, Print: 42, Execute: 43, PrintScreen: 44, Snapshot: 44, Insert: 45,
    Delete: 46, Help: 47, LeftWindows: 91, LWin: 91, RightWindows: 92, RWin: 92, Apps: 93, Sleep: 95,
    Multiply: 106, Add: 107, Separator: 108, Subtract: 109, Decimal: 110, Divide: 111, NumLock: 144, Scroll: 145,
    LeftShift: 160, LShiftKey: 160, RightShift: 161, RShiftKey: 161, LeftControl: 162, LControlKey: 162,
    RightControl: 163, RControlKey: 163, LeftAlt: 164, LMenu: 164, RightAlt: 165, RMenu: 165,
    ShiftKey: 16, ControlKey: 17, Menu: 18,
    BrowserBack: 166, BrowserForward: 167, BrowserRefresh: 168, BrowserStop: 169, BrowserSearch: 170, BrowserFavorites: 171,
    BrowserHome: 172, VolumeMute: 173, VolumeDown: 174, VolumeUp: 175, MediaNextTrack: 176, MediaPreviousTrack: 177,
    MediaStop: 178, MediaPlayPause: 179, LaunchMail: 180, SelectMedia: 181, LaunchApplication1: 182, LaunchApplication2: 183,
    OemSemicolon: 186, Oem1: 186, OemPlus: 187, Oemplus: 187, OemComma: 188, Oemcomma: 188, OemMinus: 189, OemPeriod: 190,
    OemQuestion: 191, Oem2: 191, OemTilde: 192, Oemtilde: 192, Oem3: 192, OemOpenBrackets: 219, Oem4: 219, OemPipe: 220,
    Oem5: 220, OemCloseBrackets: 221, Oem6: 221, OemQuotes: 222, Oem7: 222, Oem8: 223, OemBackslash: 226, Oem102: 226,
    ProcessKey: 229, OemCopy: 242, OemAuto: 243, OemEnlW: 244, Attn: 246, Crsel: 247, Exsel: 248, EraseEof: 249,
    Play: 250, Zoom: 251, Pa1: 253, OemClear: 254,
    // WinForms only
    Clear: 12, HangulMode: 21, HanguelMode: 21, JunjaMode: 23, FinalMode: 24, HanjaMode: 25, IMENonconvert: 29,
    IMEAccept: 30, IMEAceept: 30, IMEModeChange: 31, LaunchMediaSelect: 181, Packet: 231, NoName: 252,
};
for (let i = 0; i < 26; i += 1) TABLE[String.fromCharCode(65 + i)] = 65 + i;
for (let i = 0; i <= 9; i += 1) TABLE[`D${i}`] = 48 + i;
for (let i = 0; i <= 9; i += 1) TABLE[`NumPad${i}`] = 96 + i;
for (let i = 1; i <= 24; i += 1) TABLE[`F${i}`] = 111 + i;

test("every key name osu! can write is its virtual-key code; any case; nothing else is a key", () => {
    for (const [name, vk] of Object.entries(TABLE)) {
        assert.equal(vkOf(name), vk, name);
        assert.equal(vkOf(name.toUpperCase()), vk, `${name} upper case`);
        assert.equal(vkOf(` ${name.toLowerCase()} `), vk, `${name} lower case, spaces`);
    }
    for (const bad of ["None", "", null, undefined, "LButton", "RButton", "XButton1", "Foo", "Shift", "Control", "Alt", "D10", "F25", "NumPad10"]) {
        assert.equal(vkOf(bad), null, String(bad));
    }
    // the table knows no name the test doesn't
    for (const name of KEY_NAMES) assert.ok(Object.keys(TABLE).some((n) => n.toLowerCase() === name), name);
    // written back in osu!'s spelling
    assert.equal(nameOfVk(162), "LeftControl");
    assert.equal(canonicalName("lcontrolkey"), "LeftControl");
    assert.equal(canonicalName("oemcomma"), "OemComma");
    assert.equal(canonicalName("Return"), "Enter");
    assert.equal(canonicalName("nope"), null);
    assert.deepEqual(vksOf(["A", "S", "OemSemicolon", "OemQuotes"]), [65, 83, 186, 222]);
    assert.equal(vksOf(["A", "None"]), null);
    assert.equal(vksOf([]), null);
});

test("labels: what the settings window shows for a key", () => {
    assert.deepEqual(["A", "S", "OemSemicolon", "OemQuotes"].map(keyLabel), ["A", "S", ";", "'"]);
    assert.deepEqual(["D1", "NumPad7", "Space", "LeftControl", "RightShift", "OemComma", "OemTilde", "Left", "F13"].map(keyLabel),
        ["1", "Num7", "Space", "LCtrl", "RShift", ",", "`", "←", "F13"]);
    assert.equal(keyLabel("garbage"), "?");
});

// a made-up cfg (never a real player's): a few unrelated lines, layouts for 4K (two of them), 7K and a broken 5K
const CFG = [
    "# osu! configuration for Tester",
    "# last updated on Friday, 30 October 2026",
    "",
    "BeatmapDirectory = Songs",
    "VolumeUniversal = 60",
    "ManiaSpeed = 24",
    "ManiaLayouts4K = Z X OemPeriod OemQuestion|D F J K",
    "ManiaLayoutSelected4K = 1",
    "ManiaLayouts7K = S D F Space J K L",
    "ManiaLayoutSelected7K = 0",
    "ManiaLayouts5K = D F Space",
    "ManiaLayouts6K = S D F Banana K L",
    "ManiaLayouts2K = lcontrolkey RControlKey",
    "ManiaLayoutSelected2K = 7",
    "KeyOverlay = 1",
].join("\r\n");

test("cfg: each key count's layouts and the selected one; a broken one is no layout, a key we can't hear no lane's", () => {
    const parsed = parseManiaLayouts(`﻿${CFG}`);
    assert.deepEqual(parsed[4], { layouts: [["Z", "X", "OemPeriod", "OemQuestion"], ["D", "F", "J", "K"]], selected: 1 });
    assert.deepEqual(selectedLayout(parsed, 4), ["D", "F", "J", "K"]);
    assert.deepEqual(selectedLayout(parsed, 7), ["S", "D", "F", "Space", "J", "K", "L"]);
    assert.equal(parsed[5], undefined, "three names for 5K: no layout");
    assert.equal(selectedLayout(parsed, 5), null);
    assert.deepEqual(selectedLayout(parsed, 6), ["S", "D", "F", null, "K", "L"], "a name that is no key: that lane alone has none");
    assert.deepEqual(selectedLayout(parseManiaLayouts("ManiaLayouts4K = A S None OemQuotes"), 4), ["A", "S", null, "OemQuotes"],
        "an unbound lane (None)");
    assert.equal(selectedLayout(parseManiaLayouts("ManiaLayouts2K = None Banana"), 2), null, "no lane with a key: no layout");
    assert.deepEqual(laneVks(["A", null, "OemQuotes"]), [65, null, 222]);
    assert.equal(laneVks([null, null]), null);
    assert.equal(laneVks(null), null);
    assert.deepEqual(selectedLayout(parsed, 2), ["LeftControl", "RightControl"], "a selected index past the list: the first; names in osu!'s spelling");
    assert.equal(selectedLayout(parsed, 9), null, "not in the cfg");
    // one value with two layouts in a row, N names each
    assert.deepEqual(parseManiaLayouts("ManiaLayouts2K = A B C D\nManiaLayoutSelected2K = 1")[2], { layouts: [["A", "B"], ["C", "D"]], selected: 1 });
    // the user's own example
    assert.deepEqual(selectedLayout(parseManiaLayouts("ManiaLayouts4K = A S OemSemicolon OemQuotes\nManiaLayoutSelected4K = 0"), 4),
        ["A", "S", "OemSemicolon", "OemQuotes"]);
    assert.deepEqual(parseManiaLayouts(""), {});
    assert.deepEqual(parseManiaLayouts(null), {});
    assert.deepEqual(OSU_DEFAULT_LAYOUTS[4], ["D", "F", "J", "K"]);
    for (const [n, names] of Object.entries(OSU_DEFAULT_LAYOUTS)) assert.equal(vksOf(names)?.length, Number(n), `${n}K default`);
});

test("cfg in use: osu!.<Windows user>.cfg, then tosu's profile name, then the newest; osu!.cfg is never it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "osu game "));
    const old = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-06-01T00:00:00Z");
    await writeFile(path.join(dir, "osu!.cfg"), "ManiaLayouts4K = Q W E R\n");
    await writeFile(path.join(dir, "osu!.Тестер.cfg"), "ManiaLayouts4K = A S OemSemicolon OemQuotes\n");
    await writeFile(path.join(dir, "osu!.PlayerOne.cfg"), "ManiaLayouts4K = Z X C V\n");
    await writeFile(path.join(dir, "osu!.Newest.cfg"), "ManiaLayouts4K = U I O P\n");
    await writeFile(path.join(dir, "notes.txt"), "");
    await utimes(path.join(dir, "osu!.Тестер.cfg"), old, old);
    await utimes(path.join(dir, "osu!.PlayerOne.cfg"), old, old);
    await utimes(path.join(dir, "osu!.Newest.cfg"), newer, newer);
    const names = async (o) => (await cfgCandidates(dir, o)).map((c) => c.name);
    assert.deepEqual((await names({ user: "тестер", profile: "PlayerOne" }))[0], "osu!.Тестер.cfg", "the Windows user's, any case, Cyrillic too");
    assert.deepEqual((await names({ user: "Somebody", profile: "playerone" }))[0], "osu!.PlayerOne.cfg", "then tosu's profile name");
    const byAge = await names({ user: "Somebody", profile: null });
    assert.equal(byAge[0], "osu!.Newest.cfg", "then the newest");
    assert.deepEqual([...byAge].sort(), ["osu!.Newest.cfg", "osu!.PlayerOne.cfg", "osu!.Тестер.cfg"].sort());
    assert.ok(!(await names({ user: null })).includes("osu!.cfg"));
    assert.deepEqual(await cfgCandidates(path.join(dir, "missing")), []);
    assert.deepEqual(await cfgCandidates(null), []);

    let reads = 0;
    const fs = await import("node:fs/promises");
    const read = createOsuConfigReader({ user: () => "Тестер", fs: { ...fs, readFile: (...a) => { reads += 1; return fs.readFile(...a); } } });
    const a = await read({ gameDir: dir, profile: "PlayerOne" });
    assert.equal(path.basename(a.file), "osu!.Тестер.cfg");
    assert.deepEqual(selectedLayout(a.layouts, 4), ["A", "S", "OemSemicolon", "OemQuotes"]);
    await read({ gameDir: dir });
    assert.equal(reads, 1, "read once while the file doesn't change");
    await writeFile(path.join(dir, "osu!.Тестер.cfg"), "ManiaLayouts4K = D F J K\n");
    await utimes(path.join(dir, "osu!.Тестер.cfg"), newer, newer);
    assert.deepEqual(selectedLayout((await read({ gameDir: dir })).layouts, 4), ["D", "F", "J", "K"], "read again once it changed");
    assert.equal(await read({ gameDir: path.join(dir, "nope") }), null);
});

test("a key pressed in the settings window: its VK (keyCode), left / right from event.code; Escape and mouse are none", () => {
    assert.equal(nameOfKeyEvent({ keyCode: 65, code: "KeyA" }), "A");
    assert.equal(nameOfKeyEvent({ keyCode: 186, code: "Semicolon" }), "OemSemicolon");
    assert.equal(nameOfKeyEvent({ keyCode: 222, code: "Quote" }), "OemQuotes");
    assert.equal(nameOfKeyEvent({ keyCode: 16, code: "ShiftLeft" }), "LeftShift");
    assert.equal(nameOfKeyEvent({ keyCode: 16, code: "ShiftRight" }), "RightShift");
    assert.equal(nameOfKeyEvent({ keyCode: 17, code: "ControlRight" }), "RightControl");
    assert.equal(nameOfKeyEvent({ keyCode: 18, code: "AltLeft" }), "LeftAlt");
    assert.equal(nameOfKeyEvent({ keyCode: 91, code: "MetaLeft" }), "LeftWindows");
    assert.equal(nameOfKeyEvent({ keyCode: 32, code: "Space" }), "Space");
    assert.equal(nameOfKeyEvent({ keyCode: 97, code: "Numpad1" }), "NumPad1");
    assert.equal(nameOfKeyEvent({ keyCode: 27, code: "Escape" }), null);
    assert.equal(nameOfKeyEvent({ keyCode: 1 }), null);
    assert.equal(nameOfKeyEvent({}), null);
});

test("settings: the keyboard is read out of the box; keys set by hand are whole layouts of known keys, each once", () => {
    const d = normalizeOverlaySettings(null);
    assert.deepEqual(d.keyboard, { enabled: true, keys: {} });
    assert.equal(normalizeOverlaySettings({ keyboard: { enabled: false } }).keyboard.enabled, false);
    assert.deepEqual(cleanManualKeys({ 4: ["a", "s", "oem1", "OemQuotes"], 2: ["A"], 3: ["A", "A", "B"], 5: "D F", 7: ["S", "D", "F", "Space", "J", "K", "Nope"] }),
        { 4: ["A", "S", "OemSemicolon", "OemQuotes"] });
    const set = applyPatch(d, { keyboard: { keys: { 4: ["Z", "X", "OemPeriod", "OemQuestion"] } } });
    assert.deepEqual(set.keyboard.keys, { 4: ["Z", "X", "OemPeriod", "OemQuestion"] });
    assert.equal(set.keyboard.enabled, true);
    const off = applyPatch(set, { keyboard: { enabled: false } });
    assert.deepEqual(off.keyboard, { enabled: false, keys: { 4: ["Z", "X", "OemPeriod", "OemQuestion"] } }, "turning it off keeps the keys");
    assert.deepEqual(applyPatch(off, { keyboard: { keys: { 4: null } } }).keyboard.keys, {}, "null gives the key count back to osu!");
    assert.deepEqual(applyPatch(d, { keyboard: { keys: { 4: ["A", "B"] } } }).keyboard.keys, {}, "a broken layout is dropped");
    assert.deepEqual(applyPatch(d, { widgets: { kps: { style: "neon" } } }).keyboard, d.keyboard, "other patches leave it");
});
