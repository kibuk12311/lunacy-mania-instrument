// nn-v2 on the GPU vs the CPU (ML addendum §11, stream W), measured in a hidden Electron renderer (WebGPU is there,
// not in the utility worker). For each size (tools/nn/sizes.json, random weights in that shape) a 4-minute song:
// prepare and one build on the CPU, the GPU encoder with the CPU decoder, and the GPU decoder with B builds at once;
// then the model time per variant (prepare + 5 search builds + N candidates, §5.3) under each design.
// Usage: npx electron tools/bench-gpu.mjs [--sizes S,M,L,Lenc] [--batches 1,2,3,12] [--keep-alive 0,2] [--candidates 12] [--out dir]
// Not part of npm test (it needs a GPU); the numbers go into docs/2026-10-26-webgpu-stream-w.md.
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const arg = (name, dflt) => {
    const k = process.argv.indexOf(`--${name}`);
    return k > 0 ? process.argv[k + 1] : dflt;
};
const outDir = arg("out", path.join(tmpdir(), "lunacy-bench-gpu"));
mkdirSync(outDir, { recursive: true });
app.setPath("userData", path.join(outDir, "user-data"));
const presets = JSON.parse(readFileSync(path.join(root, "tools", "nn", "sizes.json"), "utf8"));
const sizes = arg("sizes", "S,M,L").split(",");
const batches = arg("batches", "1,2,3,12").split(",").map(Number);
const keepAlive = arg("keep-alive", "0,2").split(",").map(Number);
const N = Number(arg("candidates", 12));
const SEARCH = 5;
// besides the presets: "Lenc" = the L encoder with the S decoder and lane head (the encoder is what the GPU makes cheap;
// the decoder runs beat by beat and sets the time per build), "Menc" likewise
const sDecoder = { dec_d: presets.S.dec_d, dec_layers: presets.S.dec_layers, dec_heads: presets.S.dec_heads, dec_ffn: presets.S.dec_ffn, lane_hidden: presets.S.lane_hidden };
const extra = { Lenc: { ...presets.L, ...sDecoder }, Menc: { ...presets.M, ...sDecoder } };
const archs = Object.fromEntries(sizes.map((k) => [k, presets[k] ?? extra[k]]));

const s = (ms) => (ms / 1000).toFixed(2);

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on("console-message", (...a) => console.log("renderer:", a.at(-1)?.message ?? a[2]));
    await win.loadFile(path.join(root, "app", "gpuWorker.html"));
    const bench = pathToFileURL(path.join(root, "tests", "gpu", "webgpuBench.js")).href;
    const res = await win.webContents.executeJavaScript(`(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        if (!adapter) return { skipped: "no WebGPU adapter" };
        const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
        const { runBench } = await import(${JSON.stringify(bench)});
        const rows = await runBench({ device, archs: ${JSON.stringify(archs)}, batches: ${JSON.stringify(batches)}, keepAlive: ${JSON.stringify(keepAlive)} });
        return { adapter: [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(" "), rows };
    })()`);
    if (res.skipped) {
        console.log(res.skipped);
        app.exit(3);
        return;
    }
    writeFileSync(path.join(outDir, "bench-gpu.json"), JSON.stringify(res, null, 2));
    console.log(`adapter ${res.adapter}; song ${res.rows[0]?.beats} beats, ${res.rows[0]?.slots} slots`);
    console.log("size  cpu prepare  cpu build  gpu prepare  build over gpu enc (agree)");
    for (const r of res.rows) {
        console.log(`${r.size.padEnd(5)} ${s(r.cpuPrepare).padStart(8)} s ${s(r.cpuBuild).padStart(8)} s ${s(r.gpuPrepare).padStart(9)} s ${s(r.gpuEncCpuBuild).padStart(10)} s (${(100 * r.gpuEncAgree).toFixed(1)}%)`);
    }
    console.log("\ngpu decoder, B builds at once: seconds per pass (per build; rows agreeing with the cpu build; dispatches)");
    for (const r of res.rows) {
        for (const ka of keepAlive) {
            const list = r.dec.filter((d) => d.keepAlive === ka);
            console.log(`${r.size.padEnd(5)} keep-alive ${ka}: ` + list.map((d) => `×${d.B} ${s(d.ms)} s (${s(d.perBuild)} s, ${(100 * d.agree).toFixed(1)}%, ${d.dispatches})`).join("   "));
        }
    }
    console.log(`\nmodel time per variant (prepare + ${SEARCH} search builds + ${N} candidates), seconds; gpu decoder with the better keep-alive:`);
    console.log("size  D0 cpu   D1 gpu enc + cpu builds   D2 gpu dec, one build at a time   D3 D1 search + gpu dec ×N   D4 gpu dec, search ×3 + ×2, cand ×N");
    for (const r of res.rows) {
        const pass = (B) => {
            const got = r.dec.filter((d) => d.B === B).map((d) => d.ms);
            return got.length ? Math.min(...got) : null;
        };
        const top = Math.max(...batches);
        const p1 = pass(1);
        const pN = pass(N) ?? (pass(top) / top) * N;
        const d0 = r.cpuPrepare + (SEARCH + N) * r.cpuBuild;
        const d1 = r.gpuPrepare + (SEARCH + N) * r.gpuEncCpuBuild;
        const d2 = r.gpuPrepare + (SEARCH + N) * p1;
        const d3 = r.gpuPrepare + SEARCH * Math.min(r.gpuEncCpuBuild, p1) + pN;
        const d4 = r.gpuPrepare + (pass(3) ?? 3 * p1) + (pass(2) ?? 2 * p1) + pN;
        console.log(`${r.size.padEnd(5)} ${s(d0).padStart(6)}   ${s(d1).padStart(10)}                ${s(d2).padStart(10)}                      ${s(d3).padStart(10)}                 ${s(d4).padStart(10)}`);
    }
    app.exit(0);
});
setTimeout(() => {
    console.log("bench timeout");
    app.exit(2);
}, 900000);
