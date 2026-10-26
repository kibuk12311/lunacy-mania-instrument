// Evaluates a critic (critic.json from tools/train_critic.py) with the app's own scorer (src/gen/critic.js) on the
// rows of tools/make-critic-negatives.mjs: AUC of human maps against each kind of negative (v3 generator, v2,
// each perturbation), on the human head and on the whole stage-1 score, plus the addendum §7 checks
// (vs v3-generated ≥ 0.85, vs perturbed ≥ 0.90). Only original rows of the chosen split count (no mirrors).
// With --second, a second critic (other seed, other negative seeds) is scored on the same rows: rank agreement of
// the two, and how often both put the human above its own negatives.
// With --osu, one map: its features, its score, and the features that pull it furthest from human maps.
//
// Usage: node tools/eval-critic.mjs --data A:/SneezeyTrain/critic/data --critic A:/SneezeyTrain/critic/critic.json
//          [--split test] [--second other-critic.json] [--json out.json]
//        node tools/eval-critic.mjs --critic critic.json --osu map.osu [--audio song.mp3] [--dan 7.5]
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCritic, criticFor } from "../src/gen/critic.js";
import { CRITIC_FEATURES, criticFeatures } from "../src/gen/criticFeatures.js";
import { parseRedTimingPoints } from "../src/gen/grid.js";
import { parseRows, labelSlots } from "../src/gen/mapRows.js";
import { chartSlots } from "./make-critic-negatives.mjs";

const SHIP = { gen: 0.85, perturb: 0.9 };

// Mann–Whitney AUC with ties counted half.
export function aucOf(pos, neg) {
    if (!pos.length || !neg.length) return null;
    const all = [...pos.map((s) => [s, 1]), ...neg.map((s) => [s, 0])].sort((a, b) => a[0] - b[0]);
    let rankSum = 0;
    for (let i = 0; i < all.length;) {
        let j = i;
        while (j < all.length && all[j][0] === all[i][0]) j += 1;
        const rank = (i + j + 1) / 2; // 1-based average rank of the tie block
        for (let k = i; k < j; k += 1) if (all[k][1]) rankSum += rank;
        i = j;
    }
    return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

export function spearman(a, b) {
    const rank = (v) => {
        const order = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
        const r = new Float64Array(v.length);
        order.forEach(([, i], k) => { r[i] = k; });
        return r;
    };
    const ra = rank(a);
    const rb = rank(b);
    const n = a.length;
    if (n < 3) return null;
    const m = (n - 1) / 2;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < n; i += 1) {
        sab += (ra[i] - m) * (rb[i] - m);
        saa += (ra[i] - m) ** 2;
        sbb += (rb[i] - m) ** 2;
    }
    return sab / Math.sqrt(saa * sbb);
}

// AUCs of humans against each negative kind (and perturbation), for one score per row.
export function kindAucs(rows, scoreOf) {
    const humans = rows.filter((r) => r.kind === "human").map(scoreOf);
    const out = { humans: humans.length, all: aucOf(humans, rows.filter((r) => r.kind !== "human").map(scoreOf)) };
    for (const kind of [...new Set(rows.map((r) => r.kind))].filter((k) => k !== "human").sort()) {
        out[kind] = aucOf(humans, rows.filter((r) => r.kind === kind).map(scoreOf));
    }
    for (const sub of [...new Set(rows.filter((r) => r.kind === "perturb").map((r) => r.sub))].filter(Boolean).sort()) {
        out[`perturb:${sub}`] = aucOf(humans, rows.filter((r) => r.kind === "perturb" && r.sub === sub).map(scoreOf));
    }
    // the section swap (8 beats of another human map) is close to chance for map-level features: shown apart
    if (rows.some((r) => r.sub === "swapSection")) {
        out["perturb:noSwap"] = aucOf(humans, rows.filter((r) => r.kind === "perturb" && r.sub !== "swapSection").map(scoreOf));
    }
    return out;
}

function parseArgs(argv) {
    const o = { data: null, critic: null, split: "test", second: null, json: null, osu: null, audio: null, dan: NaN };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const v = () => argv[++i];
        if (a === "--data") o.data = v();
        else if (a === "--critic") o.critic = v();
        else if (a === "--split") o.split = v();
        else if (a === "--second") o.second = v();
        else if (a === "--json") o.json = v();
        else if (a === "--osu") o.osu = v();
        else if (a === "--audio") o.audio = v();
        else if (a === "--dan") o.dan = Number(v());
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!o.osu && !o.data) throw new Error("usage: --data <dir> --critic <critic.json> (or --osu <file>; see the header)");
    return o;
}

const fmt = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v));

