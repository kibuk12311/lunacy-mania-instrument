// Run with: npx electron tests/smoke/electron-webgpu.mjs [outDir]
// The nn-v2 WebGPU path (stream W) in a hidden renderer: GPU logits against PyTorch (the parity probes of
// tests/fixtures/infill-parity.json and of any mapper-nn2*.json in LUNACY_MODEL_DIR or models/) and against the JS path
// on random models in the S/M/L shapes (tools/nn/sizes.json). Exits 0 when every check passes, 3 when there is no
// WebGPU adapter (nothing to check), 1 when a check fails. userData goes to <outDir>/user-data (by default in the
// temp folder), never the app's own.
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const outDir = process.argv.slice(2).find((a) => !a.startsWith("-") && !a.endsWith(".mjs")) ?? path.join(tmpdir(), "lunacy-webgpu-smoke");
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));

const models = { "fixture XS": JSON.parse(readFileSync(path.join(root, "tests", "fixtures", "infill-parity.json"), "utf8")) };
for (const dir of [...(process.env.LUNACY_MODEL_DIR ?? "").split(path.delimiter).filter(Boolean), path.join(root, "models")]) {
    let names = [];
    try {
        names = readdirSync(dir);
    } catch {
        continue;
    }
    for (const name of names) if (/^mapper-nn2.*\.json$/.test(name) && !models[name]) models[name] = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}
const sizes = JSON.parse(readFileSync(path.join(root, "tools", "nn", "sizes.json"), "utf8"));
const archs = { S: { ...sizes.S, T: 160 }, M: { ...sizes.M, T: 120 }, L: { ...sizes.L, T: 80 } };

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on("console-message", (...args) => console.log("renderer:", args.at(-1)?.message ?? args[2]));
    await win.loadFile(path.join(root, "app", "gpuWorker.html"));
    const suite = pathToFileURL(path.join(root, "tests", "gpu", "webgpuSuite.js")).href;
    const out = await win.webContents.executeJavaScript(`(async () => {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) return { skipped: "no WebGPU adapter" };
        const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
        const { runSuite } = await import(${JSON.stringify(suite)});
        const results = await runSuite({ device, models: ${JSON.stringify(models)}, archs: ${JSON.stringify(archs)} });
        return { adapter: [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(" "), results };
    })()`);
    if (out.skipped) {
        console.log("WEBGPU skipped:", out.skipped);
        app.exit(3);
        return;
    }
    console.log(`WEBGPU adapter: ${out.adapter}`);
    for (const r of out.results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.error ?? `max |Δ| ${r.worst?.toExponential(2)} (≤ ${r.tol})`} ${r.ms} ms`);
    app.exit(out.results.every((r) => r.ok) ? 0 : 1);
});
setTimeout(() => {
    console.log("WEBGPU timeout");
    app.exit(2);
}, 300000);
