// How well songStructure (src/gen/structure.js) finds phrases and repeats, against human maps from the corpus:
//   • phrase starts against the bars where the human map's density or pattern family changes: F-measure, a hit within
//     ±1 bar (ship rule ≥ 0.6, addendum §7), next to fixed 4- and 8-bar grids and part starts alone;
//   • the human map's row Jaccard between the bars of each detected repeat, against random bar pairs of the same
//     song (repeats are worth copying only where humans repeat too; this also sets the generator's target).
// It sweeps τ (repeats) and the novelty kernel (phrases), so the defaults can be tuned.
// Usage:
//   node tools/eval-structure.mjs [--corpus A:/SneezeyTrain/corpus/corpus.jsonl] [--split train|heldout]
//       [--limit 100] [--tau 0.5,0.55,...,0.9] [--kernel 4,8,12,16] [--merge median-all,median,mean,q75,none]
//       [--density-bars 4] [--out FILE.json] [--verbose]
// Charts come from the osu! sources (not Etterna or Malody converts), one per song group, in a fixed hashed order.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = (rel) => import(pathToFileURL(path.join(root, rel)).href);

export const TOLERANCE_BARS = 1;
const DENSITY_RATIO = 1.5; // rows over the bars after a line against as many before, either way
const DENSITY_BARS = 4; // a phrase-level change lasts; 2-bar windows also flag every 1-bar fill, twice
const FAMILY_BARS = 4;
const EDGE_BARS = 2; // lines this close to the first or last mapped bar are not scored
const RANDOM_PAIRS = 200;
const MIN_LAG_BARS = 4;
const OSU_SOURCES = new Set(["hf", "sets", "songs", "packs", "ranked"]);
const SAMPLE_RATE = 22050;

// ---- metrics (exported for tests) ----------------------------------------------------------------------------------

// Hits within ±tol, each truth used once, scanned in order: { f, precision, recall, hits }.
export function boundaryF(found, truth, tol = TOLERANCE_BARS) {
    if (!found.length && !truth.length) return { f: 1, precision: 1, recall: 1, hits: 0 };
    const used = new Set();
    let hits = 0;
    for (const x of found) {
        let best = -1;
        for (const t of truth) if (!used.has(t) && Math.abs(t - x) <= tol && (best < 0 || Math.abs(t - x) < Math.abs(best - x))) best = t;
        if (best >= 0) {
            used.add(best);
            hits += 1;
        }
    }
    const precision = found.length ? hits / found.length : 0;
    const recall = truth.length ? hits / truth.length : 0;
    return { f: (2 * hits) / (found.length + truth.length), precision, recall, hits };
}

const mirrorMask = (m) => ((m & 1) << 3) | ((m & 2) << 1) | ((m & 4) >> 1) | ((m & 8) >> 3);

// The rows of each bar as sets of position-in-bar (1/48 beat) × column mask: [Set<number>] per bar.
export function barRowSets(rows, bars, mirror = false) {
    const sets = bars.map(() => new Set());
    let k = 0;
    for (const r of rows) {
        while (k + 1 < bars.length && r.t >= bars[k + 1].startMs - 0.5) k += 1;
        const bar = bars[k];
        if (r.t < bar.startMs - 0.5 || r.t >= bar.endMs - 0.5) continue;
        const pos = Math.round(((r.t - bar.startMs) / bar.beatMs) * 48);
        sets[k].add(pos * 16 + (mirror ? mirrorMask(r.mask) : r.mask));
    }
    return sets;
}

