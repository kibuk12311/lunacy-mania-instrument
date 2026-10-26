// Model comparison under the same v3 generator (stream V, addendum §7): the run config, the command line, the
// metrics that are not in src/gen/metrics.js (repeat consistency, divisor F1, collapse), the summary with paired
// bootstrap intervals, and the ship-rule verdict. Pure functions: no audio, no model files.
import path from "node:path";
import { NAME_FAMILY } from "../../src/gen/search.js";
import { labelBeatSnaps } from "../../src/gen/mapRows.js";
import { mulberry32 } from "../../src/gen/rng.js";

// ---- run config (--config JSON) ----------------------------------------------------------------------------

// Every option the wave-3 plan names. With all of them at these values the run is the v3 generator exactly.
export const CONFIG_DEFAULTS = Object.freeze({
    candidates: 1, // request.candidates (G1): N candidates per variant, the critic picks one
    critic: null, // a critic.json file, handed to the generator as opts.critic (R; heuristic critic without it)
    repeats: false, // request.repeats (G2, needs stems + structure)
    style: null, // request.style (G4): a key of the model's styles
    infill: false, // the tool's infill mode: half the human map locked, the rest regenerated (§7 nn-v2 row)
    deadlineMs: 4000, // input.deadlineMs, the candidate phase's time box (§1.1)
});
const KEYS = new Set([...Object.keys(CONFIG_DEFAULTS), "per"]);
const isComment = (k) => k.startsWith("_") || k.startsWith("$");

function checkOptions(raw, where, baseDir) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`config${where}: must be an object`);
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (isComment(k)) continue;
        if (!KEYS.has(k)) throw new Error(`config${where}: unknown option "${k}" (known: ${[...KEYS].join(", ")})`);
        if (k === "per") continue;
        if (k === "candidates" && !(Number.isInteger(v) && v >= 1 && v <= 20)) throw new Error(`config${where}: candidates must be an integer 1..20`);
        if (k === "critic" && !(v === null || (typeof v === "string" && v))) throw new Error(`config${where}: critic must be a file path or null`);
        if ((k === "repeats" || k === "infill") && typeof v !== "boolean") throw new Error(`config${where}: ${k} must be true or false`);
        if (k === "style" && !(v === null || (typeof v === "string" && v))) throw new Error(`config${where}: style must be a style key or null`);
        if (k === "deadlineMs" && !(Number.isFinite(v) && v > 0)) throw new Error(`config${where}: deadlineMs must be a positive number`);
        out[k] = k === "critic" && v ? path.resolve(baseDir ?? ".", v) : v;
    }
    return out;
}

// raw: JSON text, an object, or nothing. Returns { ...options, per: { label: partial options } }.
export function parseConfig(raw, { baseDir } = {}) {
    if (raw === undefined || raw === null || raw === "") return { ...CONFIG_DEFAULTS, per: {} };
    let obj = raw;
    if (typeof raw === "string") {
        try {
            obj = JSON.parse(raw);
        } catch (e) {
            throw new Error(`config: not valid JSON (${e.message})`);
        }
    }
    const top = checkOptions(obj, "", baseDir);
    const per = {};
    if (obj.per !== undefined) {
        if (!obj.per || typeof obj.per !== "object" || Array.isArray(obj.per)) throw new Error("config: per must map engine labels to options");
        for (const [label, opts] of Object.entries(obj.per)) {
            if (opts && typeof opts === "object" && "per" in opts) throw new Error(`config.per.${label}: per cannot nest`);
            per[label] = checkOptions(opts, `.per.${label}`, baseDir);
        }
    }
    return { ...CONFIG_DEFAULTS, ...top, per };
}

// The options one engine runs with (shared ones, then its own).
export function configFor(cfg, label) {
    const { per = {}, ...shared } = cfg;
    return { ...shared, ...(per[label] ?? {}) };
}

// Fields the run adds to the generator request: only the ones that differ from v3.
export function requestExtras(cfg) {
    const out = {};
    if (cfg.candidates !== 1) out.candidates = cfg.candidates;
    if (cfg.repeats) out.repeats = true;
    if (cfg.style) out.style = cfg.style;
    return out;
}

