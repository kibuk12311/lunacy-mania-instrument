// Compare mapper models under the CURRENT v3 generator (plan D5 + addendum §7, stream V): every engine runs on the
// same songs with the same seeds and request; only the model file (or the rule generator) differs. Metrics per run:
// dan hit, note F1 ±20 ms, section density corr, pattern accuracy, violations per 1000 notes, jack loops (vs the
// human map), collapses (made > 3 dans under the ask), off-1/4 rows and divisor F1, the repeat-consistency gap when
// the generator answers with a structure, time; summaries per view (all / osu!-only / trills …) with paired
// bootstrap 95% CIs against the baseline engine, and the ship-rule verdict (exit code 2 on any NO-SHIP).
//
// Usage:
//   node tools/compare-mappers.mjs --a models/mapper.json --b A:/SneezeyTrain/candidates/mapper-xgb2.json --picks FILE
//   node tools/compare-mappers.mjs --model v1=models/mapper.json --model v15=A:/SneezeyTrain/models/mapper15.json --rules
//        --heldout 180 [--corpus A:/SneezeyTrain/corpus/corpus.jsonl] [--pool N (default: every held-out group)] [--max-sec 360] [--osu-share 0.5] [--pick-seed S]
//        [--save-picks FILE] [--list]
//   common: [--seeds 1,2,3] [--form range|target|both] [--snaps auto|q4|all[,…]] [--config FILE] [--jobs N]
//           [--limit N] [--out DIR] [--baseline LABEL] [--views all,osu,trills,etterna,variable,offgrid]
//           [--p95-budget 8] [--split FILE[,FILE]] [--no-heldout-check] [--ffmpeg PATH] [--iters 2000]
//   --picks     a JSON list like A:/SneezeyTrain/mapper15/eval-picks-wave1.json ({ osuPath, dan, primary, … }).
//   --heldout   build a stratified held-out set from the corpus split (dan 3–18 × 5 families, ≥ 30 variable-BPM,
//               ≥ 30 off-1/4, --osu-share of osu! sources) and save it (default <out>/heldout-<N>.json); later runs
//               pass that file as --picks so the set stays frozen.
//   --split     split index(es) to assert every pick is held out (default: the corpus index + every candidate's
//               training split that exists: mapper15/index*.jsonl, mapper3/heldout.json + index.jsonl); the run stops
//               when a pick is on the training side.
//   --config    JSON options { candidates, critic, repeats, style, infill, deadlineMs, per: { label: {…} } }; an
//               option the generator does not answer to is reported as "not available".
//   --snaps     q4 = [4], all = [4,3,6,8], auto = all on songs whose human map has ≥ 10% of beats off 1/4.
// Output (--out, default A:/SneezeyTrain/eval-v/compare-<time>): records.jsonl, summary.json, report.md.
// p95 times under --jobs > 1 run in parallel and read high; tools/bench-gen.mjs measures time alone.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFile, writeFile, mkdir, appendFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompareArgs, parseConfig, configFor, optionStatus, summarize, verdict, formatSummaryTable, fmt } from "./eval/compare.mjs";
import { loadSplitIndex, checkHeldout, readHeldoutPool, selectHeldout, labelChart, normPath, defaultSplitFiles } from "./eval/heldout.mjs";
import { loadSong, snapsOf, buildInput, runEngine, scoreRun, infillPlan, wantsStems } from "./eval/genRun.mjs";
import { parseOsu, toRows, chartKey } from "./corpus-index.mjs";
import { analyzeChart } from "../src/core/analyze.js";
import { numericToLabel } from "../src/core/labels.js";

const SELF = fileURLToPath(import.meta.url);
export const DEFAULT_CORPUS = "A:/SneezeyTrain/corpus/corpus.jsonl";
export const DEFAULT_OUT_ROOT = "A:/SneezeyTrain/eval-v";

// ---- one task (a song to evaluate, or a held-out chart to label) ----------------------------------------------

