// HTML → 1920×1080 PNG in a hidden offscreen window (written to a temp file: big data: URLs fail to load).
// Used for marathon backgrounds (and mapset backgrounds later); BrowserWindow is passed in so this stays testable.
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function createPngRenderer(BrowserWindow, { settleMs = 400 } = {}) {
    return async (html) => {
        const dir = await mkdtemp(path.join(tmpdir(), "dan-bg-"));
        const page = path.join(dir, "bg.html");
        await writeFile(page, html, "utf8");
        const w = new BrowserWindow({ show: false, width: 1920, height: 1080, useContentSize: true, webPreferences: { offscreen: true, sandbox: true } });
        try {
            await w.loadFile(page);
            await new Promise((r) => setTimeout(r, settleMs));
            return (await w.webContents.capturePage()).toPNG();
        } finally {
            w.destroy();
            await rm(dir, { recursive: true, force: true });
        }
    };
}