// Did the generator answer to each option? "off" (not asked for), "used" (the answer shows it) or "not available"
// (asked for, the answer has no trace: today's v3 generator ignores unknown request fields). Evidence per §1.1/§2.3.
export function optionStatus(cfg, response, { infillRan = false } = {}) {
    const r = response ?? {};
    const status = (asked, used) => (!asked ? "off" : used ? "used" : "not available");
    return {
        candidates: status(cfg.candidates > 1, Number.isInteger(r.critic?.of) && r.critic.of > 1),
        critic: status(!!cfg.critic, r.critic?.kind === "critic-v1"),
        repeats: status(!!cfg.repeats, !!r.structure),
        style: status(!!cfg.style, Number.isFinite(r.critic?.style) || (r.style != null && r.style === cfg.style)),
        infill: status(!!cfg.infill, infillRan),
    };
}

// The same over many answers: "partial (k/n)" when only some answers show it.
export function availability(cfg, responses, opts = {}) {
    const per = responses.map((r) => optionStatus(cfg, r, opts));
    const base = optionStatus(cfg, null, opts);
    const out = {};
    for (const k of Object.keys(base)) {
        if (base[k] === "off") {
            out[k] = "off";
            continue;
        }
        const used = per.filter((s) => s[k] === "used").length;
        out[k] = used === 0 ? "not available" : used === per.length ? "used" : `partial (${used}/${per.length})`;
    }
    return out;
}

// ---- command line --------------------------------------------------------------------------------------------

export const SNAP_VARIANTS = { q4: [4], all: [4, 3, 6, 8], auto: null }; // auto: all on off-1/4 songs (≥10% of beats), q4 elsewhere
const FORMS = ["range", "target"];
const VALUE_FLAGS = ["a", "b", "model", "picks", "heldout", "corpus", "split", "save-picks", "seeds", "form", "snaps", "config", "jobs",
    "limit", "out", "baseline", "views", "p95-budget", "pool", "osu-share", "pick-seed", "ffmpeg", "iters", "from", "max-sec"];
const BOOL_FLAGS = ["rules", "no-heldout-check", "list"];

export function parseCompareArgs(argv) {
    const o = { engines: [], seeds: [1, 2, 3], forms: ["range"], snaps: ["auto"], jobs: 1, limit: 0, views: ["all", "osu", "trills"],
        p95BudgetMs: 8000, iters: 2000, osuShare: 0.5, pool: 0, maxSec: 360, pickSeed: "v-heldout-1", ffmpeg: "ffmpeg", heldoutCheck: true };
    const labels = new Set();
    const addModel = (label, file) => {
        if (labels.has(label)) throw new Error(`engine "${label}" given twice`);
        labels.add(label);
        o.engines.push({ label, kind: "model", path: file });
    };
    let rules = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
        const k = a.slice(2);
        if (BOOL_FLAGS.includes(k)) {
            if (k === "rules") rules = true;
            if (k === "no-heldout-check") o.heldoutCheck = false;
            if (k === "list") o.list = true;
            continue;
        }
        if (!VALUE_FLAGS.includes(k)) throw new Error(`unknown option --${k}`);
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`missing value for --${k}`);
        i += 1;
        if (k === "a" || k === "b") addModel(k.toUpperCase(), v);
        else if (k === "model") {
            const eq = v.indexOf("=");
            if (eq <= 0) throw new Error(`--model wants label=path, got ${v}`);
            addModel(v.slice(0, eq), v.slice(eq + 1));
        } else if (k === "seeds") {
            o.seeds = v.split(",").map((s) => Number(s));
            if (!o.seeds.length || o.seeds.some((s) => !Number.isSafeInteger(s))) throw new Error(`--seeds wants integers, got ${v}`);
        } else if (k === "form") {
            if (v === "both") o.forms = [...FORMS];
            else if (FORMS.includes(v)) o.forms = [v];
            else throw new Error(`--form is range, target or both, got ${v}`);
        } else if (k === "snaps") {
            o.snaps = v.split(",");
            if (o.snaps.some((s) => !(s in SNAP_VARIANTS))) throw new Error(`--snaps takes ${Object.keys(SNAP_VARIANTS).join(", ")}, got ${v}`);
        } else if (["jobs", "limit", "heldout", "pool", "iters"].includes(k)) {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0) throw new Error(`--${k} wants a whole number, got ${v}`);
            o[k] = n;
        } else if (k === "p95-budget") o.p95BudgetMs = Number(v) * 1000;
        else if (k === "osu-share") o.osuShare = Number(v);
        else if (k === "max-sec") o.maxSec = Number(v);
        else if (k === "views") o.views = v.split(",");
        else if (k === "save-picks") o.savePicks = v;
        else if (k === "pick-seed") o.pickSeed = v;
        else o[k] = v;
    }
    if (rules) {
        if (labels.has("rules")) throw new Error(`engine "rules" given twice`);
        o.engines.push({ label: "rules", kind: "rules" });
    }
    // --from records.jsonl: summarise an earlier run again (engines, snaps, forms and seeds come from its records)
    if (o.from) return o;
    if (!o.engines.length) throw new Error("no engine: give --a/--b, --model label=path or --rules");
    if (!o.picks && !o.heldout) throw new Error("no songs: give --picks FILE or --heldout N (with --corpus)");
    o.baseline ??= o.engines[0].label;
    if (!o.engines.some((e) => e.label === o.baseline)) throw new Error(`--baseline ${o.baseline} is not an engine`);
    o.jobs = Math.max(1, o.jobs);
    return o;
}