async function evalSong({ pick, index }, { engines, cfg, opts }) {
    const wantStems = await wantsStems(engines, (label) => configFor(cfg, label));
    const base0 = {
        song: index, id: pick.id ?? pick.chartKey ?? String(index), dan: pick.dan, primary: pick.primary ?? null,
        label: `${numericToLabel(pick.dan).text} ${pick.primary ?? ""}`.trim(), osuPath: pick.osuPath,
    };
    let song;
    try {
        song = await loadSong(pick, { ffmpeg: opts.ffmpeg, wantStems });
    } catch (e) {
        return [{ ok: false, ...base0, engine: "*", snaps: "*", form: "*", seed: 0, error: `load: ${e.message}` }];
    }
    const base = { ...base0, family: song.family, source: song.source, ...song.tags, bpm: song.bpm, red: song.red, stems: !!song.stems };
    const out = [];
    for (const engine of engines) {
        const ecfg = configFor(cfg, engine.label);
        for (const snaps of engine.kind === "rules" ? ["q4"] : opts.snaps) {
            for (const form of opts.forms) {
                for (const seed of opts.seeds) {
                    const infill = ecfg.infill && engine.kind !== "rules" ? infillPlan(song) : null;
                    const input = buildInput(song, { form, seed, snaps: snapsOf(snaps, song), cfg: ecfg, infill });
                    const rec = { ...base, engine: engine.label, snaps, form, seed, snapsUsed: input.request.snaps.join(",") };
                    try {
                        const { response, ms, phases } = await runEngine(engine, input, { cfg: ecfg });
                        out.push({ ok: true, ...rec, ...scoreRun(song, response, { infill }), ms, phases, status: optionStatus(ecfg, response, { infillRan: !!infill }) });
                    } catch (e) {
                        out.push({ ok: false, ...rec, error: String(e?.message ?? e) });
                    }
                }
            }
        }
    }
    return out;
}

async function labelTask({ line }) {
    try {
        const text = await readFile(line.osu, "utf8");
        const labels = await labelChart(text, analyzeChart);
        if (!labels) return null;
        if (!(await stat(line.audio).catch(() => null))) return null;
        return { ...labels, id: line.chartKey, chartKey: line.chartKey, group: line.group, source: line.source, songKey: line.songKey,
            osuPath: line.osu, audioPath: line.audio, rate: line.rate, danTracker: line.labels?.rawDan ?? null };
    } catch {
        return null;
    }
}

async function handle(task, ctx) {
    if (task.type === "song") return evalSong(task, ctx);
    if (task.type === "label") return labelTask(task);
    throw new Error(`unknown task ${task.type}`);
}

if (!isMainThread && workerData?.self === SELF) {
    parentPort.on("message", async (task) => {
        parentPort.postMessage({ task, result: await handle(task, workerData.ctx) });
    });
}

// tasks → handle() in `jobs` worker threads (in this thread when jobs is 1); onResult(task, result) in order of
// completion.
async function runPool(tasks, jobs, ctx, onResult) {
    if (jobs <= 1 || tasks.length <= 1) {
        for (const t of tasks) onResult(t, await handle(t, ctx));
        return;
    }
    let next = 0;
    const one = () => new Promise((resolve, reject) => {
        const w = new Worker(SELF, { workerData: { self: SELF, ctx } });
        const feed = () => {
            if (next >= tasks.length) {
                w.terminate().then(resolve, resolve);
                return;
            }
            w.postMessage(tasks[next++]);
        };
        w.on("message", ({ task, result }) => {
            onResult(task, result);
            feed();
        });
        w.on("error", reject);
        feed();
    });
    await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, one));
}

// ---- main ------------------------------------------------------------------------------------------------------

const stamp = () => new Date().toISOString().slice(0, 16).replace(/:/g, "-");

function chartKeyOfFile(pick) {
    try {
        return chartKey(toRows(parseOsu(readFileSync(pick.osuPath, "utf8")).objects));
    } catch {
        return null;
    }
}

// --split, else the corpus and every candidate's split files that exist (tools/eval/heldout.mjs CANDIDATE_SPLITS).
function splitFilesOf(args) {
    return args.split ? args.split.split(",") : defaultSplitFiles(args.corpus ?? DEFAULT_CORPUS);
}

async function buildHeldout(args, outDir, ctx) {
    const corpus = args.corpus ?? DEFAULT_CORPUS;
    // charts longer than --max-sec (marathons) are left out: they cost minutes per variant; so is every chart a
    // candidate trained on (mapper15's train split, mapper3's train/val, by path, chart key, group or song key)
    const files = splitFilesOf(args);
    const index = await loadSplitIndex(files);
    const pool = await readHeldoutPool(corpus, { seed: args.pickSeed, maxSpanMs: args.maxSec * 1000, index });
    const want = args.pool || pool.length;
    console.log(`held-out pool: ${pool.length} song groups in ${corpus} (${pool.dropped} held-out lines left out: trained on in ${files.slice(1).join(", ") || "-"}); labelling up to ${want} (dan, family, BPM changes, off-1/4 beats)`);
    const labelled = [];
    const tasks = pool.slice(0, want).map((line) => ({ type: "label", line }));
    let done = 0;
    await runPool(tasks, args.jobs, ctx, (task, result) => {
        done += 1;
        if (result) labelled.push({ ...result, order: task.line.order });
        if (done % 50 === 0) console.log(`  labelled ${done}/${tasks.length}`);
    });
    labelled.sort((a, b) => (a.order < b.order ? -1 : 1));
    const { picks, notes } = selectHeldout(labelled, { n: args.heldout, osuShare: args.osuShare });
    for (const n of notes) console.log(`  note: ${n}`);
    const file = args.savePicks ?? path.join(outDir, `heldout-${args.heldout}.json`);
    await writeFile(file, JSON.stringify(picks.map(({ order, ...p }) => p), null, 1));
    console.log(`saved ${picks.length} held-out picks to ${file}`);
    return { picks, file };
}

