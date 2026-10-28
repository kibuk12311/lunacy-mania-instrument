// "Создать карту" tab (mapgen v3): song → timing → parts → difficulties and variants → preview → saving (stream C).
// Loading a song: decode → onset envelope → fine onsets → detect-timing in the worker (the local detector if that fails)
// → timing panel and wave strip → parts and energy curve on the timeline → beat grid on the playfield → export panel.
// «Создать карту» makes 3 variants of one range, or one variant per difficulty of a mapset, through generate-map
// (one call per variant; generating writes no file). The best card of each difficulty is chosen after ranking; the
// playfield and the timeline badges show the chosen card; «Ещё вариант» and «Перегенерировать незакреплённое» add cards.
// Wave 3 (stream U, docs/2026-10-25-mapgen-v3-ml-addendum.md §2.2, §6): on song load the light stems
// (src/audio/stems.js) are computed right after the onset envelope, in chunks so «Разбираем звук на партии…» paints,
// and go to generate-map as the top-level `stems` (a failure only leaves them out). The generator options
// (genOptions.js: model strength, candidates, style, repeats) go into every request; with the critic choosing each
// card from several candidates a run of one range makes CARDS_WITH_CRITIC cards. «Перегенерировать только эту часть»
// locks every other part; 👍/👎 go to rate-variant, and the ratings line under the cards comes from ratings-summary.
import { onsetEnvelope, envelopeToTransfer } from "../../src/audio/onset.js";
import { detectTiming } from "../../src/audio/tempo.js";
import { fineOnset } from "../../src/audio/fineOnset.js";
import { slotsForTiming, clickTimes, sectionsToPoints, timingSections } from "../../src/gen/grid.js";
import { normalizeShares } from "../../src/gen/request.js";
import { parseRows } from "../../src/gen/mapRows.js";
import { isDetailed, onPatternMode, createPatternModeSwitch } from "./patternMode.js";
import { renderPatternChips, patternsOf, toggleFamily, toggleFlavour } from "./patternPicker.js";
import { t } from "../../src/i18n/i18n.js";
import { createAudioPlayer } from "./audioPlayer.js";
import { createTimingPanel, withMirrors } from "./timingPanel.js";
import { createWaveStrip } from "./waveStrip.js";
import { createTimeline, energyFallback, toPartSpecs, kindText, rangeText, PART_KINDS } from "./timeline.js";
import { createPlayfield } from "./playfield.js";
import { gridLines } from "./snapColors.js";
import { createDiffList } from "./diffList.js";
import { createResultView, newDiff, addVariant, rankFallback } from "./resultView.js";
import { initExportPanel } from "./exportPanel.js";
import { initRemapPanel } from "./remapPanel.js";
import { createGenOptions, probeGpu } from "./genOptions.js";
import { runAuto } from "./autoPick.js";
import { ensureProfile as ensureSharedProfile } from "./profile.js";

const ANALYSIS_RATE = 22050;
const CHECK_SEC = 8;
const VARIANTS = 3;
const SEED_STEP = 1009;
const REDETECT_MS = 300;
const CURVE_POINTS = 432;
const PHASE_KEYS = {
    search: "create.progress.search", retry: "create.progress.retry", describe: "create.progress.describe", prepare: "create.generating",
    critic: "create.progress.critic", soften: "create.progress.soften",
};
const RATINGS_RECHECK_MS = 4000; // the personal model is refitted 2 s after a rating; look again a little later

const $ = (id) => document.getElementById(id);
const state = {
    song: null, // { path, title, durationMs, buffer, samples, envelope, transfer, fine, stems: StemsTransfer | null }
    selected: new Map([["Jumpstream", 100]]),
    flavours: new Map(), // family → Set of flavour ids, sent only in the Detailed mode (remembered in General)
    mix: "sections",
    diffs: [], // newDiff per range of the last run, easiest first
    focus: null, // { d, id }: the card on the playfield and the timeline
    running: null, // { stop, jobId, prefix }
    loads: 0,
    ratings: null, // { n, up, down, active, note, failed }: the line under the cards
};
let ui = null; // the parts built in initCreateTab

function setStatus(text) {
    $("gen-status").textContent = text;
}

