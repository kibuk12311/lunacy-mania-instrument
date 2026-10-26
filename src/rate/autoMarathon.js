// Auto-marathon: for each step's target dan, maps from mania-tracker in a window around it, the file from the
// local Songs folder or a mirror, and the rate that brings the map to the target. It fills the marathon list;
// building the .osz stays with "Create marathon". Every dependency is injected, so this runs under node:test.
import { targetForWindow } from "../recommend/skill.js";
import { searchParams, rankSets } from "../recommend/rank.js";
import { cutRange } from "./marathon.js";
import { t } from "../i18n/i18n.js";

// The tracker's dan only picks the candidates. The window leans low: speeding a map up is how it is brought
// up to the target, slowing one down below 0.8x rarely plays well.
const WINDOW = [-0.5, 0.2];
const CANDIDATES = 3;
const TOLERANCE = 0.15; // a map further than this from its target after the rate fit gives way to the next one
const RATE = { min: 0.8, max: 1.45, step: 0.05 };
const POLL_MS = 200;
const EPS = 1e-9;
const STOPPED = Symbol("stopped");

const field = (text, key) => new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
const cardName = (c) => `${c.artist ?? ""} - ${c.title ?? ""} [${c.version ?? ""}]`;
const chartName = (osuText) => `${field(osuText, "Artist")} - ${field(osuText, "Title")} [${field(osuText, "Version")}]`;

// A promise that gives up waiting (STOPPED) once isCancelled() turns true; the work itself goes on in the background.
function unlessCancelled(promise, isCancelled) {
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (isCancelled()) {
                clearInterval(timer);
                resolve(STOPPED);
            }
        }, POLL_MS);
        promise.then((value) => { clearInterval(timer); resolve(value); }, (error) => { clearInterval(timer); reject(error); });
    });
}