// ---- metrics -------------------------------------------------------------------------------------------------

// Pattern name (analyser primary) → generator family. eval-generator's extra names are kept.
const EXTRA_FAMILY = { Jumptrill: "Jumpstream" };
export function familyOf(primary) {
    return NAME_FAMILY[primary] ?? EXTRA_FAMILY[primary] ?? "Jumpstream";
}
export const TRILL_NAMES = new Set(["Minitrills", "Rolls", "Trills"]);

const maskOf = (r) => r.mask ?? (r.cols ?? []).reduce((m, c) => m | (1 << c), 0);

// Rows of a repeat, [aMs, aMs+len) against [bMs, bMs+len): a row matches one on the other side with the same mask
// at the same offset (±tolMs). Jaccard = matches / (|A| + |B| − matches); null when both sides are empty.
export function rowJaccard(rows, aMs, bMs, lenMs, tolMs = 10) {
    const side = (from) => rows.filter((r) => r.t >= from - tolMs / 2 && r.t < from + lenMs - tolMs / 2).map((r) => ({ d: r.t - from, m: maskOf(r) }));
    const A = side(aMs);
    const B = side(bMs);
    if (!A.length && !B.length) return null;
    const used = new Uint8Array(B.length);
    let hits = 0;
    for (const x of A) {
        const j = B.findIndex((y, k) => !used[k] && y.m === x.m && Math.abs(y.d - x.d) <= tolMs);
        if (j >= 0) {
            used[j] = 1;
            hits += 1;
        }
    }
    return hits / (A.length + B.length - hits);
}

// Mean row Jaccard over repeats [{ aMs, bMs, lenMs }] (the generator's structure.repeats, §2.3); null without any.
export function repeatConsistency(rows, repeats) {
    const js = (repeats ?? []).map((r) => rowJaccard(rows, r.aMs, r.bMs, r.lenMs)).filter((j) => j !== null);
    return js.length ? js.reduce((a, b) => a + b, 0) / js.length : null;
}

// §7 "repeat consistency gap": |rowJaccard(gen at repeats) − rowJaccard(human at the same repeats)|.
export function repeatGap(genRows, humanRows, repeats) {
    const g = repeatConsistency(genRows, repeats);
    const h = repeatConsistency(humanRows, repeats);
    return g === null || h === null ? null : Math.abs(g - h);
}

// Per beat: the grid its rows need (labelBeatSnaps: 4, 3, 6, 8, or 0 = finer); shares over beats that have rows.
export function beatGridStats(rows, beats) {
    const labels = labelBeatSnaps(rows, beats);
    const has = new Uint8Array(beats.length);
    let b = 0;
    for (const r of rows) {
        while (b + 1 < beats.length && beats[b + 1].t <= r.t + Math.min(12, beats[b].beatMs / 24)) b += 1;
        if (b < beats.length) has[b] = 1;
    }
    let active = 0;
    let off = 0;
    let trip = 0;
    for (let i = 0; i < beats.length; i += 1) {
        if (!has[i]) continue;
        active += 1;
        if (labels[i] !== 4) off += 1;
        if (labels[i] === 3 || labels[i] === 6) trip += 1;
    }
    return { labels, active, offQuarter: active ? off / active : 0, triplet: active ? trip / active : 0 };
}

// F1 over the beats on 1/3, 1/6 or 1/8: a generated beat counts only on the human beat's own grid. Null when
// neither side has such a beat. (Beats finer than 1/8 in the human map are not counted: the generator has no grid.)
export function divisorF1(human, gen) {
    const pos = (d) => d === 3 || d === 6 || d === 8;
    let h = 0;
    let g = 0;
    let tp = 0;
    for (let i = 0; i < Math.min(human.length, gen.length); i += 1) {
        if (pos(human[i])) h += 1;
        if (pos(gen[i])) g += 1;
        if (pos(human[i]) && human[i] === gen[i]) tp += 1;
    }
    return h + g ? (2 * tp) / (h + g) : null;
}