async function decode(file) {
    const ctx = new AudioContext();
    try {
        const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
        const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * ANALYSIS_RATE), ANALYSIS_RATE);
        const source = offline.createBufferSource();
        source.buffer = buffer;
        source.connect(offline.destination);
        source.start();
        const mono = await offline.startRendering();
        return { buffer, samples: mono.getChannelData(0) };
    } finally {
        ctx.close();
    }
}

// The generator core's renderer-side helpers (src/gen/songParts.js, src/gen/variants.js); a missing module only
// means no parts are found here (the worker finds them) and the ranking is resultView's own.
function loadCore() {
    ui.core ??= Promise.all([
        import("../../src/gen/songParts.js").catch(() => null),
        import("../../src/gen/variants.js").catch(() => null),
    ]).then(([parts, variants]) => ({
        detectParts: parts?.detectParts ?? null, energyCurve: parts?.energyCurve ?? null, rankVariants: variants?.rankVariants ?? null,
    }));
    return ui.core;
}

const rank = (list, range) => (ui.rankVariants ?? rankFallback)(list, range);

function localTiming(envelope) {
    const { bpm, offsetMs } = detectTiming(envelope);
    return withMirrors([{ timeMs: offsetMs, bpm, meter: 4 }]);
}

const fineTransfer = (fine) => (fine ? { values: fine.values, hopSec: fine.hopSec } : null);

// Parts found on the song for the current timing, or null when the parts module is not there or fails.
// They end where the envelope ends, not quite where the decoded song does; the last one is made to end with the song,
// as the worker does, so its parts (the variant's PartReport[]) line up with the timeline's and a part can be locked.
async function findParts() {
    const song = state.song;
    const core = await loadCore();
    if (!song || !core.detectParts) return null;
    try {
        const found = (core.detectParts(song.envelope, slotsForTiming(ui.timing.timing, song.durationMs)) ?? [])
            .filter((p) => p.startMs < song.durationMs)
            .map((p) => ({ startMs: p.startMs, endMs: Math.min(p.endMs, song.durationMs), kind: PART_KINDS.includes(p.kind) ? p.kind : "part" }));
        if (found.length) found.at(-1).endMs = song.durationMs;
        return found;
    } catch {
        return null;
    }
}

async function redetectParts() {
    const load = state.loads;
    const found = await findParts();
    if (found && load === state.loads && !ui.timeline.edited) ui.timeline.setParts(found);
}

let redetectTimer = null;
function scheduleRedetect() {
    clearTimeout(redetectTimer);
    if (!state.song || ui.timeline.edited) return;
    redetectTimer = setTimeout(redetectParts, REDETECT_MS);
}

// a newer song load stops the stems of the one before
class Superseded extends Error {}

function loadStems() {
    ui.stemsModule ??= ui.stemsGiven ? Promise.resolve(ui.stemsGiven) : import("../../src/audio/stems.js").catch(() => null);
    return ui.stemsModule;
}

// The song's light stems as the StemsTransfer generate-map sends beside the envelope, or null when they fail (the
// worker then takes a model that does not need them). The status shows while they run, yielding between chunks.
async function songStems(samples, load) {
    setStatus(t("create.ml.stems"));
    try {
        const stems = await loadStems();
        if (!stems?.computeStems) return null;
        const computed = await stems.computeStems(samples, ANALYSIS_RATE, {
            pause: async () => {
                await ui.pause();
                if (load !== state.loads) throw new Superseded();
            },
        });
        return stems.stemsToTransfer(computed);
    } catch (error) {
        if (!(error instanceof Superseded)) console.warn(`stems: ${error?.message ?? error}`);
        return null;
    } finally {
        if (load === state.loads) setStatus("");
    }
}

