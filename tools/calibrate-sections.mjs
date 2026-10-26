// The correction of the per-part dans (src/analysis/sections.js) for what a short part lacks against the whole map,
// fitted on the training corpus: for a sample of charts across dans, the card's dan of the whole map (analyzeChart)
// and the raw dans of its parts (the model on each part alone); the fit asks the hardest part's corrected dan to be the
// whole map's dan. Least squares on
//   whole − raw_top = offset(raw_top) + lengthGain · ln(TARGET_SEC / partSec_top) + supportGain · ln(1 + supportSec_top / 60)
// (offset piecewise linear between KNOTS, src/analysis/sections.js calibratedDan) on two thirds of the song groups, the error told on the other third, then written to src/analysis/sectionCalibration.js.
// The corpus is only read.
//
// Usage: node tools/calibrate-sections.mjs gather <out.jsonl> [--per-bin 170] [--threads 12] [--corpus FILE]
//        node tools/calibrate-sections.mjs fit <in.jsonl> [--write]
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = path.join(path.dirname(SELF), "..");
const CORPUS = "A:/SneezeyTrain/corpus/corpus.jsonl";
const KNOTS = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
const ZERO = { knots: KNOTS, offsets: KNOTS.map(() => 0), lengthGain: 0, supportGain: 0 };
const SMOOTH = 0.05; // the ridge between neighbouring knots' offsets, per chart

const hash = (s) => createHash("sha1").update(s).digest("hex");
const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
};

async function measure(file) {
    const { analyzeChart } = await import("../src/core/analyze.js");
    const { computeSections } = await import("../src/analysis/sections.js");
    const text = readFileSync(file, "utf8");
    const t0 = performance.now();
    const whole = await analyzeChart(text, 1);
    const t1 = performance.now();
    if (whole?.kind !== "ok") return { skip: whole?.kind ?? "?" };
    const s = await computeSections(text, 1);
    const t2 = performance.now();
    return {
        whole: whole.numeric,
        durationSec: s.durationSec,
        wholeMs: Math.round(t1 - t0),
        partsMs: Math.round(t2 - t1),
        parts: s.parts.map((p) => ({ fromSec: p.fromSec, toSec: p.toSec, notes: p.notes, raw: p.raw })),
    };
}

