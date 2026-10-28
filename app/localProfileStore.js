// The local profile on disk, all in userData\local-profile (nothing leaves the machine):
//   plays.jsonl   — one play per line, appended as they come (the source of truth: the skill is worked out from it);
//   maps.json     — the analysis summary of each map at each rate a play was on ("md5@1.10"), so a map is analysed once,
//                   with whether it is vibro at that rate beside it (src/vibro/detect.js, not part of the analysis);
//   settings.json — { record, osuFolder, imports: { stable, interlude, lazer } }.
// A play is the same play when its id matches or when md5, rate and every judgement do (the live recording and a
// later scores.db import, a replay of one's own score): it is kept once. Export is one JSON file with all three.
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { vibroSummary } from "../src/vibro/detect.js";

export const BUNDLE_FORMAT = "lunacy-mania-local-profile";
export const BUNDLE_VERSION = 1;
const OUTCOMES = ["pass", "fail", "quit"];
const CLIENTS = ["stable", "lazer", "interlude"];
const SOURCES = ["live", "stable-db", "interlude-db", "lazer-db", "import"];
const MAP_KINDS = ["ok", "not-rice", "too-short", "error"];
export const DEFAULT_SETTINGS = Object.freeze({ record: true, osuFolder: null, imports: {} });

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const text = (x, max = 200) => (typeof x === "string" ? x.slice(0, max) : "");
const idOf = (x) => (Number.isSafeInteger(x) && x > 0 ? x : null);
const md5Of = (x) => (typeof x === "string" && /^[0-9a-f]{32}$/i.test(x) ? x.toLowerCase() : null);
export const rateKey = (rate) => (Math.round(rate * 100) / 100).toFixed(2);
export const mapKeyOf = (md5, rate) => `${md5}@${rateKey(rate)}`;

function cleanHits(h) {
    if (!h || typeof h !== "object") return null;
    const out = {};
    for (const k of ["max", "n300", "n200", "n100", "n50", "miss"]) {
        const v = Number(h[k]);
        out[k] = Number.isInteger(v) && v >= 0 && v < 1e6 ? v : 0;
    }
    return out;
}

// Anything (a new play, a line of plays.jsonl, an imported file) → a play the store keeps, or null.
export function normalizePlay(x) {
    if (!x || typeof x !== "object") return null;
    const md5 = md5Of(x.md5);
    const rate = finite(x.rate);
    const at = finite(x.at);
    if (!md5 || rate === null || !(rate >= 0.25 && rate <= 4) || at === null || at <= 0) return null;
    if (typeof x.id !== "string" || !x.id || x.id.length > 200) return null;
    const accuracy = finite(x.accuracy);
    return {
        id: x.id,
        source: SOURCES.includes(x.source) ? x.source : "import",
        client: CLIENTS.includes(x.client) ? x.client : null,
        md5,
        rate: Math.round(rate * 100) / 100,
        mapKey: mapKeyOf(md5, rate),
        beatmapId: idOf(x.beatmapId),
        beatmapsetId: idOf(x.beatmapsetId),
        artist: text(x.artist),
        title: text(x.title),
        version: text(x.version),
        mods: Array.isArray(x.mods) ? x.mods.filter((m) => typeof m === "string" && /^[A-Z0-9]{1,4}$/.test(m)).slice(0, 20) : [],
        hits: cleanHits(x.hits),
        accuracy: accuracy !== null && accuracy >= 0 && accuracy <= 1 ? accuracy : null,
        maxCombo: Number.isInteger(x.maxCombo) && x.maxCombo >= 0 ? x.maxCombo : null,
        outcome: OUTCOMES.includes(x.outcome) ? x.outcome : "pass",
        at,
    };
}

// An analysis result (src/core/analyze.js) → what is kept of it: the dans, the pattern shares, the length; and, set
// beside it by the service (never part of the analysis), whether the map is vibro at that rate (src/vibro/detect.js
// vibroSummary), so the model can leave its plays out of the dans.
export function mapSummary(result) {
    if (!result || !MAP_KINDS.includes(result.kind)) return null;
    if (result.kind !== "ok") return { kind: result.kind };
    const calcs = {};
    for (const [k, v] of Object.entries(result.calcs ?? {})) if (finite(v) !== null) calcs[k] = v;
    const msd = {};
    for (const [k, v] of Object.entries(result.msd ?? {})) if (finite(v) !== null) msd[k] = v;
    const vibro = vibroSummary(result.vibro);
    return {
        kind: "ok",
        numeric: finite(result.numeric),
        label: text(result.label, 40),
        calcs,
        msd,
        top3: (Array.isArray(result.top3) ? result.top3 : []).filter((p) => typeof p?.name === "string" && finite(p.share) !== null)
            .slice(0, 3).map((p) => ({ name: p.name.slice(0, 40), share: p.share })),
        tech: Boolean(result.tech),
        primary: typeof result.primary === "string" ? result.primary.slice(0, 40) : null,
        durationSec: finite(result.durationSec),
        ...(vibro ? { vibro } : {}),
    };
}

const normalizeMap = (x) => (x && typeof x === "object" && MAP_KINDS.includes(x.kind) ? (x.kind === "ok" ? mapSummary(x) : { kind: x.kind }) : null);

export function normalizeSettings(x) {
    const s = x && typeof x === "object" ? x : {};
    const imports = {};
    for (const [k, v] of Object.entries(s.imports && typeof s.imports === "object" ? s.imports : {})) {
        if (["stable", "interlude", "lazer"].includes(k) && v && typeof v === "object") {
            imports[k] = {
                at: finite(v.at), added: finite(v.added) ?? 0, total: finite(v.total) ?? 0, done: finite(v.done) ?? 0,
                finished: v.finished === true, player: typeof v.player === "string" ? v.player.slice(0, 64) : null,
            };
        }
    }
    return {
        record: s.record !== false,
        osuFolder: typeof s.osuFolder === "string" && s.osuFolder ? s.osuFolder : null,
        imports,
    };
}