async function loadSong(file) {
    const path = window.danApi.pathForFile(file);
    if (!path) return setStatus(t("create.song.noPath"));
    $("drop").textContent = t("create.song.reading", { name: file.name });
    $("generate").disabled = true;
    setAutoDisabled(true);
    ui.options?.askGpu();
    await new Promise((r) => setTimeout(r, 30)); // let the label paint before the heavy work
    const load = (state.loads += 1);
    if (state.running) state.running.stop = true;
    try {
        const { buffer, samples } = await decode(file);
        const envelope = onsetEnvelope(samples, ANALYSIS_RATE);
        let fine = null;
        try {
            fine = fineOnset(samples, ANALYSIS_RATE);
        } catch {
            // the worker refines without it
        }
        const durationMs = Math.round(buffer.duration * 1000);
        state.song = { path, title: file.name.replace(/\.[^.]+$/, ""), durationMs, buffer, samples, envelope, transfer: envelopeToTransfer(envelope), fine, stems: null };
        state.diffs = [];
        state.focus = null;
        ui.player.load(buffer);
        ui.strip.setSong({ samples, sampleRate: ANALYSIS_RATE, durationMs, envelope });

        // the worker detects the timing while the stems are worked out here
        const asked = (async () => {
            try {
                return await window.danApi.detectTiming?.({ envelope: state.song.transfer, fine: fineTransfer(fine) });
            } catch {
                return null; // the local detector below
            }
        })();
        const stems = await songStems(samples, load);
        if (load !== state.loads) return;
        state.song.stems = stems;
        ui.options?.setStems(Boolean(stems));
        let timing = null;
        let modelInfo = null;
        const answer = await asked;
        if (answer?.ok && answer.timing?.sections?.length) {
            timing = answer.timing;
            modelInfo = answer.modelInfo ?? null;
        }
        if (load !== state.loads) return;
        timing ??= localTiming(envelope);
        ui.timing.setModelInfo(modelInfo);
        ui.timing.set(timing, { detected: true });

        const core = await loadCore();
        if (load !== state.loads) return;
        let energy = null;
        try {
            energy = core.energyCurve?.(envelope, durationMs, CURVE_POINTS) ?? null;
        } catch {
            energy = null;
        }
        ui.timeline.setSong({ durationMs, energy: energy ?? energyFallback(envelope, durationMs, CURVE_POINTS) });
        const found = await findParts();
        if (load !== state.loads) return;
        if (found) ui.timeline.setParts(found);
        ui.playfield.setRows(null);
        ui.results.render([]);
        $("parts-group").hidden = false;
        $("preview").hidden = false;
        ui.strip.showAround(ui.timing.timing.sections[0].timeMs);
        const mins = Math.floor(buffer.duration / 60);
        const secs = String(Math.round(buffer.duration % 60)).padStart(2, "0");
        $("drop").textContent = `${file.name} · ${mins}:${secs}`;
        $("generate").disabled = false;
        setAutoDisabled(false);
        setStatus("");
        ui.exportPanel.onSongLoaded?.(songForExport());
        ui.options?.refresh(); // detect-timing told main the model's styles
    } catch (error) {
        if (load !== state.loads) return;
        state.song = null;
        $("drop").textContent = t("create.song.drop");
        setStatus(t("create.song.openFailed", { message: error.message }));
    }
}

function songForExport() {
    const song = state.song;
    if (!song) return null;
    return { path: song.path, title: song.title, durationMs: song.durationMs, envelope: song.envelope, timing: ui.timing.timing, parts: toPartSpecs(ui.timeline.parts) };
}

// What stream C saves: the song and the chosen variant of each difficulty, easiest first.
export function getSelection() {
    const diffs = [];
    for (const diff of state.diffs) {
        const card = diff.cards.find((c) => c.id === diff.selectedId);
        if (card) diffs.push({ id: card.id, version: card.answer.version, range: diff.range, result: card.answer.result, reachable: card.answer.reachable });
    }
    return { song: songForExport(), diffs };
}

function stopCheck() {
    if (ui.checking) ui.player.pause();
}

// «▶ проверить на слух»: 8 s from the cursor with a click on every beat (bars accented).
function checkByEar() {
    if (ui.checking) return stopCheck();
    if (!state.song || !ui.timing.valid()) return;
    const timing = ui.timing.timing;
    const from = ui.player.now();
    const to = from + CHECK_SEC * 1000;
    const bars = new Set(gridLines(timing, from, to, 1).filter((l) => l.bar).map((l) => Math.round(l.t)));
    const clicks = clickTimes(sectionsToPoints(timingSections(timing)), from, to, 1).map((ms) => ({ t: ms, accent: bars.has(Math.round(ms)) }));
    ui.player.playFrom(from / 1000, CHECK_SEC, { clicks });
    ui.checking = true;
    $("listen").textContent = t("create.listen.stop");
}

const choice = () => ({ families: state.selected, flavours: state.flavours });

function chosenPatterns() {
    return normalizeShares(patternsOf(choice(), isDetailed()));
}