export function jaccard(a, b) {
    if (!a.size && !b.size) return null; // two empty bars say nothing
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

// Bars where the human map changes: density over `densityBars` bars jumps by ×1.5 either way, or the pattern family of
// the 4 bars before differs from the 4 after (each agreeing with its nearer 2 bars); the strongest line within ±2 bars
// is kept. Windows stay inside the mapped bars first … last (rows per bar where a window is cut short; no density
// test with fewer than 2 bars on a side). → bar indexes from first + EDGE_BARS to last + 1 − EDGE_BARS.
export function humanChangePoints(rows, bars, sectionFamily, first, last, { densityBars = DENSITY_BARS } = {}) {
    const perBar = bars.map((b) => rows.filter((r) => r.t >= b.startMs - 0.5 && r.t < b.endMs - 0.5));
    const lo = Math.max(0, first);
    const hi = Math.min(bars.length, last + 1);
    const span = (a, b) => [Math.max(lo, a), Math.min(hi, b)];
    const rate = ([a, b]) => (perBar.slice(a, b).reduce((n, x) => n + x.length, 0) + 1) / Math.max(1, b - a);
    const family = (a, b) => {
        const [x, y] = span(a, b);
        return sectionFamily(perBar.slice(x, Math.max(x, y)).flat(), 0);
    };
    const score = bars.map((_, k) => {
        if (k < first + EDGE_BARS || k > last + 1 - EDGE_BARS) return 0;
        const before = span(k - densityBars, k);
        const after = span(k, k + densityBars);
        let s = 0;
        if (before[1] - before[0] >= 2 && after[1] - after[0] >= 2) {
            const ratio = Math.max(rate(before) / rate(after), rate(after) / rate(before));
            if (ratio >= DENSITY_RATIO) s = Math.log(ratio);
        }
        // the families of the 4 bars on each side differ, and each side's nearer 2 bars agree with it (else the window
        // only reaches into the next section)
        const fa = family(k - FAMILY_BARS, k);
        const fb = family(k, k + FAMILY_BARS);
        if (fa && fb && fa !== fb && family(k - 2, k) === fa && family(k, k + 2) === fb) s = Math.max(s, 1);
        return s;
    });
    return score
        .map((s, k) => (s > 0 && score.slice(Math.max(0, k - 2), k + 3).every((x, j) => x < s || (x === s && Math.max(0, k - 2) + j >= k)) ? k : -1))
        .filter((k) => k >= 0);
}

// ---- the run -------------------------------------------------------------------------------------------------------

const VALUED = new Set(["--corpus", "--split", "--limit", "--tau", "--kernel", "--merge", "--density-bars", "--out"]);
// several songs joined into one chart (dan courses, practice packs, marathons) have no song structure to find
const COMPILATION = /\b(packs?|dan|course|marathon|compilation|practice|vol\.?\s*\d+)\b/i;
const COMPILATION_ARTIST = /^(various artists|v\.?\s?a\.?)$/i;

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (VALUED.has(a)) options[a.slice(2)] = argv[++i];
        else if (a.startsWith("--")) options[a.slice(2)] = true;
    }
    return options;
}

