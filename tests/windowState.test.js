import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadWindowState, saveWindowState, DEFAULT_WINDOW } from "../app/windowState.js";

const ONE_SCREEN = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];

test("missing file gives defaults centred on the primary screen", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const s = loadWindowState(path.join(dir, "window.json"), ONE_SCREEN);
    assert.equal(s.width, DEFAULT_WINDOW.width);
    assert.equal(s.height, DEFAULT_WINDOW.height);
    assert.equal(s.alwaysOnTop, false);
    assert.equal("compact" in s, false, "no compact mode any more");
    assert.equal(s.x, Math.round((1920 - s.width) / 2));
});

test("saved state round-trips", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    const state = { x: 100, y: 50, width: 340, height: 280, alwaysOnTop: true, lang: "en", autoUpdate: false };
    saveWindowState(file, state);
    assert.deepEqual(loadWindowState(file, ONE_SCREEN), state);
});

test("off-screen position is re-centred", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    saveWindowState(file, { x: -5000, y: 10, width: 320, height: 300, alwaysOnTop: false });
    const s = loadWindowState(file, ONE_SCREEN);
    assert.equal(s.x, Math.round((1920 - 320) / 2));
    assert.equal(s.y, Math.round((1080 - 300) / 2));
});

test("second monitor position is kept", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    const screens = [...ONE_SCREEN, { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } }];
    saveWindowState(file, { x: 2000, y: 100, width: 320, height: 300, alwaysOnTop: false });
    assert.equal(loadWindowState(file, screens).x, 2000);
});

test("corrupt file falls back to defaults", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "{oops");
    assert.equal(loadWindowState(file, ONE_SCREEN).width, DEFAULT_WINDOW.width);
});

test("language: kept when known, null when never chosen or unknown", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    assert.equal(loadWindowState(file, ONE_SCREEN).lang, null);
    saveWindowState(file, { x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false, lang: "xx" });
    assert.equal(loadWindowState(file, ONE_SCREEN).lang, null);
    saveWindowState(file, { x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false, lang: "ru" });
    assert.equal(loadWindowState(file, ONE_SCREEN).lang, "ru");
});

test("automatic update check: on by default and for an old window.json without the field, off only when saved off", async () => {
    const { writeFileSync } = await import("node:fs");
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    assert.equal(loadWindowState(file, ONE_SCREEN).autoUpdate, true, "no file");
    writeFileSync(file, JSON.stringify({ x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false, lang: "ru" }));
    assert.equal(loadWindowState(file, ONE_SCREEN).autoUpdate, true, "0.7 window.json");
    saveWindowState(file, { x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false, lang: "ru", autoUpdate: false });
    assert.equal(loadWindowState(file, ONE_SCREEN).autoUpdate, false);
    saveWindowState(file, { x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false });
    assert.equal(loadWindowState(file, ONE_SCREEN).autoUpdate, true, "a state without the field saves it on");
});

test("a window.json saved in the old compact mode opens the normal window, and the mode is not saved again", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    writeFileSync(file, JSON.stringify({ x: 10, y: 10, width: 330, height: 103, alwaysOnTop: true, compact: true, lang: "ru" }));
    const s = loadWindowState(file, ONE_SCREEN);
    assert.equal(s.height, DEFAULT_WINDOW.height, "the strip's height is not the window's");
    assert.equal(s.width, DEFAULT_WINDOW.width, "an old small window grows to the new default once");
    assert.equal(s.alwaysOnTop, true);
    assert.equal("compact" in s, false);
    saveWindowState(file, s);
    assert.equal("compact" in JSON.parse(readFileSync(file, "utf8")), false);
    // a window bigger than the default keeps its size
    writeFileSync(file, JSON.stringify({ x: 10, y: 10, width: 600, height: 950, compact: true }));
    assert.equal(loadWindowState(file, ONE_SCREEN).height, 950);
});

test("0.9.8: an old small window grows to the bigger default once, a saved new size is kept, never past the screen", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    writeFileSync(file, JSON.stringify({ x: 10, y: 10, width: 320, height: 380, alwaysOnTop: false }));
    const grown = loadWindowState(file, ONE_SCREEN);
    assert.deepEqual([grown.width, grown.height], [DEFAULT_WINDOW.width, DEFAULT_WINDOW.height]);
    // made small again by the player after the update: kept
    saveWindowState(file, { ...grown, width: 330, height: 400 });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).size, 2);
    assert.deepEqual([loadWindowState(file, ONE_SCREEN).width, loadWindowState(file, ONE_SCREEN).height], [330, 400]);
    // a 1366×768 laptop: the default fits the work area
    const laptop = [{ workArea: { x: 0, y: 0, width: 1366, height: 728 } }];
    const missing = path.join(dir, "none.json");
    assert.equal(loadWindowState(missing, laptop).height, 708);
});