function phaseText(p) {
    if (p.phase === "partSearch") return t("create.progress.partSearch", { i: Math.min(p.n, (p.i ?? 0) + 1), n: p.n, kind: kindText(p.kind) });
    if (p.phase === "candidates") return t("create.progress.candidates", { i: Math.min(p.n, (p.i ?? 0) + 1), n: p.n });
    if (p.phase === "boost") return t("create.progress.boost", { i: Math.min(3, Math.max(1, p.i ?? 1)), n: 3 });
    const key = PHASE_KEYS[p.phase];
    return key ? t(key) : "";
}

let jobCount = 0;
function payload(job, patterns, jobId) {
    const song = state.song;
    const { sections, bpm, offsetMs } = ui.timing.timing;
    return {
        jobId, audioPath: song.path, title: song.title, durationMs: song.durationMs, envelope: song.transfer,
        ...(song.stems ? { stems: song.stems } : {}),
        timing: { sections, bpm, offsetMs },
        request: {
            range: job.range, patterns, mix: state.mix,
            stamina: Number($("stamina").value) / 100,
            burst: Number($("burst").value) / 100,
            seed: job.planSeed, planSeed: job.planSeed, noteSeed: job.noteSeed,
            snaps: ui.timing.snaps(), normalizeSv: ui.timing.normalizeSv(),
            ...(ui.options?.request() ?? {}),
            ...(job.parts?.length ? { parts: job.parts } : {}),
            ...(job.lock ? { lock: job.lock } : {}),
        },
    };
}

const newSeed = () => 1 + Math.floor(ui.random() * 999983);

function redrawResults() {
    ui.results.render(state.diffs, { busy: Boolean(state.running), ratings: state.ratings });
}

// The ratings line under the cards, from main (ratings-summary).
async function refreshRatings() {
    try {
        const summary = await window.danApi.ratingsSummary?.();
        if (!summary?.ok) return;
        state.ratings = { ...(state.ratings ?? {}), n: summary.n, up: summary.up, down: summary.down, active: summary.active };
        ui.results.setRatings(state.ratings);
    } catch {
        // an older main: no ratings line
    }
}

// 👍/👎 of a card → rate-variant; the count under the cards follows.
async function rateVariant(rating) {
    const answer = (await window.danApi.rateVariant?.(rating)) ?? { ok: false, message: t("app.gen.failed") };
    if (answer?.ok) {
        state.ratings = { ...(state.ratings ?? {}), n: answer.n, note: "", failed: false };
        ui.results.setRatings(state.ratings);
        clearTimeout(ui.ratingsTimer);
        ui.ratingsTimer = setTimeout(refreshRatings, RATINGS_RECHECK_MS);
    }
    return answer;
}

// «Выгрузить мои оценки»: a new file in the documents folder.
async function exportRatings() {
    let answer;
    try {
        answer = await window.danApi.ratingsExport?.();
    } catch (error) {
        answer = { ok: false, message: error.message };
    }
    let note;
    if (answer?.ok) note = t("create.ml.exported", { file: answer.file });
    else if (answer?.code === "empty") note = answer.message;
    else note = t("create.ml.exportFailed", { message: answer?.message ?? t("app.gen.failed") });
    state.ratings = { ...(state.ratings ?? { n: 0 }), note, failed: !answer?.ok };
    ui.results.setRatings(state.ratings);
}

// Shows a card on the playfield and the timeline; it becomes its difficulty's chosen card.
function focusCard(d, id) {
    const diff = state.diffs[d];
    const card = diff?.cards.find((c) => c.id === id);
    if (!card) return;
    diff.selectedId = id;
    state.focus = { d, id };
    ui.playfield.setRows(parseRows(card.answer.osuText ?? ""));
    const reports = card.answer.parts ?? [];
    if (reports.length && !ui.timeline.parts.length) {
        ui.timeline.setParts(reports.map((r) => ({ startMs: r.startMs, endMs: r.endMs, kind: PART_KINDS.includes(r.kind) ? r.kind : "part", ...(r.empty ? { empty: true } : {}) })));
    }
    const parts = ui.timeline.parts;
    const aligned = reports.length > 0 && reports.length === parts.length
        && reports.every((r, i) => Math.abs(r.startMs - parts[i].startMs) <= 1 && Math.abs(r.endMs - parts[i].endMs) <= 1);
    ui.timeline.setResult({ reports, locks: aligned ? card.locks : new Set(), canLock: aligned, structure: card.answer.structure ?? null });
    redrawResults();
}