function ffmpegPath() {
    const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (probe.status === 0) return "ffmpeg";
    return createRequire(import.meta.url)("ffmpeg-static");
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const hashOf = (s) => createHash("sha1").update(s).digest("hex");

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const corpus = options.corpus ?? "A:/SneezeyTrain/corpus/corpus.jsonl";
    const split = options.split ?? "train";
    const limit = Number(options.limit ?? 100);
    const taus = (options.tau ?? "0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9").split(",").map(Number);
    const densityBars = Number(options["density-bars"] ?? DENSITY_BARS);
    const kernels = (options.kernel ?? "4,8,12,16").split(",").map(Number);
    const merges = (options.merge ?? "median-all,median,mean,q75,none").split(",");
    const { onsetEnvelope } = await mod("src/audio/onset.js");
    const { computeStemsSync } = await mod("src/audio/stems.js");
    const { parseRedTimingPoints, timingFromPoints, slotsForTiming } = await mod("src/gen/grid.js");
    const { parseRows, sectionFamily } = await mod("src/gen/mapRows.js");
    const { barsOf, detectParts } = await mod("src/gen/songParts.js");
    const S = await mod("src/gen/structure.js");

    const lines = (await readFile(corpus, "utf8")).split(/\r?\n/).filter(Boolean);
    const byGroup = new Map();
    for (const line of lines) {
        const m = JSON.parse(line);
        if (!OSU_SOURCES.has(m.source) || m.split !== split || !m.audio || !m.osu) continue;
        if ((m.lnShare ?? 0) > 0.15 || (m.objects ?? 0) < 400 || (m.spanMs ?? 0) < 60000) continue;
        if (COMPILATION_ARTIST.test((m.artist ?? "").trim()) || COMPILATION.test(`${m.title} ${m.version}`)) continue;
        const prev = byGroup.get(m.group);
        if (!prev || hashOf(m.osu) < hashOf(prev.osu)) byGroup.set(m.group, m);
    }
    const queue = [...byGroup.values()].sort((a, b) => (hashOf(a.group) < hashOf(b.group) ? -1 : 1));
    console.log(`${queue.length} song groups in split ${split}; evaluating up to ${limit}`);
    const ffmpeg = ffmpegPath();
    const songs = [];
    const t0 = performance.now();
    for (const m of queue) {
        if (songs.length >= limit) break;
        const text = await readFile(m.osu, "utf8").catch(() => null);
        if (!text) continue;
        const red = parseRedTimingPoints(text).filter((x) => 60000 / x.beatLength >= 40 && 60000 / x.beatLength <= 400);
        if (!red.length || red.length > 3) continue;
        const timing = timingFromPoints(red.map((x) => ({ ...x, time: x.time < 0 ? x.time + Math.ceil(-x.time / x.beatLength) * x.beatLength : x.time })));
        const rows = parseRows(text, 4);
        if (rows.length < 200) continue;
        const dec = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", m.audio, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 * 1024 });
        if (dec.status !== 0 || !dec.stdout?.length) continue;
        const samples = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
        const endMs = Math.min((samples.length / SAMPLE_RATE) * 1000 - 100, rows.at(-1).t + 4000);
        const slots = slotsForTiming(timing, endMs);
        const bars = barsOf(slots);
        if (bars.length < 24) continue;
        const stems = computeStemsSync(samples, SAMPLE_RATE);
        const envelope = onsetEnvelope(samples, SAMPLE_RATE);
        const parts = detectParts(envelope, slots);
        const barsWithBeat = bars.map((b) => ({ ...b, beatMs: slots[b.i0].beatMs ?? 60000 / slots[b.i0].bpm }));
        const barAt = (t) => barsWithBeat.findIndex((b) => t >= b.startMs - 0.5 && t < b.endMs - 0.5);
        const first = Math.max(0, barAt(rows[0].t));
        const last = barAt(rows.at(-1).t) < 0 ? bars.length - 1 : barAt(rows.at(-1).t);
        if (last - first < 16) continue;
        const { vectors, dim } = S.barVectors(stems, slots, bars);
        const ssm = S.selfSimilarity(vectors, bars.length, dim);
        const nearest = (ms) => barsWithBeat.reduce((best, b, k) => (Math.abs(b.startMs - ms) < Math.abs(barsWithBeat[best].startMs - ms) ? k : best), 0);
        const partBars = [...new Set(parts.map((p) => nearest(p.startMs)).filter((k) => k > 0))];
        songs.push({
            name: `${m.artist} - ${m.title} [${m.version}]`,
            n: bars.length,
            first,
            last,
            ssm,
            partBars,
            truth: humanChangePoints(rows, barsWithBeat, sectionFamily, first, last, { densityBars }),
            sets: barRowSets(rows, barsWithBeat),
            mirrored: barRowSets(rows, barsWithBeat, true),
            seed: parseInt(hashOf(m.group).slice(0, 8), 16),
        });
        if (options.verbose || songs.length % 10 === 0) console.log(`  ${songs.length} songs (${((performance.now() - t0) / 1000).toFixed(0)} s) ${songs.at(-1).name.slice(0, 60)}`);
    }

    // ---- phrases: kernel sweep -------------------------------------------------------------------------------------
    const inside = (s) => (k) => k >= s.first + EDGE_BARS && k <= s.last + 1 - EDGE_BARS;
    const grid = (s, every) => Array.from({ length: s.n }, (_, k) => k).filter((k) => k % every === 0);
    const scoreF = (pick) => {
        const per = songs.map((s) => boundaryF(pick(s).filter(inside(s)), s.truth.filter(inside(s))));
        return { f: mean(per.map((x) => x.f)), precision: mean(per.map((x) => x.precision)), recall: mean(per.map((x) => x.recall)) };
    };
    const report = { split, songs: songs.length, densityBars, changesPerSong: mean(songs.map((s) => s.truth.length)), phrases: [], repeats: [] };
    console.log(`\nphrase starts vs human density (${densityBars}-bar windows) and family changes (F at ±${TOLERANCE_BARS} bar, ${songs.length} songs, ${mean(songs.map((s) => s.truth.length)).toFixed(1)} changes per song)`);
    const baselines = [
        ["4-bar grid from bar 0", (s) => grid(s, 4)],
        ["8-bar grid from bar 0", (s) => grid(s, 8)],
        ["part starts only", (s) => s.partBars],
    ];
    for (const [name, pick] of baselines) {
        const r = scoreF(pick);
        report.phrases.push({ name, ...r });
        console.log(`  ${name.padEnd(40)} F ${r.f.toFixed(3)}  P ${r.precision.toFixed(3)}  R ${r.recall.toFixed(3)}`);
    }
    for (const kernelBars of kernels) {
        const novelty = songs.map((s) => S.noveltyCurve(s.ssm, s.n, kernelBars));
        for (const merge of merges) {
            for (const withParts of [true, false]) {
                const phrases = songs.map((s, i) => S.phrasesOf(novelty[i], s.n, withParts ? s.partBars : [], { merge }).phrases);
                const r = scoreF((s) => phrases[songs.indexOf(s)].map((p) => p.bar));
                const lengths = phrases.flat().map((p) => p.bars);
                const name = `kernel ${kernelBars}, merge ${merge}${withParts ? " + parts" : ", no parts"}`;
                report.phrases.push({ name, kernelBars, merge, withParts, ...r, meanBars: mean(lengths) });
                console.log(`  ${name.padEnd(40)} F ${r.f.toFixed(3)}  P ${r.precision.toFixed(3)}  R ${r.recall.toFixed(3)}  (phrases of ${mean(lengths).toFixed(1)} bars)`);
            }
        }
    }

    // ---- repeats: τ sweep ------------------------------------------------------------------------------------------
    const randomPairs = songs.map((s) => {
        const r = rng(s.seed);
        const out = [];
        for (let i = 0; i < RANDOM_PAIRS * 4 && out.length < RANDOM_PAIRS; i += 1) {
            const a = s.first + Math.floor(r() * (s.last - s.first + 1));
            const b = s.first + Math.floor(r() * (s.last - s.first + 1));
            if (Math.abs(a - b) >= MIN_LAG_BARS) out.push([Math.min(a, b), Math.max(a, b)]);
        }
        return out;
    });
    const pairJ = (s, pairs, sets) => pairs.map(([a, b]) => jaccard(sets[a], sets[b])).filter((x) => x !== null);
    const bestOfMirror = (s, pairs) => pairs.map(([a, b]) => {
        const plain = jaccard(s.sets[a], s.sets[b]);
        const mirrored = jaccard(s.sets[a], s.mirrored[b]);
        return plain === null ? null : Math.max(plain, mirrored ?? 0);
    }).filter((x) => x !== null);
    const jRandom = mean(songs.flatMap((s, i) => pairJ(s, randomPairs[i], s.sets)));
    const jRandomMirror = mean(songs.flatMap((s, i) => bestOfMirror(s, randomPairs[i])));
    console.log(`\nrepeats: human row Jaccard between repeated bars (mapped bars only); random bar pairs ${jRandom.toFixed(3)} (mirror allowed ${jRandomMirror.toFixed(3)})`);
    for (const tau of taus) {
        const all = [];
        const allMirror = [];
        let mirroredBetter = 0;
        let pairCount = 0;
        let covered = 0;
        let mapped = 0;
        let withRepeat = 0;
        let count = 0;
        for (const s of songs) {
            const { repeats, echoOf } = S.findRepeats(s.ssm, s.n, { ...S.STRUCTURE_DEFAULTS, tau });
            const pairs = [];
            for (let b = s.first; b <= s.last; b += 1) if (echoOf[b] >= s.first) pairs.push([echoOf[b], b]);
            covered += pairs.length;
            mapped += s.last - s.first + 1;
            if (pairs.length) withRepeat += 1;
            count += repeats.length;
            all.push(...pairJ(s, pairs, s.sets));
            allMirror.push(...bestOfMirror(s, pairs));
            for (const [a, b] of pairs) {
                const plain = jaccard(s.sets[a], s.sets[b]);
                if (plain === null) continue;
                pairCount += 1;
                if ((jaccard(s.sets[a], s.mirrored[b]) ?? 0) > plain) mirroredBetter += 1;
            }
        }
        const r = { tau, coverage: covered / mapped, jRepeat: mean(all), jRepeatMirror: mean(allMirror), jRandom, lift: mean(all) - jRandom, mirroredShare: pairCount ? mirroredBetter / pairCount : 0, songsWithRepeats: withRepeat, repeatsPerSong: count / songs.length };
        r.gain = r.lift * r.coverage;
        report.repeats.push(r);
        console.log(`  τ ${tau.toFixed(2)}: coverage ${(100 * r.coverage).toFixed(1).padStart(5)}%  J ${r.jRepeat.toFixed(3)} (mirror ${r.jRepeatMirror.toFixed(3)})  lift ${r.lift.toFixed(3)}  lift×coverage ${r.gain.toFixed(4)}  mirror better ${(100 * r.mirroredShare).toFixed(0)}%  ${r.repeatsPerSong.toFixed(1)} repeats/song, ${withRepeat}/${songs.length} songs`);
    }
    const best = report.repeats.reduce((a, b) => (b.gain > a.gain ? b : a), report.repeats[0]);
    const bestPhrase = report.phrases.filter((p) => p.kernelBars).reduce((a, b) => (b.f > a.f ? b : a));
    console.log(`\nbest τ by lift × coverage: ${best?.tau} · best phrase setting: ${bestPhrase.name} (F ${bestPhrase.f.toFixed(3)})`);
    console.log(`time: ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    if (options.out) {
        await mkdir(path.dirname(options.out), { recursive: true });
        await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`wrote ${options.out}`);
    }
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
