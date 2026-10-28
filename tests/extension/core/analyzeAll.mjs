// Child process of the parity test: node analyzeAll.mjs <analyze.js file URL> <jobs.json> → JSON results on stdout.
// One analyzer per process: two copies in one process share ONNX Runtime's global state and the second one's
// Companella fails, so the original and the built copy each get a process of their own.
import { readFile } from "node:fs/promises";

const [moduleUrl, jobsFile] = process.argv.slice(2);
const { analyzeChart } = await import(moduleUrl);
const jobs = JSON.parse(await readFile(jobsFile, "utf8"));
const out = [];
for (const { text, rate } of jobs) out.push(await analyzeChart(text, rate));
process.stdout.write(JSON.stringify(out));