// One generate-map call per job, in order; «Стоп» ends the run after the call that is going.
async function runJobs(jobs, { kind }) {
    let patterns;
    try {
        patterns = chosenPatterns();
    } catch (error) {
        return setStatus(error.message);
    }
    const song = state.song;
    state.running = { stop: false, jobId: null, prefix: "" };
    ui.diffList.setBusy(true);
    setAutoDisabled(true);
    $("generate").textContent = t("create.variants.stop");
    redrawResults();
    let failure = null;
    try {
        for (let k = 0; k < jobs.length && !state.running.stop; k += 1) {
            const job = jobs[k];
            jobCount += 1;
            const jobId = `gen-${Date.now()}-${jobCount}`;
            state.running.jobId = jobId;
            state.running.prefix = kind === "set"
                ? t("create.set.progress", { i: k + 1, n: jobs.length, dan: rangeText(job.range) })
                : t("create.variants.progress", { n: k + 1, total: jobs.length });
            setStatus(`${state.running.prefix} ${t("create.generating")}`);
            const sent = payload(job, patterns, jobId);
            const answer = await window.danApi.generateMap(sent);
            if (song !== state.song) break; // another song was loaded meanwhile
            if (!answer?.ok) {
                if (answer?.code === "timingChanged" && job.base) {
                    job.base.locks.clear();
                    failure = t("create.lock.timingChanged");
                } else {
                    failure = t("create.error", { message: answer?.message ?? t("app.gen.failed") });
                }
                break;
            }
            const diff = state.diffs[job.d];
            ui.options?.noteAnswer(answer, sent.request.modelSize);
            addVariant(diff, answer, { rank, extra: { partsSent: job.parts ?? null, locks: new Set(job.keepLocks ?? []) } });
            focusCard(job.d, diff.selectedId);
        }
    } catch (error) {
        failure = t("create.error", { message: error.message });
    } finally {
        state.running = null;
        ui.diffList.setBusy(false);
        $("generate").disabled = !state.song;
        setAutoDisabled(!state.song);
        if (state.focus) focusCard(state.focus.d, state.focus.id);
        else redrawResults();
        setStatus(failure ?? "");
        ui.exportPanel.onSelectionChanged?.();
        ui.options?.refresh(); // the worker may have named the model's styles
        refreshRatings(); // the personal model may have become active meanwhile
    }
}

const setAutoDisabled = (off) => {
    const button = $("auto-map");
    if (button) button.disabled = off;
};

// «Автоподбор»: the plan for the loaded song (autoPick.js) into the controls, then «Создать карту» with them.
function autoMap() {
    if (!state.song || state.running) return undefined;
    if (!ui.timing.valid()) return setStatus(t("create.timing.check"));
    const song = state.song;
    return runAuto({
        busy: () => Boolean(state.running),
        song: () => (state.song === song ? { bpm: ui.timing.timing.bpm, durationMs: song.durationMs, envelope: song.envelope, stems: song.stems } : null),
        parts: () => ui.timeline.parts,
        ensureProfile: ui.ensureProfile,
        available: () => ui.options?.available?.() ?? {},
        controls: {
            diffList: ui.diffList,
            setPatterns: (selected) => {
                state.selected = selected;
                renderPatterns();
            },
            setMix: (mix) => {
                state.mix = mix;
                for (const c of $("mix").children) c.classList.toggle("sel", c.dataset.mix === mix);
            },
            stamina: $("stamina"), burst: $("burst"), timing: ui.timing, options: ui.options, timeline: ui.timeline,
        },
        summaryRoot: $("auto-summary"),
        onEdit: () => {
            const summary = $("auto-summary");
            if (summary) summary.hidden = true;
            $("diffs").scrollIntoView?.({ behavior: "smooth", block: "center" });
        },
        generate: () => (state.song === song ? generate() : undefined),
        setStatus,
    });
}

function currentParts() {
    const parts = ui.timeline.parts;
    return parts.length ? toPartSpecs(parts, { detailed: isDetailed() }) : null;
}

