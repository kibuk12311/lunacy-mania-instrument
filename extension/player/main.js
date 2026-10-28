// The demo player (extension/DESIGN.md §5.5–5.6): an extension page in a full-viewport iframe over the osu! page.
// boot() wires everything with injected parts so tests can run it with fakes; start() is the browser entry.
import { PLAYER_SOURCE, SITE_ORIGIN, ERR } from "../shared/protocol.js";
import { makeT } from "../shared/lang.js";
import { formatRate } from "../shared/rates.js";
import { STRINGS, errorKey } from "./strings.js";
import { parseChart, unplayableReason, noteSpan } from "./chart.js";
import { createJudge } from "./judge.js";
import { createClock, planStart, startChartFor, LEAD_IN_MS } from "./clock.js";
import { createAudio } from "./audio.js";
import { createInput, createRebinder, offsetNudge, keyLabel } from "./input.js";
import { createRenderer } from "./render.js";
import { loadSettings, saveSettings, clampSettings, memoryStorage } from "./settings.js";
import { parseParams, previewStretch, readOszMaps, chooseOsu, readAudio, FILE_FALLBACK } from "./source.js";
import { createUi } from "./ui.js";

export const STATES = Object.freeze(["loading", "ready", "countdown", "playing", "paused", "results", "error"]);
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const END_PAD_MS = 1200; // real ms after the last note before the results
const RETRY_CODES = new Set(["network", "http", "rate-limited", "timeout", "not-found", "analysis", "decode"]);
const mb = (n) => (n / (1024 * 1024)).toFixed(1);