// The wave-1 failure: a hard song mapped as a beginner chart (9.6 asked, 2.6 made).
export const COLLAPSE_DANS = 3;
export const isCollapse = ({ dan, numeric }) => !Number.isFinite(numeric) || numeric < dan - COLLAPSE_DANS;

export function percentile(values, q) {
    const s = values.filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
}

// Paired bootstrap of mean(b − a) over pairs [a, b] (one pair per song): { mean, lo, hi } (95%).
export function pairedBootstrap(pairs, { iters = 2000, seed = 1 } = {}) {
    const d = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).map(([a, b]) => b - a);
    if (!d.length) return { mean: null, lo: null, hi: null, n: 0 };
    const mean = d.reduce((s, x) => s + x, 0) / d.length;
    const rng = mulberry32(seed);
    const means = new Float64Array(iters);
    for (let k = 0; k < iters; k += 1) {
        let s = 0;
        for (let i = 0; i < d.length; i += 1) s += d[Math.floor(rng() * d.length)];
        means[k] = s / d.length;
    }
    means.sort();
    return { mean, lo: means[Math.floor(0.025 * iters)], hi: means[Math.min(iters - 1, Math.floor(0.975 * iters))], n: d.length };
}

// ---- summary ---------------------------------------------------------------------------------------------------

const VIEW_FILTERS = {
    all: () => true,
    osu: (r) => r.osu,
    etterna: (r) => r.source === "etterna",
    trills: (r) => r.trills,
    variable: (r) => r.variable,
    offgrid: (r) => r.humanOffQuarter >= 0.1,
};
export const VIEWS = Object.keys(VIEW_FILTERS);

