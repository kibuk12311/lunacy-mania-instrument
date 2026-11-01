// The overlay's KPS and key lines in osu! stable, before (0.10.5: rebuilt from tosu's judgement counts) and after (the
// keyboard reader's real presses), on the same made-up play under three kinds of tosu feed (tests/helpers/playSim.js:
// steady, jittery, and jittery with tosu's reading stalling for 1.2 s every 4 s), at 1× and DT.
// node tools/measure-key-lines.mjs [--json]
import { NETWORKS, simulatePlay } from "../tests/helpers/playSim.js";

const rows = [];
for (const network of Object.keys(NETWORKS)) {
    for (const rate of [1, 1.5]) {
        for (const source of ["map", "kbd"]) rows.push({ network, rate, ...simulatePlay({ source, network, rate, seed: 7 }) });
    }
}
if (process.argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 1));
} else {
    const f = (x, d = 2) => x.toFixed(d);
    console.log("feed     rate source  presses counted  no-bar  bar start err ms (mean/p95/max)  bar end err  KPS now err (mean/max)  KPS max (true)");
    for (const r of rows) {
        console.log([
            r.network.padEnd(8), `${r.rate}×`.padEnd(4), (r.source === "kbd" ? "keys" : "map").padEnd(7),
            String(r.presses).padStart(7), String(r.counted).padStart(8), String(r.unmatched).padStart(7),
            `${f(r.startMean)} / ${f(r.startP95)} / ${f(r.startMax)}`.padStart(33),
            f(r.endMean).padStart(12), `${f(r.kpsNowMean)} / ${f(r.kpsNowMax)}`.padStart(23),
            `${f(r.kpsMax)} (${f(r.trueMax)})`.padStart(16),
        ].join(" "));
    }
    for (const [name, n] of Object.entries(NETWORKS)) console.log(`  ${name}: ${n.label}`);
}
