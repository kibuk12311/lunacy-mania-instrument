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
    assert.equal(s.compact, false);
    assert.equal(s.x, Math.round((1920 - s.width) / 2));
});

test("saved state round-trips", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    const state = { x: 100, y: 50, width: 340, height: 280, alwaysOnTop: true, compact: true, lang: "en", autoUpdate: false };
    saveWindowState(file, state);
    assert.deepEqual(loadWindowState(file, ONE_SCREEN), state);
});

test("off-screen position is re-centred", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    saveWindowState(file, { x: -5000, y: 10, width: 320, height: 300, alwaysOnTop: false, compact: false });
    const s = loadWindowState(file, ONE_SCREEN);
    assert.equal(s.x, Math.round((1920 - 320) / 2));
    assert.equal(s.y, Math.round((1080 - 300) / 2));
});

test("second monitor position is kept", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    const screens = [...ONE_SCREEN, { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } }];
    saveWindowState(file, { x: 2000, y: 100, width: 320, height: 300, alwaysOnTop: false, compact: false });
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
    saveWindowState(file, { x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false, compact: false, lang: "xx" });
    assert.equal(loadWindowState(file, ONE_SCREEN).lang, null);
    saveWindowState(file, { x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false, compact: false, lang: "ru" });
    assert.equal(loadWindowState(file, ONE_SCREEN).lang, "ru");
});

test("automatic update check: on by default and for an old window.json without the field, off only when saved off", async () => {
    const { writeFileSync } = await import("node:fs");
    const dir = await mkdtemp(path.join(tmpdir(), "окно "));
    const file = path.join(dir, "window.json");
    assert.equal(loadWindowState(file, ONE_SCREEN).autoUpdate, true, "no file");
    writeFileSync(file, JSON.stringify({ x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false, compact: false, lang: "ru" }));
    assert.equal(loadWindowState(file, ONE_SCREEN).autoUpdate, true, "0.7 window.json");
    saveWindowState(file, { x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false, compact: false, lang: "ru", autoUpdate: false });
    assert.equal(loadWindowState(file, ONE_SCREEN).autoUpdate, false);
    saveWindowState(file, { x: 1, y: 1, width: 320, height: 300, alwaysOnTop: false, compact: false });
    assert.equal(loadWindowState(file, ONE_SCREEN).autoUpdate, true, "a state without the field saves it on");
});