// The same play, whatever recorded it: md5, rate and the judgements (none: only the id says).
export const signatureOf = (p) => (p.hits ? `${p.mapKey}|${["max", "n300", "n200", "n100", "n50", "miss"].map((k) => p.hits[k]).join(",")}` : null);

export function createLocalProfileStore({ dir, fs = nodeFs }) {
    const files = { plays: path.join(dir, "plays.jsonl"), maps: path.join(dir, "maps.json"), settings: path.join(dir, "settings.json") };
    let state = null; // { plays, ids, signatures, maps, settings }
    let loading = null;
    let queue = Promise.resolve();
    const serial = (fn) => {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
    };

    const readJson = (file, fallback) => fs.readFile(file, "utf8").then(JSON.parse).catch(() => fallback);

    async function writeAtomic(file, data) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(`${file}.tmp`, data, "utf8");
        await fs.rename(`${file}.tmp`, file);
    }

    function index(plays) {
        state.plays = [];
        state.ids = new Set();
        state.signatures = new Set();
        for (const p of plays) remember(p);
    }

    function known(p) {
        const sig = signatureOf(p);
        return state.ids.has(p.id) || (sig !== null && state.signatures.has(sig));
    }

    function remember(p) {
        if (known(p)) return false;
        state.plays.push(p);
        state.ids.add(p.id);
        const sig = signatureOf(p);
        if (sig) state.signatures.add(sig);
        return true;
    }

    function load() {
        loading ??= (async () => {
            const raw = await fs.readFile(files.plays, "utf8").catch(() => "");
            const plays = [];
            for (const line of raw.split(/\r?\n/)) {
                if (!line.trim()) continue;
                try {
                    const p = normalizePlay(JSON.parse(line));
                    if (p) plays.push(p);
                } catch {
                    // a half-written last line (the app closed mid-write) is skipped
                }
            }
            const maps = new Map();
            for (const [k, v] of Object.entries(await readJson(files.maps, {}) ?? {})) {
                const m = normalizeMap(v);
                if (m && typeof k === "string" && /^[0-9a-f]{32}@\d\.\d\d$/.test(k)) maps.set(k, m);
            }
            state = { maps, settings: normalizeSettings(await readJson(files.settings, null)) };
            index(plays);
            return state;
        })();
        return loading;
    }

    const saveMaps = () => writeAtomic(files.maps, JSON.stringify(Object.fromEntries(state.maps)));
    const savePlays = () => writeAtomic(files.plays, state.plays.map((p) => JSON.stringify(p)).join("\n") + (state.plays.length ? "\n" : ""));
    const saveSettings = () => writeAtomic(files.settings, JSON.stringify(state.settings));

    return {
        load,
        plays: async () => (await load()).plays,
        has: async (play) => {
            await load();
            const p = normalizePlay(play);
            return p ? known(p) : false;
        },
        // → { added, play } (added false: the same play is already there, or it is no play)
        addPlay: (play) => serial(async () => {
            await load();
            const p = normalizePlay(play);
            if (!p || !remember(p)) return { added: false, play: p };
            await fs.mkdir(dir, { recursive: true });
            await fs.appendFile(files.plays, `${JSON.stringify(p)}\n`, "utf8");
            return { added: true, play: p };
        }),
        map: async (key) => (await load()).maps.get(key) ?? null,
        mapsNow: () => state?.maps ?? new Map(),
        setMap: (key, summary) => serial(async () => {
            await load();
            const m = normalizeMap(summary);
            if (!m) return;
            state.maps.set(key, m);
            await saveMaps();
        }),
        settings: async () => structuredClone((await load()).settings),
        updateSettings: (fn) => serial(async () => {
            await load();
            state.settings = normalizeSettings(fn(structuredClone(state.settings)));
            await saveSettings();
            return structuredClone(state.settings);
        }),
        exportBundle: async () => {
            const s = await load();
            return {
                format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(),
                plays: s.plays, maps: Object.fromEntries(s.maps), settings: { record: s.settings.record },
            };
        },
        // a backup file's contents → { ok, added, skipped } (merged: plays already here are kept once)
        importBundle: (bundle) => serial(async () => {
            await load();
            if (bundle?.format !== BUNDLE_FORMAT || !Array.isArray(bundle.plays)) return { ok: false, added: 0, skipped: 0 };
            let added = 0;
            let skipped = 0;
            for (const raw of bundle.plays) {
                const p = normalizePlay(raw);
                if (p && remember(p)) added += 1;
                else skipped += 1;
            }
            for (const [k, v] of Object.entries(bundle.maps && typeof bundle.maps === "object" ? bundle.maps : {})) {
                const m = normalizeMap(v);
                if (!m || !/^[0-9a-f]{32}@\d\.\d\d$/.test(k)) continue;
                const ours = state.maps.get(k);
                if (!ours) state.maps.set(k, m);
                // the backup knows whether the map is vibro and this profile does not yet: that answer is taken
                else if (ours.kind === "ok" && m.kind === "ok" && !ours.vibro && m.vibro) state.maps.set(k, { ...ours, vibro: m.vibro });
            }
            state.plays.sort((a, b) => a.at - b.at);
            await savePlays();
            await saveMaps();
            return { ok: true, added, skipped };
        }),
        // every play and map gone; the record switch and the osu! folder stay
        reset: () => serial(async () => {
            await load();
            index([]);
            state.maps = new Map();
            state.settings = normalizeSettings({ ...state.settings, imports: {} });
            await savePlays();
            await saveMaps();
            await saveSettings();
        }),
    };
}
