// Benchmark rows first added after the last change to any benchmark-tuned LeoBlack estimator.
// Those rows cannot have influenced Azusa/Roxy/Mixed calibration, so they are an honest test set.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const leoblackRepo = process.argv[2] ?? "data/leoblack";
const benchRepo = process.argv[3] ?? "data/bench";
const outPath = process.argv[4] ?? "data/clean-names.json";

const TUNED_FILES = [
    "ManiaMapAnalyser by Leo_Black/js/estimator/azusaEstimator.js",
    "ManiaMapAnalyser by Leo_Black/js/estimator/roxyEstimator.js",
    "ManiaMapAnalyser by Leo_Black/js/estimator/roxyMetaModel.generated.js",
    "ManiaMapAnalyser by Leo_Black/js/estimator/mixedEstimator.js",
    "ManiaMapAnalyser by Leo_Black/js/estimator/marathonCorrection.js",
];

function git(repo, args) {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

const cutoff = TUNED_FILES
    .map((file) => git(leoblackRepo, ["log", "-1", "--format=%cI", "--", file]).trim())
    .filter(Boolean)
    .sort()
    .at(-1);

const firstSeen = new Map();
let commitDate = null;
const log = git(benchRepo, ["log", "--reverse", "--format=__C %cI", "-p", "--unified=0", "--", "samples/data.csv"]);
for (const line of log.split(/\r?\n/)) {
    if (line.startsWith("__C ")) {
        commitDate = line.slice(4).trim();
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
        const name = line.slice(1).split(",")[1];
        if (name && name !== "name" && !firstSeen.has(name)) firstSeen.set(name, commitDate);
    }
}

const clean = [...firstSeen].filter(([, date]) => new Date(date) > new Date(cutoff)).map(([name]) => name);
writeFileSync(outPath, JSON.stringify({ cutoff, names: clean }, null, 1), "utf8");
console.log(JSON.stringify({ cutoff, totalSeen: firstSeen.size, clean: clean.length }));