async function readRows(dir, split) {
    const names = JSON.parse(await readFile(path.join(dir, "feature_names.json"), "utf8"));
    const index = (await readFile(path.join(dir, "index.jsonl"), "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const buf = await readFile(path.join(dir, "features.f32"));
    const X = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const F = names.length;
    const at = CRITIC_FEATURES.map((n) => names.indexOf(n));
    const rows = index.filter((r) => r.split === split && !r.mirror);
    for (const r of rows) {
        const x = new Float64Array(CRITIC_FEATURES.length);
        for (let k = 0; k < at.length; k += 1) x[k] = at[k] < 0 ? NaN : X[r.row * F + at[k]];
        r.x = x;
    }
    return rows;
}

async function evalData(o) {
    const json = o.critic ? JSON.parse(await readFile(o.critic, "utf8")) : null;
    const critic = criticFor(json);
    const rows = await readRows(o.data, o.split);
    if (!rows.length) throw new Error(`no ${o.split} rows in ${o.data}`);
    const t0 = performance.now();
    for (const r of rows) r.s = critic.score(r.x);
    const msPer = (performance.now() - t0) / rows.length;
    const report = { critic: o.critic, kind: critic.kind, split: o.split, rows: rows.length, msPerScore: msPer };
    if (critic.kind !== "heuristic") report.human = kindAucs(rows, (r) => r.s.human);
    report.score = kindAucs(rows, (r) => r.s.score);
    report.python = json?.metrics?.[o.split] ?? null;
    const ref = report.human ?? report.score;
    report.ship = {
        "vs v3-generated ≥ 0.85": ref.gen === undefined || ref.gen === null ? null : ref.gen >= SHIP.gen,
        "vs perturbed ≥ 0.90": ref.perturb === undefined || ref.perturb === null ? null : ref.perturb >= SHIP.perturb,
    };
    if (o.second) {
        const second = loadCritic(JSON.parse(await readFile(o.second, "utf8")));
        for (const r of rows) r.s2 = second.score(r.x);
        const neg = rows.filter((r) => r.kind !== "human");
        report.second = {
            critic: o.second,
            spearmanOnNegatives: spearman(neg.map((r) => r.s.score), neg.map((r) => r.s2.score)),
            human: kindAucs(rows, (r) => r.s2.human),
        };
        // per map: does each critic put the human above every one of its own negatives?
        const byMap = new Map();
        for (const r of rows) {
            if (!byMap.has(r.map)) byMap.set(r.map, []);
            byMap.get(r.map).push(r);
        }
        let both = 0;
        let maps = 0;
        for (const list of byMap.values()) {
            const h = list.find((r) => r.kind === "human");
            const n = list.filter((r) => r.kind !== "human");
            if (!h || !n.length) continue;
            maps += 1;
            if (n.every((r) => r.s.score < h.s.score && r.s2.score < h.s2.score)) both += 1;
        }
        report.second.humanTopBoth = maps ? both / maps : null;
    }
    console.log(`critic ${report.kind} (${o.critic ?? "heuristic"}), ${o.split}: ${rows.length} rows, ${(msPer * 1000).toFixed(1)} µs per score`);
    const show = (title, a) => console.log(`${title.padEnd(14)} ${Object.entries(a).map(([k, v]) => `${k} ${fmt(v)}`).join(" · ")}`);
    if (report.human) show("human head", report.human);
    show("stage-1 score", report.score);
    if (report.python) show("python (human)", report.python);
    show("ship checks", report.ship);
    if (report.second) console.log(`second critic: spearman on negatives ${fmt(report.second.spearmanOnNegatives)}, human above its negatives under both ${fmt(report.second.humanTopBoth)}, its human AUC ${fmt(report.second.human.all)}`);
    if (o.json) await writeFile(o.json, JSON.stringify(report, null, 1));
    return report;
}

async function evalOne(o) {
    const json = o.critic ? JSON.parse(await readFile(o.critic, "utf8")) : null;
    const critic = criticFor(json);
    const text = await readFile(o.osu, "utf8");
    const raw = parseRows(text, 4);
    const points = parseRedTimingPoints(text);
    let audio = null;
    let audioEndMs = Infinity;
    if (o.audio) {
        const dec = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", o.audio, "-ac", "1", "-ar", "22050", "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 * 1024 });
        if (dec.status !== 0) throw new Error(`ffmpeg: ${String(dec.stderr).slice(0, 200)}`);
        const samples = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
        const { onsetEnvelope } = await import("../src/audio/onset.js");
        audio = { envelope: onsetEnvelope(samples, 22050) };
        audioEndMs = (samples.length / 22050) * 1000;
    }
    const slots = chartSlots(points, raw, audioEndMs);
    const { note, mask } = labelSlots(raw, slots);
    const rows = [];
    for (let i = 0; i < slots.length; i += 1) if (note[i]) rows.push({ t: slots[i].t, mask: mask[i], i });
    const x = criticFeatures(rows, slots, audio, null, null, { dan: o.dan });
    const s = critic.score(x);
    console.log(`${path.basename(o.osu)}: ${rows.length} rows on the grid of ${raw.length}; critic ${s.kind}: score ${fmt(s.score)}, human ${fmt(s.human)}, play ${fmt(s.play)}`);
    if (json?.norm) {
        const z = CRITIC_FEATURES.map((n, k) => {
            const j = json.norm.names.indexOf(n);
            return [n, j < 0 || Number.isNaN(x[k]) ? 0 : (x[k] - json.norm.mean[j]) / json.norm.std[j], x[k]];
        }).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        console.log("furthest from human maps (z):");
        for (const [n, zz, v] of z.slice(0, 12)) console.log(`  ${n.padEnd(30)} ${v.toFixed(3).padStart(9)}  z ${zz.toFixed(2)}`);
    }
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
    const o = parseArgs(process.argv.slice(2));
    (o.osu ? evalOne(o) : evalData(o)).catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