// «Создать карту»: 3 variants of one range (2 when the critic picks each from several candidates), or one variant per
// difficulty (all with the same base seeds).
function generate() {
    if (state.running) {
        state.running.stop = true;
        return undefined;
    }
    if (!state.song) return undefined;
    if (!ui.timing.valid()) return setStatus(t("create.timing.check"));
    stopCheck();
    const ranges = ui.diffList.ranges();
    state.diffs = ranges.map((range) => newDiff(range));
    state.focus = null;
    ui.timeline.setResult({});
    const base = newSeed();
    const parts = currentParts();
    const variants = ui.options?.variants(VARIANTS) ?? VARIANTS;
    const jobs = ranges.length === 1
        ? Array.from({ length: variants }, (_, v) => ({ d: 0, range: ranges[0], planSeed: base + v * SEED_STEP, noteSeed: base + v * SEED_STEP, parts }))
        : ranges.map((range, d) => ({ d, range, planSeed: base, noteSeed: base, parts }));
    return runJobs(jobs, { kind: ranges.length === 1 ? "variants" : "set" });
}

// «Ещё вариант» for one difficulty: new seeds, today's settings.
function moreVariant(d) {
    if (state.running || !state.song || !state.diffs[d]) return undefined;
    if (!ui.timing.valid()) return setStatus(t("create.timing.check"));
    const seed = newSeed();
    return runJobs([{ d, range: state.diffs[d].range, planSeed: seed, noteSeed: seed, parts: currentParts() }], { kind: "variants" });
}

// The parts a stored map was made with, with the settings sent for them (the worker may have tidied the edges).
function basePartsOf(card) {
    const reports = card.answer.parts ?? [];
    const sent = card.partsSent ?? [];
    if (!reports.length) return sent;
    return reports.map((r) => {
        const same = sent.find((p) => Math.abs(p.startMs - r.startMs) <= 1 && Math.abs(p.endMs - r.endMs) <= 1);
        const spec = { startMs: r.startMs, endMs: r.endMs, kind: PART_KINDS.includes(r.kind) ? r.kind : "part" };
        const range = same?.range ?? r.wanted;
        if (range) spec.range = { lo: range.lo, hi: range.hi };
        if (same?.patterns) spec.patterns = same.patterns;
        if (same?.empty ?? r.empty) spec.empty = true;
        if (Number.isSafeInteger(same?.seed)) spec.seed = same.seed;
        return spec;
    });
}

// A new variant of card `id` that keeps the parts `keep` note for note (a lock of them), the rest with a new note seed;
// the new card shows `shown` as locked.
function regenerateKeeping(d, id, keep, shown = keep) {
    const diff = state.diffs[d];
    const card = diff?.cards.find((c) => c.id === id);
    if (state.running || !card || !state.song) return undefined;
    const parts = basePartsOf(card);
    const locks = [...new Set(keep)].filter((i) => Number.isInteger(i) && i >= 0 && i < parts.length).sort((a, b) => a - b);
    if (!locks.length) return undefined;
    const planSeed = Number.isSafeInteger(card.answer.planSeed) ? card.answer.planSeed : newSeed();
    return runJobs([{
        d, range: diff.range, planSeed, noteSeed: newSeed(), parts, base: card, keepLocks: shown.filter((i) => i < parts.length),
        lock: { fromId: card.id, parts: locks },
    }], { kind: "variants" });
}

// «Перегенерировать незакреплённое»: the locked parts stay note for note, the rest gets a new note seed.
function regenerate(d, id) {
    const card = state.diffs[d]?.cards.find((c) => c.id === id);
    if (!card?.locks.size) return undefined;
    return regenerateKeeping(d, id, [...card.locks]);
}

// «Перегенерировать только эту часть» (the part editor): every other part of the chosen card stays as it is; the new
// card keeps the locks the user had on the others.
function regenerateOnly(part) {
    const focus = state.focus;
    const card = focus && state.diffs[focus.d]?.cards.find((c) => c.id === focus.id);
    if (!card) return undefined;
    const count = basePartsOf(card).length;
    const others = Array.from({ length: count }, (_, i) => i).filter((i) => i !== part);
    return regenerateKeeping(focus.d, focus.id, others, [...card.locks].filter((i) => i !== part));
}

function toggleLock(d, id, part) {
    const card = state.diffs[d]?.cards.find((c) => c.id === id);
    if (!card || state.running) return;
    if (card.locks.has(part)) card.locks.delete(part);
    else card.locks.add(part);
    if (state.focus?.d === d && state.focus.id === id) focusCard(d, id);
    else redrawResults();
}

