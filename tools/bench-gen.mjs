// Time per variant of the current v3 generator (addendum §5.3 targets: p95 ≤ 8 s per variant for 4-minute songs,
// ≤ 9.5 s for XGB v3 with N = 12 candidates), one engine at a time, one variant at a time, in this thread, so the
// numbers are not inflated by parallel jobs. Also the time per generator phase (from its progress events), the
// model load time and the audio preparation time.
// Usage: node tools/bench-gen.mjs --picks FILE [--limit 10] [--min-sec 180] [--model label=path …] [--a FILE] [--b FILE]
//        [--rules] [--config FILE] [--seeds 1,2] [--form range|target] [--snaps auto|q4|all] [--budget 8] [--out FILE]
// Output: a table on stdout and a JSON file (default A:/SneezeyTrain/eval-v/bench-<time>.json).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, configFor, percentile, fmt, SNAP_VARIANTS } from "./eval/compare.mjs";
import { loadSong, snapsOf, buildInput, runEngine, loadModelFile, wantsStems } from "./eval/genRun.mjs";

const SELF = fileURLToPath(import.meta.url);

export function parseBenchArgs(argv) {
    const o = { engines: [], limit: 10, minSec: 0, seeds: [1], form: "range", snaps: "auto", budgetMs: 8000, ffmpeg: "ffmpeg" };
    const labels = new Set();
    const add = (label, file) => {
        if (labels.has(label)) throw new Error(`engine "${label}" given twice`);
        labels.add(label);
        o.engines.push(file ? { label, kind: "model", path: file } : { label, kind: "rules" });
    };
    for (let i = 0; i < argv.length; i += 1) {
        const k = argv[i].replace(/^--/, "");
        if (k === "rules") {
            add("rules", null);
            continue;
        }
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`missing value for --${k}`);
        i += 1;
        if (k === "a" || k === "b") add(k.toUpperCase(), v);
        else if (k === "model") {
            const eq = v.indexOf("=");
            if (eq <= 0) throw new Error(`--model wants label=path, got ${v}`);
            add(v.slice(0, eq), v.slice(eq + 1));
        } else if (k === "seeds") o.seeds = v.split(",").map(Number);
        else if (k === "limit") o.limit = Number(v);
        else if (k === "min-sec") o.minSec = Number(v);
        else if (k === "budget") o.budgetMs = Number(v) * 1000;
        else if (k === "form") o.form = v;
        else if (k === "snaps") o.snaps = v;
        else if (["picks", "config", "out", "ffmpeg"].includes(k)) o[k] = v;
        else throw new Error(`unknown option --${k}`);
    }
    if (!o.picks) throw new Error("give --picks FILE");
    if (!o.engines.length) throw new Error("no engine: give --model label=path, --a/--b or --rules");
    if (!(o.snaps in SNAP_VARIANTS)) throw new Error(`--snaps takes ${Object.keys(SNAP_VARIANTS).join(", ")}`);
    if (!["range", "target"].includes(o.form)) throw new Error("--form is range or target");
    if (o.seeds.some((s) => !Number.isSafeInteger(s))) throw new Error("--seeds wants integers");
    return o;
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseBenchArgs(argv);
    const cfg = parseConfig(args.config ? await readFile(args.config, "utf8") : null, { baseDir: args.config ? path.dirname(path.resolve(args.config)) : "." });
    const picks = JSON.parse(await readFile(args.picks, "utf8"));
    const loadMs = {};
    for (const e of args.engines) {
        if (e.kind !== "model") continue;
        const t0 = performance.now();
        await loadModelFile(e.path);
        loadMs[e.label] = Math.round(performance.now() - t0);
    }
    const runs = [];
    const songs = [];
    for (const pick of picks) {
        if (songs.length >= args.limit) break;
        const t0 = performance.now();
        let song;
        try {
            song = await loadSong(pick, { ffmpeg: args.ffmpeg, wantStems: await wantsStems(args.engines, (label) => configFor(cfg, label)) });
        } catch (e) {
            console.log(`skip ${pick.osuPath}: ${e.message}`);
            continue;
        }
        if (song.durationMs < args.minSec * 1000) continue;
        const prepMs = performance.now() - t0;
        songs.push({ osuPath: pick.osuPath, sec: Math.round(song.durationMs / 1000), prepMs: Math.round(prepMs), stems: !!song.stems });
        const line = [`${String(songs.length).padStart(2)} ${String(Math.round(song.durationMs / 1000)).padStart(3)} s prep ${(prepMs / 1000).toFixed(1)} s`];
        for (const e of args.engines) {
            const ecfg = configFor(cfg, e.label);
            for (const seed of args.seeds) {
                const input = buildInput(song, { form: args.form, seed, snaps: snapsOf(e.kind === "rules" ? "q4" : args.snaps, song), cfg: ecfg });
                try {
                    const { response, ms, phases } = await runEngine(e, input, { cfg: ecfg });
                    runs.push({ engine: e.label, song: songs.length - 1, sec: song.durationMs / 1000, seed, ms, phases, critic: response.critic?.of ?? null });
                    line.push(`${e.label} ${(ms / 1000).toFixed(1)} s`);
                } catch (err) {
                    runs.push({ engine: e.label, song: songs.length - 1, seed, error: String(err?.message ?? err) });
                    line.push(`${e.label} failed`);
                }
            }
        }
        console.log(line.join(" | "));
    }
    const rows = args.engines.map((e) => {
        const mine = runs.filter((r) => r.engine === e.label && Number.isFinite(r.ms));
        const ms = mine.map((r) => r.ms);
        const phaseNames = [...new Set(mine.flatMap((r) => Object.keys(r.phases)))];
        const phases = Object.fromEntries(phaseNames.map((p) => [p, mine.reduce((s, r) => s + (r.phases[p] ?? 0), 0) / (mine.length || 1)]));
        const perMin = mine.map((r) => r.ms / (r.sec / 60));
        return {
            engine: e.label, n: mine.length, failed: runs.filter((r) => r.engine === e.label && r.error).length, loadMs: loadMs[e.label] ?? 0,
            medianMs: percentile(ms, 0.5), p95Ms: percentile(ms, 0.95), maxMs: percentile(ms, 1), perMinuteMs: percentile(perMin, 0.5), phases,
            withinBudget: percentile(ms, 0.95) <= args.budgetMs,
        };
    });
    const head = "| engine | variants | median s | p95 s | max s | median s per song minute | phases (mean s) | model load s | p95 within budget |";
    const table = [head, "|---|---|---|---|---|---|---|---|---|", ...rows.map((r) => `| ${[
        r.engine, `${r.n}${r.failed ? ` (${r.failed} failed)` : ""}`, fmt(r.medianMs / 1000, 2), fmt(r.p95Ms / 1000, 2), fmt(r.maxMs / 1000, 2),
        fmt(r.perMinuteMs / 1000, 2), Object.entries(r.phases).map(([p, v]) => `${p} ${(v / 1000).toFixed(2)}`).join(", "),
        fmt(r.loadMs / 1000, 2), `${r.withinBudget ? "yes" : "NO"} (≤ ${args.budgetMs / 1000} s)`,
    ].join(" | ")} |`)].join("\n");
    console.log(`\n${songs.length} songs (${songs.map((s) => s.sec).join(", ")} s), seeds ${args.seeds.join(",")}, form ${args.form}, snaps ${args.snaps}; ${cpus()[0]?.model ?? "?"}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB`);
    console.log(table);
    const out = path.resolve(args.out ?? path.join("A:/SneezeyTrain/eval-v", `bench-${new Date().toISOString().slice(0, 16).replace(/:/g, "-")}.json`));
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify({ argv, machine: { cpu: cpus()[0]?.model, threads: cpus().length, memGB: totalmem() / 2 ** 30, node: process.version }, config: cfg, songs, rows, runs }, null, 1));
    console.log(`wrote ${out}`);
    return rows.every((r) => r.withinBudget) ? 0 : 3;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
    main().then((code) => process.exit(code), (e) => {
        console.error(e?.stack ?? e);
        process.exit(1);
    });
}
