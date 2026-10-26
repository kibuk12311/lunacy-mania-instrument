// HTML → PNG through a hidden offscreen window (moved out of main.js for mapgen v3): the page goes through a temp
// file, the window is destroyed and the temp folder removed, also when loading fails.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createPngRenderer } from "../app/renderPng.js";

function fakeWindowClass({ failLoad = false } = {}) {
    const made = [];
    class FakeWindow {
        constructor(options) {
            this.options = options;
            this.destroyed = false;
            this.loaded = null;
            made.push(this);
            this.webContents = { capturePage: async () => ({ toPNG: () => Buffer.from(`png of ${this.html}`) }) };
        }
        async loadFile(file) {
            this.loaded = file;
            this.html = readFileSync(file, "utf8");
            if (failLoad) throw new Error("load failed");
        }
        destroy() { this.destroyed = true; }
    }
    return { FakeWindow, made };
}

test("renders the page at 1920×1080 and cleans up", async () => {
    const { FakeWindow, made } = fakeWindowClass();
    const renderPng = createPngRenderer(FakeWindow, { settleMs: 0 });
    const png = await renderPng("<p>курс</p>");
    assert.equal(png.toString(), "png of <p>курс</p>");
    const [w] = made;
    assert.equal(w.options.show, false);
    assert.equal(w.options.width, 1920);
    assert.equal(w.options.height, 1080);
    assert.equal(w.options.webPreferences.offscreen, true);
    assert.equal(w.options.webPreferences.sandbox, true);
    assert.equal(path.basename(w.loaded), "bg.html");
    assert.equal(w.destroyed, true);
    assert.equal(existsSync(path.dirname(w.loaded)), false);
});

test("a page that fails to load still destroys the window and the temp folder", async () => {
    const { FakeWindow, made } = fakeWindowClass({ failLoad: true });
    const renderPng = createPngRenderer(FakeWindow, { settleMs: 0 });
    await assert.rejects(renderPng("<p>x</p>"), /load failed/);
    assert.equal(made[0].destroyed, true);
    assert.equal(existsSync(path.dirname(made[0].loaded)), false);
});