// The pattern chips (the families, and in Detailed their kinds too) and the share sliders of the chosen families.
function renderPatterns() {
    renderPatternChips($("patterns"), choice(), {
        detailed: isDetailed(),
        onFamily: (name) => { toggleFamily(choice(), name, { keepOne: true }); renderPatterns(); },
        onFlavour: (name, id) => { toggleFlavour(choice(), name, id); renderPatterns(); },
    });
    const shares = $("shares");
    if (state.selected.size < 2) {
        shares.replaceChildren();
        return;
    }
    const percents = new Map(); // name → its "%" label
    const showPercents = () => {
        const total = [...state.selected.values()].reduce((a, b) => a + b, 0) || 1;
        for (const [name, label] of percents) label.textContent = `${Math.round((state.selected.get(name) / total) * 100)}%`;
    };
    shares.replaceChildren(...[...state.selected].map(([name, value]) => {
        const row = document.createElement("label");
        row.className = "slider-row";
        const title = document.createElement("span");
        title.textContent = name;
        const input = document.createElement("input");
        input.type = "range";
        input.min = "0";
        input.max = "100";
        input.value = String(value);
        const pct = document.createElement("span");
        percents.set(name, pct);
        // Only the numbers change while dragging: rebuilding the rows would drop the slider out from under the mouse.
        input.addEventListener("input", () => {
            state.selected.set(name, Number(input.value));
            showPercents();
        });
        row.append(title, input, pct);
        return row;
    }));
    showPercents();
}

// The canvases follow the player while it plays.
function frame() {
    const now = ui.player.now();
    ui.playfield.frame(now);
    ui.timeline.frame(now);
    ui.strip.frame(now);
    if (ui.player.playing) globalThis.requestAnimationFrame?.(frame);
}

function redrawCanvases() {
    if (!state.song) return;
    ui.playfield.redraw();
    ui.timeline.redraw();
    ui.strip.redraw();
}

// A field that takes Space itself has the keyboard (a slider does not: Space still plays after moving one).
function typingInField() {
    const el = document.activeElement;
    const tag = el?.tagName;
    if (tag === "INPUT") return el.type !== "range";
    return tag === "SELECT" || tag === "TEXTAREA";
}