if (!isMainThread) {
    parentPort.on("message", async ({ id, file }) => {
        try {
            parentPort.postMessage({ id, ...(await measure(file)) });
        } catch (error) {
            parentPort.postMessage({ id, skip: String(error?.message ?? error) });
        }
    });
} else if (process.argv[2] === "gather") {
    const out = process.argv[3];
    const perBin = Number(arg("--per-bin", 170));
    const threads = Number(arg("--threads", 12));
    const lines = readFileSync(arg("--corpus", CORPUS), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // a fixed sample: per dan bin (and a few per MSD bin) the charts with the smallest hash of their key
    const bins = new Map();
    for (const c of lines) {
        if (!c.danBin || c.danBin === "none" || !existsSync(c.osu)) continue;
        if (!bins.has(c.danBin)) bins.set(c.danBin, []);
        bins.get(c.danBin).push(c);
    }
    const sample = [];
    for (const [bin, list] of bins) {
        const n = bin.startsWith("dan:") ? perBin : Math.round(perBin / 5);
        sample.push(...list.sort((a, b) => hash(a.chartKey).localeCompare(hash(b.chartKey))).slice(0, n));
    }
    const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).chartKey) : []);
    const todo = sample.filter((c) => !done.has(c.chartKey));
    console.log(`sample ${sample.length}, to do ${todo.length}`);
    let next = 0;
    let finished = 0;
    const started = Date.now();
    await Promise.all(Array.from({ length: threads }, () => new Promise((resolve) => {
        const w = new Worker(SELF);
        const feed = () => {
            if (next >= todo.length) {
                w.terminate().then(resolve);
                return;
            }
            const id = next++;
            w.postMessage({ id, file: todo[id].osu });
        };
        w.on("message", (m) => {
            const c = todo[m.id];
            appendFileSync(out, `${JSON.stringify({ chartKey: c.chartKey, group: c.group, danBin: c.danBin, osu: c.osu, ...m, id: undefined })}\n`);
            finished += 1;
            if (finished % 100 === 0) console.log(`${finished}/${todo.length} ${Math.round((Date.now() - started) / 1000)} s`);
            feed();
        });
        feed();
    })));
    console.log("done");
} else if (process.argv[2] === "fit") {
    const { applyCalibration, calibrationTerms, supportSeconds } = await import("../src/analysis/sections.js");
    const rows = readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        .filter((r) => Number.isFinite(r.whole) && r.parts?.some((p) => Number.isFinite(p.raw)));
    const testSet = (r) => parseInt(hash(r.group ?? r.chartKey).slice(0, 8), 16) % 3 === 0;
    const train = rows.filter((r) => !testSet(r));
    const test = rows.filter(testSet);
    const K = KNOTS.length;
    const k = K + 2;
    // the design row of a chart's part i: hats, length, support
    const design = (r, i, support) => {
        const p = r.parts[i];
        const { hats, length, support: s } = calibrationTerms(p.raw, { partSec: p.toSec - p.fromSec, supportSec: support[i] }, KNOTS);
        return [...hats, length, s];
    };
    const solve = (A, b) => {
        const M = A.map((row, i) => [...row, b[i]]);
        for (let c = 0; c < k; c += 1) {
            let p = c;
            for (let r = c + 1; r < k; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
            [M[c], M[p]] = [M[p], M[c]];
            for (let r = 0; r < k; r += 1) {
                if (r === c) continue;
                const f = M[r][c] / M[c][c];
                for (let j = c; j <= k; j += 1) M[r][j] -= f * M[c][j];
            }
        }
        return M.map((row, i) => row[k] / M[i][i]);
    };
    const round3 = (x) => Math.round(x * 1000) / 1000;
    const asCalibration = (beta) => ({ knots: KNOTS, offsets: beta.slice(0, K).map(round3), lengthGain: round3(beta[K]), supportGain: round3(beta[K + 1]) });
    // least squares of (whole − raw) on the part that is the hardest: the raw hardest first, then the corrected one
    // (twice more), with a smoothness ridge between neighbouring knots
    let fitted = ZERO;
    for (let round = 0; round < 3; round += 1) {
        const A = Array.from({ length: k }, () => new Array(k).fill(0));
        const b = new Array(k).fill(0);
        for (const r of train) {
            const support = supportSeconds(r.parts);
            const i = applyCalibration(r.parts, fitted).top;
            const x = design(r, i, support);
            const y = r.whole - r.parts[i].raw;
            for (let u = 0; u < k; u += 1) {
                b[u] += x[u] * y;
                for (let v = 0; v < k; v += 1) A[u][v] += x[u] * x[v];
            }
        }
        const smooth = SMOOTH * train.length / K;
        for (let u = 0; u + 1 < K; u += 1) {
            A[u][u] += smooth;
            A[u + 1][u + 1] += smooth;
            A[u][u + 1] -= smooth;
            A[u + 1][u] -= smooth;
        }
        for (let u = 0; u < k; u += 1) A[u][u] += 1e-4 * train.length;
        fitted = asCalibration(solve(A, b));
    }
    // the error of the hardest part against the whole map's dan: raw, and corrected (the corrected parts' maximum)
    const report = (set, c) => {
        const errs = set.map((r) => {
            const { parts, top } = applyCalibration(r.parts, c);
            return parts[top].dan - r.whole;
        });
        const mae = errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
        const bias = errs.reduce((s, e) => s + e, 0) / errs.length;
        const rmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
        const within = (d) => errs.filter((e) => Math.abs(e) <= d + 1e-9).length / errs.length;
        return { n: errs.length, bias: round3(bias), mae: round3(mae), rmse: round3(rmse), within05: round3(within(0.5)), within1: round3(within(1)) };
    };
    const byDan = (set, c) => {
        const out = {};
        for (const r of set) (out[Math.min(19, Math.max(1, Math.round((r.whole + 1) / 3) * 3 - 1))] ??= []).push(r);
        return Object.fromEntries(Object.entries(out).sort((a, b) => a[0] - b[0])
            .map(([band, list]) => [band, `raw ${report(list, ZERO).bias}/${report(list, ZERO).mae} → ${report(list, c).bias}/${report(list, c).mae} (bias/MAE, n ${list.length})`]));
    };
    const partsPer = rows.map((r) => r.parts.length);
    const ms = rows.map((r) => r.partsMs).sort((a, b) => a - b);
    const whole = rows.map((r) => r.wholeMs).sort((a, b) => a - b);
    const summary = {
        charts: rows.length, train: train.length, test: test.length,
        parts: partsPer.reduce((a, b) => a + b, 0),
        partsPerChart: round3(partsPer.reduce((a, b) => a + b, 0) / rows.length),
        partsMsMedian: ms[Math.floor(ms.length / 2)], partsMsP95: ms[Math.floor(ms.length * 0.95)],
        wholeMsMedian: whole[Math.floor(whole.length / 2)],
        fitted,
        testRaw: report(test, ZERO), testFitted: report(test, fitted),
        trainRaw: report(train, ZERO), trainFitted: report(train, fitted),
        testByDan: byDan(test, fitted),
    };
    console.log(JSON.stringify(summary, null, 1));
    if (process.argv.includes("--write")) {
        const file = path.join(REPO, "src/analysis/sectionCalibration.js");
        const list = (xs) => `[${xs.join(", ")}]`;
        writeFileSync(file, `// Written by tools/calibrate-sections.mjs (fit) from ${summary.charts} corpus charts across dans (${summary.parts} parts): the
// correction of a part's raw dan (src/analysis/sections.js calibratedDan). The hardest part against the whole map's
// dan on the held-out third (${summary.test} charts): raw bias ${summary.testRaw.bias}, MAE ${summary.testRaw.mae}, RMSE ${summary.testRaw.rmse};
// corrected bias ${summary.testFitted.bias}, MAE ${summary.testFitted.mae}, RMSE ${summary.testFitted.rmse}.
export const CALIBRATION = Object.freeze({
    knots: ${list(fitted.knots)},
    offsets: ${list(fitted.offsets)},
    lengthGain: ${fitted.lengthGain},
    supportGain: ${fitted.supportGain},
});
`);
        console.log(`written ${file}`);
    }
}
