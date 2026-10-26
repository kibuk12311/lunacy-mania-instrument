// Benchmark → data/features.jsonl (one line per 4K rice chart). Rates are baked into the .osu files, so rate = 1.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readBenchRows, findOsuFile } from "./bench-rows.mjs";
import { computeFeatures } from "../src/core/features.js";

const benchRoot = process.argv[2] ?? "data/bench";
const outPath = process.argv[3] ?? "data/features.jsonl";
const samplesRoot = path.join(benchRoot, "samples");

const rows = await readBenchRows(path.join(samplesRoot, "data.csv"));
const counts = { ok: 0, ln: 0, notRice: 0, missing: 0, failed: 0 };
const out = [];

for (const [i, row] of rows.entries()) {
    if (row.pattern === "ln") {
        counts.ln += 1;
        continue;
    }
    const file = await findOsuFile(samplesRoot, row.pattern, row.name);
    if (!file) {
        counts.missing += 1;
        console.log(`Missing  ${row.name}`);
        continue;
    }
    try {
        const f = await computeFeatures(await readFile(file, "utf8"), 1);
        if (!f.rice) {
            counts.notRice += 1;
            continue;
        }
        out.push(JSON.stringify({
            name: row.name, pattern: row.pattern, subPattern: row.subPattern,
            expected: row.expected, group: row.group, vector: f.vector,
        }));
        counts.ok += 1;
    } catch (error) {
        counts.failed += 1;
        console.log(`Failed   ${row.name}: ${error.message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`${i + 1}/${rows.length}`);
}

await writeFile(outPath, out.join("\n") + "\n", "utf8");
console.log(JSON.stringify({ total: rows.length, ...counts }));