const mean = (xs) => {
    const v = xs.filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const variantKey = (r) => `${r.engine}|${r.snaps}|${r.form}`;

// Records (one per song × engine × snaps × form × seed) → one row per view × engine × snaps × form, with the
// paired bootstrap of F1, density corr, dan hit and pattern against the baseline engine at the same snaps and form.
export function summarize(records, { baseline, views = ["all"], iters = 2000, seed = 1 } = {}) {
    const out = [];
    for (const view of views) {
        const keep = VIEW_FILTERS[view];
        if (!keep) throw new Error(`unknown view ${view} (known: ${VIEWS.join(", ")})`);
        const inView = records.filter(keep);
        const groups = new Map();
        for (const r of inView) {
            const k = variantKey(r);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(r);
        }
        const perSong = (list, field) => {
            const m = new Map();
            for (const r of list.filter((x) => x.ok)) {
                if (!m.has(r.song)) m.set(r.song, []);
                m.get(r.song).push(field === "hit" ? (r.reachable ? 1 : 0) : r[field]);
            }
            return new Map([...m].map(([s, v]) => [s, mean(v)]));
        };
        for (const [k, list] of groups) {
            const [engine, snaps, form] = k.split("|");
            const ok = list.filter((r) => r.ok);
            const row = {
                view, engine, snaps, form,
                runs: ok.length, failed: list.length - ok.length, songs: new Set(ok.map((r) => r.song)).size,
                hits: ok.filter((r) => r.reachable).length,
                hitRate: ok.length ? ok.filter((r) => r.reachable).length / ok.length : null,
                f1: mean(ok.map((r) => r.f1)), corr: mean(ok.map((r) => r.corr)), pattern: mean(ok.map((r) => r.pattern)),
                viol: mean(ok.map((r) => r.viol)), jackLoop: mean(ok.map((r) => r.jackLoop)), humanJackLoop: mean(ok.map((r) => r.humanJackLoop)),
                maxStreamyJack: ok.reduce((m, r) => Math.max(m, r.maxStreamyJack ?? 0), 0),
                collapses: ok.filter(isCollapse).length,
                absDan: mean(ok.map((r) => (Number.isFinite(r.numeric) ? Math.abs(r.numeric - r.dan) : null))),
                offQuarterRows: mean(ok.map((r) => r.offQuarterRows)), humanOffQuarter: mean(ok.map((r) => r.humanOffQuarter)),
                divF1: mean(ok.map((r) => r.divF1)), repeatGap: mean(ok.map((r) => r.repeatGap)),
                f1Free: mean(ok.map((r) => r.f1Free)), seamIssues: mean(ok.map((r) => r.seamIssues)),
                medianMs: percentile(ok.map((r) => r.ms), 0.5), p95Ms: percentile(ok.map((r) => r.ms), 0.95),
                ci: null,
            };
            if (engine !== baseline) {
                const base = groups.get(`${baseline}|${snaps}|${form}`) ?? (baseline === "rules" ? groups.get(`${baseline}|q4|${form}`) : null);
                if (base) {
                    row.ci = {};
                    for (const field of ["f1", "corr", "hit", "pattern"]) {
                        const a = perSong(base, field);
                        const b = perSong(list, field);
                        row.ci[field] = pairedBootstrap([...a].filter(([s]) => b.has(s)).map(([s, v]) => [v, b.get(s)]), { iters, seed });
                    }
                }
            }
            out.push(row);
        }
    }
    return out;
}

// §7 / plan §10 checks of a candidate against the baseline (B0 or the previous shipped piece).
const EPS = 1e-9;
export function verdict(base, cand, { p95BudgetMs = 8000 } = {}) {
    const checks = [
        { name: "hit", ok: cand.hitRate >= base.hitRate - EPS, value: cand.hitRate, limit: `≥ ${fmt(base.hitRate, 3)}` },
        { name: "pattern", ok: cand.pattern >= base.pattern - 0.01 - EPS, value: cand.pattern, limit: `≥ ${fmt(base.pattern - 0.01, 3)}` },
        { name: "violations", ok: cand.viol <= base.viol + EPS, value: cand.viol, limit: `≤ ${fmt(base.viol, 2)}` },
        { name: "f1", ok: cand.f1 >= base.f1 - 0.005 - EPS, value: cand.f1, limit: `≥ ${fmt(base.f1 - 0.005, 3)}` },
        {
            name: "jackLoop", ok: cand.jackLoop <= Math.max(base.jackLoop, (base.humanJackLoop ?? 0) * 1.2) + EPS, value: cand.jackLoop,
            limit: `≤ ${fmt(Math.max(base.jackLoop, (base.humanJackLoop ?? 0) * 1.2), 4)}`,
        },
        { name: "p95", ok: cand.p95Ms <= p95BudgetMs + EPS, value: cand.p95Ms, limit: `≤ ${p95BudgetMs} ms` },
    ];
    return { ship: checks.every((c) => c.ok), checks };
}

// ---- formatting --------------------------------------------------------------------------------------------------

export function fmt(x, d = 3) {
    return Number.isFinite(x) ? x.toFixed(d) : "n/a";
}
const ciText = (c, d = 3) => (c && Number.isFinite(c.mean) ? `${c.mean >= 0 ? "+" : ""}${c.mean.toFixed(d)} [${c.lo.toFixed(d)}, ${c.hi.toFixed(d)}]` : "");

export function formatSummaryTable(rows) {
    const head = ["engine", "snaps", "form", "songs", "dan hit", "F1 ±20ms", "ΔF1 vs base [95% CI]", "density corr", "pattern", "viol/1000",
        "jack loops (human)", "collapses", "|Δdan|", "off-1/4 rows (human beats)", "div F1", "repeat gap", "median s", "p95 s"];
    const infill = rows.some((r) => Number.isFinite(r.f1Free));
    if (infill) head.push("F1 free parts (infill)", "seam issues");
    const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
    for (const r of rows) {
        lines.push(`| ${[
            r.engine, r.snaps, r.form, r.songs, `${r.hits}/${r.runs}${r.failed ? ` (${r.failed} failed)` : ""}`, fmt(r.f1), ciText(r.ci?.f1) || "—",
            fmt(r.corr), fmt(r.pattern), fmt(r.viol, 1), `${fmt(r.jackLoop, 4)} (${fmt(r.humanJackLoop, 4)})`, `${r.collapses}/${r.runs}`,
            fmt(r.absDan, 2), `${fmt(r.offQuarterRows, 3)} (${fmt(r.humanOffQuarter, 3)})`, fmt(r.divF1), fmt(r.repeatGap),
            fmt(r.medianMs / 1000, 1), fmt(r.p95Ms / 1000, 1), ...(infill ? [fmt(r.f1Free), fmt(r.seamIssues, 1)] : []),
        ].join(" | ")} |`);
    }
    return lines.join("\n");
}

// Time spent per generator phase, from its progress events: the time since an event belongs to that event's phase
// (before the first event: "prepare").
export function phaseTimer(now = () => performance.now()) {
    const start = now();
    let last = start;
    let phase = "prepare";
    const ms = {};
    return {
        on(p) {
            const t = now();
            ms[phase] = (ms[phase] ?? 0) + (t - last);
            last = t;
            phase = p.phase ?? phase;
        },
        done() {
            const t = now();
            ms[phase] = (ms[phase] ?? 0) + (t - last);
            last = t;
            return ms;
        },
    };
}