// opts are for tests: random (seeds), core (instead of loading src/gen/songParts.js and variants.js), player,
// the stream C panels; stems (instead of src/audio/stems.js) and pause (the wait between their chunks); gpu (the
// graphics-card probe of the model-strength picker); ensureProfile (the profile «Автоподбор» reads, renderer/profile.js).
const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
export function initCreateTab({
    random = Math.random, core = null, player = null, exportPanel = initExportPanel, remapPanel = initRemapPanel,
    stems = null, pause = nextTask, gpu = probeGpu, ensureProfile = ensureSharedProfile,
} = {}) {
    ui = { ensureProfile, random, core: core ? Promise.resolve(core) : null, checking: false, rankVariants: null, stemsGiven: stems, stemsModule: null, pause };
    ui.player = player ?? createAudioPlayer();
    ui.timing = createTimingPanel({
        root: $("timing-sections"), snapsRoot: $("snaps"), bpmInput: $("bpm"), offsetInput: $("offset"), note: $("timing-note"),
        getCursor: () => ui.player.now(), getDurationMs: () => state.song?.durationMs ?? 0,
        onChange: (_timing, why) => {
            redrawCanvases();
            if (why === "edit") scheduleRedetect();
        },
        onFitWave: async (timing) => {
            const song = state.song;
            if (!song) return;
            try {
                const answer = await window.danApi.detectTiming?.({ envelope: song.transfer, fine: fineTransfer(song.fine), hint: timing });
                if (answer?.ok && answer.timing?.sections?.length && song === state.song) {
                    ui.timing.set(answer.timing, { refined: true });
                    scheduleRedetect();
                }
            } catch {
                // the timing stays as it was
            }
        },
    });
    ui.strip = createWaveStrip({
        canvas: $("wave-strip"), getTiming: () => ui.timing.timing, getSelected: () => ui.timing.selected, getCursor: () => ui.player.now(),
        onCursor: (ms) => ui.player.seek(ms), onNudge: (d) => ui.timing.nudge(d),
    });
    ui.timeline = createTimeline({
        canvas: $("timeline"), editor: $("part-editor"), getCursor: () => ui.player.now(),
        onSeek: (ms) => ui.player.seek(ms),
        onChange: () => ui.exportPanel?.onSelectionChanged?.(),
        onReset: () => {
            ui.timeline.setParts(ui.timeline.parts.map(({ startMs, endMs, kind }) => ({ startMs, endMs, kind })));
            redetectParts();
        },
        onToggleLock: (part) => { if (state.focus) toggleLock(state.focus.d, state.focus.id, part); },
        onOnlyThis: (part) => regenerateOnly(part),
    });
    ui.playfield = createPlayfield({ canvas: $("playfield"), controls: $("play-controls"), player: ui.player, getTiming: () => ui.timing.timing });
    ui.diffList = createDiffList({ root: $("diffs"), generateButton: $("generate") });
    ui.results = createResultView({
        root: $("gen-result"),
        onUse: (d, id) => {
            focusCard(d, id);
            ui.exportPanel.onSelectionChanged?.();
        },
        onMore: moreVariant,
        onRegen: regenerate,
        onToggleLock: toggleLock,
        onRate: rateVariant,
        onExport: exportRatings,
    });
    // the graphics-card probe waits until the tab is first shown (or a song is loaded)
    ui.options = createGenOptions({ root: $("gen-options"), gpu, probeAtStart: false });
    refreshRatings();
    ui.exportPanel = exportPanel({ root: $("export-panel"), metaRoot: $("meta-group"), player: ui.player, getSelection }) ?? {};
    remapPanel({ root: $("remap-panel") });
    loadCore().then((c) => { ui.rankVariants = c.rankVariants; });

    ui.player.subscribe(({ playing }) => {
        if (!playing && ui.checking) {
            ui.checking = false;
            $("listen").textContent = t("create.listen.play");
        }
        if (playing) globalThis.requestAnimationFrame?.(frame);
        else if (state.song) frame();
    });
    window.danApi.onGenerateProgress?.((p) => {
        if (state.running && p?.jobId === state.running.jobId) setStatus(`${state.running.prefix} ${phaseText(p)}`);
    });

    $("listen").textContent = t("create.listen.play");
    $("pattern-mode").replaceChildren(createPatternModeSwitch());
    renderPatterns();
    // the switch is shared by every tab: the chips, the cards and the part editor follow it
    onPatternMode(() => {
        renderPatterns();
        redrawResults();
        ui.timeline.refresh();
    });
    for (const chip of $("mix").children) {
        chip.addEventListener("click", () => {
            state.mix = chip.dataset.mix;
            for (const c of $("mix").children) c.classList.toggle("sel", c === chip);
        });
    }
    const mode = $("create-mode");
    mode.hidden = false;
    for (const chip of mode.children) {
        chip.addEventListener("click", () => {
            const remap = chip.dataset.mode === "remap";
            for (const c of mode.children) c.classList.toggle("sel", c === chip);
            $("song-mode").hidden = remap;
            $("remap-panel").hidden = !remap;
            if (remap) ui.player.pause();
        });
    }

    const drop = $("drop");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        const file = e.dataTransfer.files[0];
        if (file) loadSong(file);
    });
    $("file").addEventListener("change", (e) => { if (e.target.files[0]) loadSong(e.target.files[0]); });
    $("listen").addEventListener("click", checkByEar);
    $("generate").addEventListener("click", () => {
        // a run of the player's own settings: the «Автоподбор» line no longer says what they are
        const summary = $("auto-summary");
        if (summary && !state.running) summary.hidden = true;
        return generate();
    });
    const auto = $("auto-map");
    if (auto) {
        auto.title = t("create.auto.hint");
        auto.addEventListener("click", () => autoMap());
    }

    // Space plays / pauses the song unless a field has the keyboard; the tab must be showing in song mode
    document.addEventListener?.("keydown", (e) => {
        if (e.key !== " " || e.repeat || typingInField() || !state.song) return;
        if ($("create-tab").hidden || $("song-mode").hidden) return;
        e.preventDefault();
        stopCheck();
        ui.player.toggle();
    });
    window.addEventListener("tab-shown", (e) => {
        if (e.detail !== "create") return;
        ui.options.askGpu();
        redrawCanvases();
    });
    window.addEventListener("resize", redrawCanvases);
}

// For tests: the cards of the last run and the card on the playfield.
export const createTabState = () => ({ diffs: state.diffs, focus: state.focus, running: Boolean(state.running) });