// deps: { params, client: { getOsu, getPreview, getOsz }, readZip, md5Hex, storage, win, doc, audio (createAudio result) }
export async function boot(deps) {
    const { params, client, readZip, md5Hex = null, win, doc } = deps;
    const storage = deps.storage ?? memoryStorage();
    const perf = win.performance ?? globalThis.performance;
    const html = doc.documentElement;
    const t = makeT(STRINGS, params.lang);
    html.setAttribute("lang", params.lang);
    doc.title = t("brand");

    let settings = await loadSettings(storage);
    if (params.rate !== null && params.rate !== undefined) settings = clampSettings({ ...settings, rate: params.rate });
    const ui = createUi({ doc, t });
    const renderer = createRenderer(ui.canvas, { win });
    const audio = deps.audio !== undefined ? deps.audio : createAudio({ volume: settings.volume });

    let state = "";
    let kind = params.src; // preview | full | file
    let gen = 0; // load generation: answers for an older load are dropped
    let loaded = null; // { chart, notes, buffer, audioZeroChartMs, endChartMs|null, label }
    let game = null; // { judge, clock, startChartMs, anchorMs, endChartMs, flash, toast }
    let download = null; // AbortController of the running .osz download
    let rebinding = null; // { rebinder, index, keys, problem }
    let frameId = 0;
    let startToken = 0; // each start() call's own; a start() overtaken by a later one returns without a game
    let closed = false;
    const held = [false, false, false, false];

    function setState(next) {
        state = next;
        html.dataset.lmPlayer = next;
        if (next !== "error") delete html.dataset.lmError;
        if (next !== "loading") delete html.dataset.lmWait;
        ui.settingsButton.disabled = next === "countdown" || next === "playing";
        if (next === "countdown" || next === "playing") {
            cancelRebind();
            ui.setSettingsOpen(false);
        }
        if (ui.settingsOpen) renderSettings();
    }

    function publishStats() {
        const stats = game ? game.judge.stats() : { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0, combo: 0, maxCombo: 0, acc: null, notes: loaded ? countJudgements(loaded.notes) : 0 };
        html.dataset.lmStats = JSON.stringify(stats);
    }

    // ---- errors ----
    function fail(code, extra = {}) {
        if (closed) return;
        stopGame();
        const c = code || "unknown";
        setState("error");
        html.dataset.lmError = c;
        const actions = [];
        if (RETRY_CODES.has(c)) actions.push({ label: t("err.retry"), onClick: () => load(kind), primary: true, action: "retry" });
        if (kind === "preview" && c !== "context") actions.push({ label: t("source.full"), onClick: () => switchSource("full"), action: "to-full" });
        if (kind === "full" && (c === "login" || c === "limit")) actions.push({ label: t("full.download"), onClick: () => load("full"), action: "to-full" });
        ui.showError({
            code: c,
            text: t(errorKey(c), { status: extra.status ? String(extra.status) : "?", name: extra.name || "?" }),
            fallback: FILE_FALLBACK.has(c) || kind !== "preview",
            actions,
        });
    }

    const failWith = (error) => fail(error?.code ?? ERR.NETWORK, error ?? {});

    // ---- loading ----
    function load(nextKind) {
        kind = nextKind;
        stopGame();
        if (download) download.abort();
        download = null;
        loaded = null;
        gen += 1;
        if (!params.map || !params.set) {
            if (kind !== "file") return fail(ERR.BAD_REQUEST);
        }
        if (kind === "preview") return loadPreview(gen);
        if (kind === "full") return showFullOffer();
        return showFilePrompt();
    }

    async function loadPreview(my) {
        setState("loading");
        ui.showLoading(t("loading.osu"));
        const osu = await client.getOsu({ beatmapId: params.map, checksum: params.checksum });
        if (my !== gen) return;
        if (!osu?.ok) return failWith(osu?.error);
        const chart = parseChart(osu.text);
        ui.setMap(chart);
        const reason = unplayableReason(chart);
        if (reason) return fail(reason);
        if (!(chart.previewTime >= 0)) return fail("no-preview");
        ui.showLoading(t("loading.preview"));
        const pv = await client.getPreview({ setId: params.set });
        if (my !== gen) return;
        if (!pv?.ok) return failWith(pv?.error);
        const buffer = await decode(pv.bytes, my);
        if (!buffer) return;
        const stretch = previewStretch(chart.notes, chart.previewTime, buffer.duration);
        if (!stretch.notes.length) return fail("preview-empty");
        loaded = { chart, notes: stretch.notes, buffer, audioZeroChartMs: stretch.startMs, previewStartMs: stretch.startMs, endChartMs: stretch.endMs, label: t("ready.preview", { sec: Math.round(buffer.duration) }) };
        toReady();
    }

    async function decode(bytes, my) {
        if (!audio) {
            fail("no-audio-api");
            return null;
        }
        ui.showLoading(t("loading.decode"));
        try {
            const buffer = await audio.decode(bytes);
            return my === gen ? buffer : null;
        } catch {
            if (my === gen) fail("decode");
            return null;
        }
    }

    function showFullOffer() {
        setState("loading");
        html.dataset.lmWait = "download";
        ui.showFull({ loggedOut: params.login === false, onDownload: startDownload });
    }

    async function startDownload() {
        if (state !== "loading" && state !== "error") return;
        kind = "full";
        const my = ++gen;
        stopGame();
        setState("loading");
        const ctrl = new AbortController();
        download = ctrl;
        const onCancel = () => ctrl.abort();
        ui.showLoading(t("loading.download", { got: "" }), { onCancel });
        const res = await client.getOsz({
            setId: params.set,
            noVideo: true,
            signal: ctrl.signal,
            onProgress: ({ received, total }) => {
                if (my !== gen) return;
                const got = total ? t("mbOf", { n: mb(received), total: mb(total) }) : t("mb", { n: mb(received) });
                ui.showLoading(t("loading.download", { got }), { progress: total ? received / total : null, onCancel });
            },
        });
        if (download === ctrl) download = null;
        if (my !== gen) return;
        if (!res?.ok) {
            if (res?.error?.code === ERR.CANCELLED) return showFullOffer();
            return failWith(res?.error);
        }
        await fromOsz(res.bytes, my, t("ready.full"));
    }

    function showFilePrompt() {
        setState("loading");
        html.dataset.lmWait = "file";
        ui.showFile();
    }

    async function handleFile(file) {
        if (closed || state === "countdown" || state === "playing") return;
        kind = "file";
        const my = ++gen;
        if (download) download.abort();
        download = null;
        stopGame();
        setState("loading");
        if (file.size > MAX_FILE_BYTES) return fail(ERR.TOO_BIG);
        ui.showLoading(t("loading.file"));
        let bytes;
        try {
            bytes = new Uint8Array(await file.arrayBuffer());
        } catch {
            if (my === gen) fail(ERR.NOT_ZIP);
            return;
        }
        if (my !== gen) return;
        await fromOsz(bytes, my, t("ready.file", { name: file.name }));
    }

    async function fromOsz(bytes, my, label) {
        ui.showLoading(t("loading.unzip"));
        const read = await readOszMaps(bytes, { readZip, md5Hex });
        if (my !== gen) return;
        if (!read.ok) return fail(read.code);
        const choice = chooseOsu(read.maps, { map: params.map, checksum: params.checksum });
        if (choice.pick) return useMap(choice.pick, read.entries, my, label);
        if (choice.choices) {
            html.dataset.lmWait = "choose";
            ui.showChoices(choice.choices, (m) => useMap(m, read.entries, my, label));
            return;
        }
        return fail("no-chart");
    }

    async function useMap(m, entries, my, label) {
        if (my !== gen) return;
        delete html.dataset.lmWait;
        ui.setMap(m.chart);
        const reason = unplayableReason(m.chart);
        if (reason) return fail(reason);
        const sound = await readAudio(entries, m.chart);
        if (my !== gen) return;
        if (!sound.ok) return fail(sound.code, { name: sound.name });
        const buffer = await decode(sound.bytes, my);
        if (!buffer) return;
        loaded = { chart: m.chart, notes: m.chart.notes, buffer, audioZeroChartMs: 0, previewStartMs: null, endChartMs: null, label };
        toReady();
    }

    // ---- ready / play ----
    function readyLines() {
        const c = loaded.chart;
        return [
            loaded.label,
            t("ready.rate", { rate: formatRate(settings.rate) }),
            `${t("ready.notes", { n: loaded.notes.length })} · OD ${c.od}`,
            t("ready.keys", { keys: settings.keys.map(keyLabel).join(" ") }),
            loaded.notes.some((n) => n.end !== null) ? t("ready.lnNote") : null,
        ];
    }

    function toReady() {
        stopGame();
        setState("ready");
        renderer.reset();
        ui.showReady({ lines: readyLines(), warn: kind === "preview" && params.previewWarn ? t("previewWarn") : null, onStart: start });
        publishStats();
        drawIdle();
    }

    function drawIdle() {
        if (!loaded) return renderer.clear();
        const rate = settings.rate;
        const startChartMs = startChartFor({ firstNoteMs: loaded.notes[0]?.t ?? 0, previewStartMs: loaded.previewStartMs, rate });
        renderer.reset();
        renderer.draw({
            now: startChartMs, rate, speed: settings.speed, downscroll: settings.downscroll, keys: 4,
            judge: createJudge({ notes: loaded.notes, od: loaded.chart.od, rate }), held, labels: settings.keys.map(keyLabel),
            combo: 0, acc: null, progress: 0, perfNow: perf.now(), sideLines: sideLines(),
        });
        renderer.reset();
    }

    function sideLines() {
        return [t("side.rate", { rate: formatRate(settings.rate) }), t("side.od", { od: loaded?.chart.od ?? "?" }), t("side.offset", { ms: settings.offsetMs })];
    }

    async function start() {
        if (closed || !loaded || (state !== "ready" && state !== "results" && state !== "paused")) return;
        if (!audio) return fail("no-audio-api");
        stopGame();
        const my = ++startToken;
        ui.setSettingsOpen(false);
        setState("countdown");
        ui.hideScreen();
        const unlocking = audio.unlock(); // inside the gesture
        try {
            await unlocking;
        } catch { /* the clock still runs on ctx time; a muted start is better than none */ }
        // a blur during the unlock sent us back to ready and the user started again: that later start builds the game
        if (my !== startToken || state !== "countdown" || closed || game) return;
        const rate = settings.rate;
        const notes = loaded.notes;
        const judge = createJudge({ notes, od: loaded.chart.od, rate });
        const span = noteSpan(notes);
        const startChartMs = startChartFor({ firstNoteMs: span.first, previewStartMs: loaded.previewStartMs, rate });
        const anchorMs = startChartMs + LEAD_IN_MS * rate;
        const plan = planStart({ ctxNow: audio.ctx.currentTime, startChartMs, audioZeroChartMs: loaded.audioZeroChartMs, rate });
        const clock = createClock({ startAt: plan.startAt, startChartMs, rate, offsetMs: settings.offsetMs });
        const endChartMs = loaded.endChartMs ?? span.last + END_PAD_MS * rate;
        game = { judge, clock, startChartMs, anchorMs, endChartMs, flash: null, toast: null };
        renderer.reset();
        audio.play(loaded.buffer, { when: plan.when, bufferOffset: plan.bufferOffset, rate });
        publishStats();
        loop();
    }

    function stopGame() {
        if (frameId) win.cancelAnimationFrame?.(frameId);
        frameId = 0;
        input?.releaseAll();
        audio?.stop();
        game = null;
    }

    function chartNow(instantMs) {
        return game.clock.chartAtInstant(audio.ctx, instantMs, perf.now());
    }

    function onEvents(events) {
        if (!events.length) return;
        const last = events[events.length - 1];
        game.flash = { judgement: last.judgement, at: perf.now() };
        publishStats();
    }

    function loop() {
        if (!frameId) frameId = win.requestAnimationFrame(tick);
    }

    function tick() {
        frameId = 0;
        if (!game || (state !== "countdown" && state !== "playing")) return;
        const perfNow = perf.now();
        const now = chartNow(perfNow);
        onEvents(game.judge.update(now));
        if (state === "countdown" && now >= game.anchorMs) setState("playing");
        if (now >= game.endChartMs) {
            onEvents(game.judge.finish(now));
            return toResults();
        }
        draw(now, perfNow);
        loop();
    }

    function draw(now, perfNow) {
        const stats = game.judge.stats();
        renderer.draw({
            now, rate: game.clock.rate, speed: settings.speed, downscroll: settings.downscroll, keys: 4, judge: game.judge,
            held, labels: settings.keys.map(keyLabel), combo: stats.combo, acc: stats.acc,
            progress: (now - game.startChartMs) / Math.max(1, game.endChartMs - game.startChartMs),
            flash: game.flash, toast: game.toast, perfNow, sideLines: sideLines(),
            banner: state === "countdown" && now < game.anchorMs - 200 * game.clock.rate ? t("countdown") : null,
        });
    }

    function toResults() {
        const judge = game.judge;
        const stats = judge.stats();
        const mean = judge.meanError();
        const enough = judge.errors().length >= 10 && mean !== null && Math.abs(mean) >= 3;
        audio.stop();
        if (frameId) win.cancelAnimationFrame?.(frameId);
        frameId = 0;
        setState("results");
        html.dataset.lmStats = JSON.stringify(stats);
        ui.showResults({
            stats, ur: judge.ur(), meanError: mean,
            offsetTip: enough ? Math.max(-300, Math.min(300, Math.round(settings.offsetMs - mean))) : null,
            onAgain: start,
        });
    }

    async function pause() {
        if (state !== "countdown" && state !== "playing") return;
        // Left while start() still waits for the audio unlock: there is no game to pause yet, so back to the ready screen.
        if (!game) return toReady();
        input.releaseAll();
        if (frameId) win.cancelAnimationFrame?.(frameId);
        frameId = 0;
        setState("paused");
        ui.showPause({ onResume: resume });
        try { await audio.pause(); } catch { /* already suspended */ }
    }

    let resuming = false;
    async function resume() {
        if (state !== "paused" || !game || resuming) return;
        resuming = true;
        ui.hideScreen();
        try { await audio.resume(); } catch { /* keep going on ctx time */ }
        resuming = false;
        if (state !== "paused" || !game) return;
        setState(chartNow(perf.now()) < game.anchorMs ? "countdown" : "playing");
        loop();
    }

    function close() {
        if (closed) return;
        stopGame();
        if (download) download.abort();
        closed = true;
        input.detach();
        audio?.close?.();
        try {
            win.parent?.postMessage({ source: PLAYER_SOURCE, type: "close" }, SITE_ORIGIN);
        } catch { /* no parent */ }
    }

    function nudgeOffset(delta) {
        settings = clampSettings({ ...settings, offsetMs: settings.offsetMs + delta });
        saveSettings(storage, settings);
        if (game) {
            game.clock.offsetMs = settings.offsetMs;
            game.toast = { text: t("toast.offset", { ms: settings.offsetMs }), at: perf.now() };
        }
        if (state === "ready") ui.showReady({ lines: readyLines(), warn: kind === "preview" && params.previewWarn ? t("previewWarn") : null, onStart: start });
        if (ui.settingsOpen) renderSettings();
    }

    // ---- input ----
    const input = createInput({
        target: win,
        doc,
        keys: settings.keys,
        onLaneDown(col, event) {
            held[col] = true;
            if (game && (state === "countdown" || state === "playing")) onEvents(game.judge.press(col, chartNow(event.timeStamp)));
        },
        onLaneUp(col, event) {
            held[col] = false;
            if (game && (state === "countdown" || state === "playing")) onEvents(game.judge.release(col, chartNow(event?.timeStamp ?? perf.now())));
        },
        onKey(event) {
            const code = event.code;
            if (code === "Escape") {
                event.preventDefault?.();
                return close();
            }
            if (code === "Space" || code === "Enter" || code === "NumpadEnter") {
                if (event.target?.tagName === "BUTTON" && code !== "Space" && state !== "playing") return; // the button's own click
                event.preventDefault?.();
                if (event.repeat) return;
                if (state === "ready" || (state === "results" && code === "Space")) return start();
                if (state === "paused") return resume();
                if ((state === "playing" || state === "countdown") && code === "Space") return pause();
                return;
            }
            if (code === "KeyR" && !event.repeat && (state === "results" || state === "paused")) return start();
            const delta = offsetNudge(event);
            if (delta && state !== "loading" && state !== "error") {
                event.preventDefault?.();
                nudgeOffset(delta);
            }
        },
        onLeave() {
            if (state === "countdown" || state === "playing") pause();
        },
    });

    // ---- settings panel ----
    function renderSettings() {
        ui.renderSettings({ settings, source: kind, locked: state === "paused", rebinding }, {
            change: (patch) => applySettings(patch),
            source: (k) => switchSource(k),
            rebind: () => beginRebind(),
            close: () => {
                cancelRebind();
                ui.setSettingsOpen(false);
            },
        });
    }

    function applySettings(patch) {
        const before = settings;
        settings = clampSettings({ ...settings, ...patch });
        saveSettings(storage, settings);
        audio?.setVolume(settings.volume);
        if (game) game.clock.offsetMs = settings.offsetMs;
        if (state === "ready" && (before.rate !== settings.rate || before.speed !== settings.speed || before.downscroll !== settings.downscroll)) toReadyKeepPanel();
        renderSettings();
    }

    function toReadyKeepPanel() {
        const open = ui.settingsOpen;
        toReady();
        ui.setSettingsOpen(open);
    }

    function switchSource(k) {
        if (state === "countdown" || state === "playing") return;
        if (k === kind && state !== "error") return;
        load(k);
        if (ui.settingsOpen) renderSettings();
    }

    // An unfinished rebind must not outlive the panel: it would keep eating the lane keys, Space and Esc.
    function cancelRebind() {
        if (!rebinding) return;
        rebinding = null;
        input.setCapture(null);
    }

    function beginRebind() {
        const rebinder = createRebinder(4);
        rebinding = { index: 0, keys: [], problem: null };
        input.setCapture((event) => {
            if (event.code === "Escape") {
                rebinding = null;
                input.setCapture(null);
                return renderSettings();
            }
            const r = rebinder.feed(event.code);
            if (r.status === "refused" || r.status === "duplicate") rebinding = { index: rebinder.index, keys: r.keys, problem: r.status };
            else if (r.status === "next") rebinding = { index: rebinder.index, keys: r.keys, problem: null };
            else {
                rebinding = null;
                input.setCapture(null);
                settings = clampSettings({ ...settings, keys: r.keys });
                saveSettings(storage, settings);
                input.setKeys(settings.keys);
                if (state === "ready") toReadyKeepPanel();
            }
            renderSettings();
        });
        renderSettings();
    }

    ui.settingsButton.addEventListener("click", () => {
        const open = !ui.settingsOpen;
        if (open) renderSettings();
        else cancelRebind();
        ui.setSettingsOpen(open);
    });
    ui.closeButton.addEventListener("click", close);
    ui.onFile(handleFile);

    // drop an .osz anywhere
    const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
    doc.addEventListener("dragover", (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        if (state !== "countdown" && state !== "playing") ui.showDrop(true);
    });
    doc.addEventListener("dragleave", (event) => {
        if (!event.relatedTarget) ui.showDrop(false);
    });
    doc.addEventListener("drop", (event) => {
        event.preventDefault();
        ui.showDrop(false);
        const file = event.dataTransfer?.files?.[0];
        if (file) handleFile(file);
    });
    win.addEventListener("resize", () => {
        if (state !== "countdown" && state !== "playing" && state !== "paused") drawIdle();
    });

    publishStats();
    renderer.clear();
    load(kind);
    win.focus?.();

    return {
        get state() { return state; },
        get settings() { return settings; },
        get game() { return game; },
        get loaded() { return loaded; },
        start, pause, resume, close, handleFile, startDownload, switchSource,
    };
}

export const countJudgements = (notes) => notes.reduce((s, n) => s + (n.end === null ? 1 : 2), 0);

// Browser entry: the real client, zip reader and storage of the extension.
export async function startPlayer(win = globalThis.window) {
    const doc = win.document;
    const params = parseParams(win.location.hash, win.navigator?.language);
    try {
        const [client, osz, md5] = await Promise.all([
            import("../shared/client.js"),
            import("../shared/osz.js"),
            import("../shared/md5.js").catch(() => ({ md5Hex: null })),
        ]);
        const storage = globalThis.chrome?.storage?.local ?? null;
        return await boot({ params, client, readZip: osz.readZip, md5Hex: md5.md5Hex ?? null, storage, win, doc });
    } catch (error) {
        doc.documentElement.dataset.lmPlayer = "error";
        doc.documentElement.dataset.lmError = "context";
        const box = doc.getElementById("lm-player") ?? doc.body;
        const p = doc.createElement("p");
        p.className = "lm-fatal";
        p.textContent = makeT(STRINGS, params.lang)("err.context");
        box.replaceChildren(p);
        console.error("Lunacy mania player could not start", error);
        return null;
    }
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.getElementById?.("lm-player")) startPlayer(window);