function perSongTable(records, engines, snapsList, form) {
    const songs = [...new Map(records.map((r) => [r.song, r])).values()].sort((a, b) => a.song - b.song);
    const cols = [];
    for (const e of engines) for (const s of e.kind === "rules" ? ["q4"] : snapsList) cols.push([e.label, s]);
    const head = ["#", "song", "bpm", "human off-1/4", ...cols.map(([e, s]) => `${e} ${s}`)];
    const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
    for (const s of songs) {
        const cells = cols.map(([e, sn]) => {
            const r = records.find((x) => x.ok && x.song === s.song && x.engine === e && x.snaps === sn && x.form === form && x.seed === Math.min(...records.map((y) => y.seed).filter(Number.isFinite)));
            if (!r) return "—";
            return `${r.numeric ?? "–"} ${r.reachable ? "✓" : "✗"} F1 ${fmt(r.f1, 2)}${r.offQuarterRows > 0.005 ? ` off ${fmt(r.offQuarterRows, 2)}` : ""}`;
        });
        lines.push(`| ${[s.song, s.label, Math.round(s.bpm ?? 0), fmt(s.humanOffQuarter, 2), ...cells].join(" | ")} |`);
    }
    return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseCompareArgs(argv);
    const cfg = parseConfig(args.config ? await readFile(args.config, "utf8") : null, { baseDir: args.config ? path.dirname(path.resolve(args.config)) : "." });
    const outDir = path.resolve(args.out ?? path.join(DEFAULT_OUT_ROOT, `compare-${stamp()}`));
    await mkdir(outDir, { recursive: true });
    const opts = { seeds: args.seeds, forms: args.forms, snaps: args.snaps, ffmpeg: args.ffmpeg };
    const ctx = { engines: args.engines, cfg, opts };
    const jobs = Math.min(args.jobs, Math.max(1, availableParallelism() - 1));
    if (args.from) return resummarize(args, argv, cfg, outDir);

    let picks;
    let picksFile = args.picks ? path.resolve(args.picks) : null;
    if (args.picks) picks = JSON.parse(await readFile(args.picks, "utf8"));
    else ({ picks, file: picksFile } = await buildHeldout({ ...args, jobs }, outDir, ctx));
    if (args.list) {
        for (const p of picks) console.log(`${numericToLabel(p.dan).text.padEnd(16)} ${String(p.primary ?? p.family ?? "").padEnd(11)} ${Math.round(p.bpm ?? 0)}bpm ${p.source ?? ""} ${p.osuPath}`);
        return 0;
    }
    if (args.limit) picks = picks.slice(0, args.limit);

    // ---- the held-out assertion (plan §10 Gate 0) ----
    let heldoutLine = "held-out check: skipped (--no-heldout-check)";
    if (args.heldoutCheck) {
        const files = splitFilesOf(args);
        for (const f of files) if (!(await stat(f).catch(() => null))) throw new Error(`split index ${f} not found (give --split or --no-heldout-check)`);
        const index = await loadSplitIndex(files);
        const r = checkHeldout(picks, index, { chartKeyOf: chartKeyOfFile });
        if (r.problems.length) {
            for (const p of r.problems.slice(0, 20)) console.error(`  not held out (${p.reason}): #${p.i} ${p.osuPath}`);
            throw new Error(`held-out check failed: ${r.problems.length} of ${picks.length} picks are not held out in ${files.join(", ")}`);
        }
        // sources from the index (the frozen wave-1 picks carry none)
        for (const p of picks) {
            if (p.source) continue;
            const e = index.byPath.get(normPath(p.osuPath));
            if (e?.source) p.source = e.source;
        }
        heldoutLine = `held-out check: ${r.ok}/${picks.length} picks held out in ${files.join(", ")}`;
    }
    console.log(heldoutLine);
    console.log(`${picks.length} songs × ${args.engines.map((e) => e.label).join(", ")} × snaps ${args.snaps.join("/")} × form ${args.forms.join("/")} × seeds ${args.seeds.join(",")}; ${jobs} job(s); out ${outDir}`);

    const recordsFile = path.join(outDir, "records.jsonl");
    await writeFile(recordsFile, "");
    const records = [];
    const t0 = Date.now();
    let done = 0;
    let writes = Promise.resolve(); // one append at a time, in completion order
    await runPool(picks.map((pick, index) => ({ type: "song", pick, index })), jobs, ctx, (task, recs) => {
        done += 1;
        records.push(...recs);
        const lines = recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
        writes = writes.then(() => appendFile(recordsFile, lines));
        const first = recs.find((r) => r.ok) ?? recs[0];
        const bits = [];
        for (const e of args.engines) {
            const mine = recs.filter((r) => r.engine === e.label && r.ok);
            if (!mine.length) continue;
            const hit = mine.filter((r) => r.reachable).length;
            const f1 = mine.reduce((s, r) => s + r.f1, 0) / mine.length;
            bits.push(`${e.label} ${hit}/${mine.length} F1 ${f1.toFixed(2)}`);
        }
        const failed = recs.filter((r) => !r.ok);
        console.log(`[${done}/${picks.length}] ${first.label.padEnd(26)} ${bits.join(" | ")}${failed.length ? ` | ${failed.length} failed: ${failed[0].error}` : ""}`);
    });
    await writes;
    const minutes = (Date.now() - t0) / 60000;
    return writeReport({ args, argv, cfg, outDir, records, picksCount: picks.length, picksFile, heldoutLine, jobs, minutes });
}