// searchMaps(params) → { items }; played() → Map beatmapId → play; findLocal(setId, beatmapId) → { path, osuText } | null;
// download({ beatmapsetId, artist, title, onProgress }) → { file }; readFile(file) → Buffer;
// extract(buffer, beatmapId, beatmapsetId, { version }) → { osuPath, osuText }; analyze(osuText, rate) → result;
// rateForDan (src/rate/rateForDan.js); progress({ i, n, phase, … }).
export function createAutoMarathon({ searchMaps, played, findLocal, download, readFile, extract, analyze, rateForDan, progress = () => {}, log = () => {} }) {
    // request: { targets: [dan per step], patternIds (taking turns), lengthId, rankedOnly, skipPlayed }
    // → { entries, warnings, cancelled? }
    async function run(request, isCancelled = () => false) {
        const targets = request.targets;
        const patternIds = request.patternIds;
        const n = targets.length;
        const entries = [];
        const warnings = [];
        const taken = new Set(); // sets already in the list
        const broken = new Set(); // sets whose file could not be had this run
        const stop = () => ({ entries, warnings, cancelled: true });
        const plays = request.skipPlayed ? await played() : new Map();

        // Downloads go one at a time (the mirrors are shared); a set started ahead is joined, not fetched again.
        // After "Stop" a running download finishes in the background, a queued one never starts.
        let downloads = Promise.resolve();
        const fetched = new Map(); // set id → Promise of { file }
        const listening = new Map(); // set id → onProgress of the step waiting for it
        const fetchSet = (card) => {
            const id = card.beatmapsetId;
            if (!fetched.has(id)) {
                const job = downloads.then(() => {
                    if (isCancelled()) throw new Error(t("app.shared.cancelled"));
                    return download({ beatmapsetId: id, artist: card.artist, title: card.title, onProgress: (p) => listening.get(id)?.(p) });
                });
                downloads = job.catch(() => {});
                fetched.set(id, job);
            }
            return fetched.get(id);
        };

        const windowAt = (k) => targetForWindow({ skill: null, manualDan: targets[k], patternId: patternIds[k % patternIds.length], dan: WINDOW });
        const searches = new Map(); // step → Promise of { items } | { error }; the next one starts while a map is analysed
        const searchAt = (k) => {
            if (k >= n) return null;
            if (!searches.has(k)) {
                const w = windowAt(k);
                const params = searchParams({ patternId: w.patternId, lo: w.lo, hi: w.hi, lengthId: request.lengthId, rankedOnly: request.rankedOnly });
                searches.set(k, Promise.resolve().then(() => searchMaps(params)).then((res) => ({ items: res?.items ?? [] }), (error) => ({ error })));
            }
            return searches.get(k);
        };

        const candidatesAt = (k, found) => rankSets(found.items, windowAt(k), { played: plays, hidePlayed: Boolean(request.skipPlayed) })
            .filter((c) => !taken.has(c.beatmapsetId) && !broken.has(c.beatmapsetId));
        // While a map is analysed: the next step's search, and its first candidate's set when Songs lacks it.
        const ahead = async (k, current) => {
            const found = await searchAt(k);
            if (!found || found.error || isCancelled()) return;
            const card = candidatesAt(k, found).find((c) => c.beatmapsetId !== current);
            if (!card || fetched.has(card.beatmapsetId)) return;
            if (await findLocal(card.beatmapsetId, card.beatmapId)) return;
            if (!isCancelled()) fetchSet(card).catch(() => {});
        };

        for (let k = 0; k < n; k += 1) {
            const i = k + 1;
            const target = targets[k];
            const patternId = patternIds[k % patternIds.length];
            if (isCancelled()) return stop();
            progress({ i, n, phase: "search", patternId, target });
            const found = await unlessCancelled(searchAt(k), isCancelled);
            if (found === STOPPED || isCancelled()) return stop();
            if (found.error) {
                warnings.push({ kind: "miss", i, reason: String(found.error?.message ?? found.error) });
                continue;
            }
            const cards = candidatesAt(k, found).slice(0, CANDIDATES);
            if (!cards.length) {
                warnings.push({ kind: "miss", i, reason: t("marathon.err.noCandidates") });
                continue;
            }

            let best = null;
            let lastError = null;
            for (const card of cards) {
                const name = cardName(card);
                if (isCancelled()) return stop();
                let chart;
                try {
                    const local = await findLocal(card.beatmapsetId, card.beatmapId);
                    if (local) {
                        progress({ i, n, phase: "songs", name });
                        chart = { path: local.path, osuText: local.osuText, from: "songs" };
                    } else {
                        progress({ i, n, phase: "download", name, received: 0, total: null });
                        listening.set(card.beatmapsetId, ({ received, total }) => progress({ i, n, phase: "download", name, received, total: total ?? null }));
                        let got;
                        try {
                            got = await unlessCancelled(fetchSet(card), isCancelled);
                        } finally {
                            listening.delete(card.beatmapsetId);
                        }
                        if (got === STOPPED || isCancelled()) return stop();
                        const out = await extract(await readFile(got.file), card.beatmapId, card.beatmapsetId, { version: card.version });
                        chart = { path: out.osuPath, osuText: out.osuText, from: "download" };
                    }
                } catch (error) {
                    lastError = error;
                    broken.add(card.beatmapsetId);
                    log(`marathon auto ${i}/${n}: ${card.beatmapsetId}/${card.beatmapId} skipped: ${error?.message}`);
                    progress({ i, n, phase: "skip", name });
                    continue;
                }
                if (isCancelled()) return stop();
                if (k + 1 < n) ahead(k + 1, card.beatmapsetId).catch(() => {});
                progress({ i, n, phase: "analyze", name });
                const fit = await rateForDan({ analyze, osuText: chart.osuText, target, ...RATE, isCancelled });
                if (!fit.ok) {
                    if (fit.reason === "cancelled") return stop();
                    lastError = new Error(fit.result?.message || t("marathon.err.noDan"));
                    progress({ i, n, phase: "skip", name });
                    continue;
                }
                const miss = Math.abs(fit.numeric - target);
                if (!best || miss < best.miss - EPS) best = { card, chart, fit, miss };
                if (miss <= TOLERANCE + EPS) break;
                progress({ i, n, phase: "skip", name });
            }
            if (!best) {
                warnings.push({ kind: "miss", i, reason: String(lastError?.message ?? t("marathon.err.noCandidates")) });
                continue;
            }
            const { card, chart, fit, miss } = best;
            taken.add(card.beatmapsetId);
            entries.push({
                path: chart.path, name: chartName(chart.osuText), rate: fit.rate, label: fit.label, numeric: fit.numeric,
                cutMs: cutRange(chart.osuText)?.cutMs ?? null, targetDan: target, trackerDan: card.dan,
                beatmapId: card.beatmapId, beatmapsetId: card.beatmapsetId, from: chart.from,
            });
            if (miss > TOLERANCE + EPS) warnings.push({ kind: fit.numeric < target ? "short" : "over", i, label: fit.label, rate: fit.rate });
        }
        progress({ i: n, n, phase: "done" });
        return { entries, warnings };
    }

    return { run };
}
