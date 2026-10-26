// Bench of the personal reranker's fit (src/gen/personal.js, addendum §2.7 / U1): IRLS on the store's cap of 2000
// votes × 250 features must converge within 25 iterations; prints the time, the iterations and the leave-one-out AUC.
// Not a unit test (timing depends on the machine). Run with: node tools/bench-personal.mjs [n=2000] [p=250] [runs=3]
import { fitPersonal, MAX_ITER } from "../src/gen/personal.js";

const arg = (name, fallback) => Number(process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback);
const n = arg("n", 2000);
const p = arg("p", 250);
const runs = arg("runs", 3);

// mulberry32 and a normal from it, so every run sees the same votes
let a = 12345;
const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

// a taste that lives in 10 of the features, plus noise votes (a real user is not consistent)
const names = Array.from({ length: p }, (_, j) => `f${j}`);
const truth = names.map((_, j) => (j < 10 ? (j % 2 ? -0.8 : 0.8) : 0));
const entries = Array.from({ length: n }, () => {
    const features = names.map(() => normal());
    const logit = features.reduce((s, x, j) => s + x * truth[j], 0) + 0.5 * normal();
    return { vote: logit > 0 ? 1 : -1, tags: next() < 0.1 ? ["tooJacky"] : [], names, features };
});

const times = [];
let last = null;
for (let r = 0; r < runs; r += 1) {
    const t0 = performance.now();
    last = await fitPersonal(entries);
    times.push(performance.now() - t0);
}
times.sort((x, y) => x - y);
console.log(JSON.stringify({
    n, p, runs, msMedian: Math.round(times[Math.floor(times.length / 2)]), msAll: times.map(Math.round),
    iterations: last.iterations, converged: last.converged, withinCap: last.iterations <= MAX_ITER,
    looAuc: last.looAuc, active: last.active, weight: last.weight,
}));
if (!last.converged || last.iterations > MAX_ITER) process.exitCode = 1;