// --from records.jsonl: the summary, verdicts and report of an earlier run again (other views or baseline).
async function resummarize(args, argv, cfg, outDir) {
    const records = (await readFile(args.from, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const real = records.filter((r) => r.engine !== "*");
    const uniq = (f) => [...new Set(real.map(f))];
    const engines = args.engines.length ? args.engines : uniq((r) => r.engine).map((label) => ({ label, kind: label === "rules" ? "rules" : "model", path: "?" }));
    const derived = {
        ...args, engines, snaps: uniq((r) => r.snaps), forms: uniq((r) => r.form), seeds: uniq((r) => r.seed).sort((a, b) => a - b),
        baseline: args.baseline ?? engines[0].label,
    };
    if (!engines.some((e) => e.label === derived.baseline)) throw new Error(`--baseline ${derived.baseline} is not an engine of ${args.from}`);
    return writeReport({ args: derived, argv, cfg, outDir, records, picksCount: new Set(records.map((r) => r.song)).size, picksFile: args.from,
        heldoutLine: "held-out check: done by the run that wrote the records", jobs: 0, minutes: 0 });
}

async function writeReport({ args, argv, cfg, outDir, records: all, picksCount, picksFile, heldoutLine, jobs, minutes }) {
    const records = [...all].sort((a, b) => a.song - b.song);
    // songs whose audio or chart could not be read are listed, not summarised
    const loadFailed = records.filter((r) => r.engine === "*");
    for (const r of loadFailed) console.log(`not evaluated: #${r.song} ${r.osuPath}: ${r.error}`);
    const evaluated = records.filter((r) => r.engine !== "*");

    // ---- summary, availability, verdicts ----
    const summary = summarize(evaluated, { baseline: args.baseline, views: args.views, iters: args.iters });
    const at = (list, v) => (list.indexOf(v) < 0 ? list.length : list.indexOf(v));
    const labels = args.engines.map((e) => e.label);
    summary.sort((a, b) => at(args.views, a.view) - at(args.views, b.view) || at(args.forms, a.form) - at(args.forms, b.form)
        || at(args.snaps, a.snaps) - at(args.snaps, b.snaps) || at(labels, a.engine) - at(labels, b.engine));
    const avail = {};
    for (const e of args.engines) {
        const mine = evaluated.filter((r) => r.ok && r.engine === e.label);
        const opts1 = Object.keys(mine[0]?.status ?? optionStatus(configFor(cfg, e.label), null));
        avail[e.label] = Object.fromEntries(opts1.map((k) => {
            const s = mine.map((r) => r.status[k]);
            const used = s.filter((x) => x === "used").length;
            const asked = s.some((x) => x !== "off");
            return [k, !asked ? "off" : used === 0 ? "not available" : used === s.length ? "used" : `partial (${used}/${s.length})`];
        }));
    }
    const verdicts = [];
    for (const row of summary.filter((r) => r.view === "all" && r.engine !== args.baseline)) {
        const engine = args.engines.find((e) => e.label === row.engine);
        if (engine?.kind === "rules") continue;
        const base = summary.find((r) => r.view === "all" && r.engine === args.baseline && r.snaps === row.snaps && r.form === row.form)
            ?? summary.find((r) => r.view === "all" && r.engine === args.baseline && r.form === row.form);
        if (!base) continue;
        verdicts.push({ engine: row.engine, snaps: row.snaps, form: row.form, vs: `${base.engine} ${base.snaps} ${base.form}`, ...verdict(base, row, { p95BudgetMs: args.p95BudgetMs }) });
    }

    const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.dirname(SELF), encoding: "utf8" }).stdout?.trim() || "?";
    const views = [...new Set(summary.map((r) => r.view))];
    const md = [
        `# compare-mappers ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        "",
        `- command: \`node tools/compare-mappers.mjs ${argv.join(" ")}\``,
        `- generator: v3 at ${commit} (this worktree); songs: ${picksFile ?? "held-out build"} (${picksCount}); ${heldoutLine}`,
        `- engines: ${args.engines.map((e) => `${e.label} = ${e.kind === "rules" ? "rule generator" : e.path}`).join("; ")}; baseline ${args.baseline}`,
        `- seeds ${args.seeds.join(",")}; forms ${args.forms.join(", ")} (range = the human dan ± 0.5; target = the strict label); snaps ${args.snaps.join(", ")}`,
        `- ${jobs} parallel job(s) on ${cpus()[0]?.model ?? "?"}; ${minutes.toFixed(1)} min; times are per variant and read high under parallel jobs`,
        `- collapse = made more than 3 dans under the ask; off-1/4 rows = share of generated rows on 1/3, 1/6, 1/8 (human: share of beats that need them); div F1 = F1 over beats on 1/3, 1/6, 1/8, same grid as the human beat`,
        "",
        "## Options (--config)",
        "",
        `\`${JSON.stringify(cfg)}\``,
        "",
        ...args.engines.map((e) => `- ${e.label}: ${Object.entries(avail[e.label] ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")}`),
        "",
        ...views.flatMap((v) => {
            const rows = summary.filter((r) => r.view === v);
            const songs = Math.max(0, ...rows.map((r) => r.songs));
            return [`## View: ${v} (${songs} songs)`, "", formatSummaryTable(rows), ""];
        }),
        "## Verdicts (view all, against the baseline at the same snaps and form)",
        "",
        ...verdicts.map((v) => `- **${v.ship ? "SHIP" : "NO-SHIP"}** ${v.engine} ${v.snaps} ${v.form} vs ${v.vs}: ${v.checks.map((c) => `${c.name} ${c.ok ? "ok" : "FAIL"} (${fmt(c.value, c.name === "p95" ? 0 : 3)} ${c.limit})`).join(", ")}`),
        "",
        `## Per song (${args.forms[0]} form, seed ${Math.min(...args.seeds)}): made dan, in range, F1, off-1/4 row share`,
        "",
        perSongTable(evaluated, args.engines, args.snaps, args.forms[0]),
        ...(loadFailed.length ? ["", `Not evaluated (audio or chart unreadable): ${loadFailed.map((r) => `#${r.song} ${r.osuPath} (${r.error})`).join("; ")}`] : []),
        "",
    ].join("\n");
    await writeFile(path.join(outDir, "summary.json"), JSON.stringify({ argv, picks: picksFile, heldout: heldoutLine, config: cfg, availability: avail, summary, verdicts, minutes }, null, 1));
    await writeFile(path.join(outDir, "report.md"), md);
    for (const v of views) {
        console.log(`\n== ${v} ==`);
        console.log(formatSummaryTable(summary.filter((r) => r.view === v)));
    }
    console.log("");
    for (const v of verdicts) console.log(`${v.ship ? "SHIP   " : "NO-SHIP"} ${v.engine} ${v.snaps} ${v.form} vs ${v.vs}${v.ship ? "" : `: ${v.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`}`);
    console.log(`\nwrote ${path.join(outDir, "report.md")}`);
    return verdicts.some((v) => !v.ship) ? 2 : 0;
}

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
    main().then((code) => process.exit(code), (e) => {
        console.error(e?.stack ?? e);
        process.exit(1);
    });
}
