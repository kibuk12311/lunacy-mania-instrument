// The user's 👍/👎 on generated variants (wave 3, docs/2026-10-25-mapgen-v3-ml-addendum.md §2.7):
// userData/ratings.json through createJsonStore. At most MAX_RATINGS entries, the newest kept; normalize drops bad
// ones. No audio and no chart text: an entry holds the vote, its tags, what the map was asked for and the critic's
// feature vector, and a short hash of the song's path.
//
// On disk: { v: 1, nameSets: string[][], entries: Entry[], model: PersonalModel | null }
//   Entry = { id, at, vote: 1 | -1, tags, version, range, families, modelKind, criticKind, features, names, audioKey }
//   where `names` is an index into nameSets (the critic's feature names, kept once instead of in every entry; -1 when
//   the entry has no features). Read back, every entry's `names` is that list itself (one shared array per list), so
//   2000 entries cost one copy of the names when they go to the worker.
// `model` is the last personal model the worker fitted (src/gen/personal.js), so a new session starts with it.
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { createJsonStore } from "./jsonStore.js";
import { RATING_TAGS } from "../src/gen/personal.js";

export const MAX_RATINGS = 2000;
export const RATINGS_FILE = "ratings.json";
const MAX_TAGS = 4;
const MAX_ID = 64;
const MAX_TEXT = 200;
const MAX_FAMILIES = 8;
const MAX_FEATURES = 1024;
const MAX_EXPORT_TRIES = 100;
const EMPTY = Object.freeze({ v: 1, nameSets: [], entries: [], model: null });

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const text = (v) => (typeof v === "string" ? v.slice(0, MAX_TEXT) : "");
const kind = (v) => (typeof v === "string" && v ? v.slice(0, 32) : null);
// 5 significant digits are plenty for a logistic regression, and keep the file small
const compact = (x) => (isNum(x) ? Number(x.toPrecision(5)) : null);

function cleanTags(tags) {
    if (!Array.isArray(tags)) return null;
    const out = [...new Set(tags)];
    return out.length <= MAX_TAGS && out.every((t) => RATING_TAGS.includes(t)) ? out : null;
}

// One stored entry, or null when it is not one. `names` is checked against the name sets given.
function cleanEntry(e, nameSets) {
    if (!isObject(e)) return null;
    if (typeof e.id !== "string" || !e.id || e.id.length > MAX_ID) return null;
    if (!isNum(e.at) || (e.vote !== 1 && e.vote !== -1)) return null;
    const tags = cleanTags(e.tags ?? []);
    if (!tags) return null;
    let features = [];
    let names = -1;
    if (Array.isArray(e.features) && e.features.length && e.features.length <= MAX_FEATURES
        && Number.isInteger(e.names) && nameSets[e.names]?.length === e.features.length
        && e.features.every((x) => x === null || isNum(x))) {
        features = e.features.map(compact);
        names = e.names;
    }
    const range = isObject(e.range) && isNum(e.range.lo) && isNum(e.range.hi) ? { lo: e.range.lo, hi: e.range.hi } : null;
    const families = Array.isArray(e.families) ? e.families.filter((f) => typeof f === "string" && f).slice(0, MAX_FAMILIES).map((f) => f.slice(0, 32)) : [];
    const audioKey = typeof e.audioKey === "string" && /^[0-9a-f]{12}$/.test(e.audioKey) ? e.audioKey : "";
    return { id: e.id, at: e.at, vote: e.vote, tags, version: text(e.version), range, families, modelKind: kind(e.modelKind), criticKind: kind(e.criticKind), features, names, audioKey };
}

// The stored value, cleaned: bad entries dropped, one entry per id (the newest), the newest MAX_RATINGS kept, oldest
// first; name sets no entry uses are dropped.
export function normalizeRatings(raw) {
    if (!isObject(raw)) return structuredClone(EMPTY);
    const sets = Array.isArray(raw.nameSets) ? raw.nameSets.map((s) => (Array.isArray(s) && s.length && s.every((n) => typeof n === "string") ? s : null)) : [];
    const byId = new Map();
    for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
        const clean = cleanEntry(e, sets.map((s) => s ?? []));
        if (clean && (!byId.has(clean.id) || byId.get(clean.id).at <= clean.at)) byId.set(clean.id, clean);
    }
    const entries = [...byId.values()].sort((a, b) => a.at - b.at).slice(-MAX_RATINGS);
    const used = new Map(); // old index → new index
    const nameSets = [];
    for (const e of entries) {
        if (e.names < 0) continue;
        if (!used.has(e.names)) {
            used.set(e.names, nameSets.length);
            nameSets.push([...sets[e.names]]);
        }
        e.names = used.get(e.names);
    }
    const model = isObject(raw.model) && raw.model.v === 1 && Array.isArray(raw.model.w) ? raw.model : null;
    return { v: 1, nameSets, entries, model };
}

// The index of `names` in nameSets, added when new.
function nameIndex(nameSets, names) {
    const key = names.join("\n");
    const found = nameSets.findIndex((s) => s.length === names.length && s.join("\n") === key);
    if (found >= 0) return found;
    nameSets.push([...names]);
    return nameSets.length - 1;
}

const counts = (entries) => {
    const up = entries.filter((e) => e.vote === 1).length;
    return { n: entries.length, up, down: entries.length - up };
};

// The day as YYYY-MM-DD in local time.
const dayOf = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function createRatingsStore({ file, fs = nodeFs }) {
    const store = createJsonStore({ file, normalize: normalizeRatings, fallback: EMPTY, fs });
    // every entry with its names as a list (one shared array per name set)
    const expand = (value) => value.entries.map((e) => ({ ...e, names: e.names >= 0 ? value.nameSets[e.names] : [] }));
    return {
        // entry: an Entry with `names` as a list of strings (or [] without features) → the number of ratings after
        async put(entry) {
            const value = await store.update((v) => {
                const names = Array.isArray(entry.names) && entry.names.length && entry.features?.length === entry.names.length
                    ? nameIndex(v.nameSets, entry.names) : -1;
                const kept = v.entries.filter((e) => e.id !== entry.id);
                kept.push({ ...entry, names, features: names >= 0 ? entry.features : [] });
                return { ...v, entries: kept };
            });
            return value.entries.length;
        },
        // → the number of ratings after
        async remove(id) {
            const value = await store.update((v) => ({ ...v, entries: v.entries.filter((e) => e.id !== id) }));
            return value.entries.length;
        },
        async find(id) {
            const value = await store.get();
            const e = value.entries.find((x) => x.id === id);
            return e ? { ...e, names: e.names >= 0 ? value.nameSets[e.names] : [] } : null;
        },
        entries: async () => expand(await store.get()),
        summary: async () => counts((await store.get()).entries),
        model: async () => (await store.get()).model,
        setModel: (model) => store.update((v) => ({ ...v, model: model ?? null })),
        // A new JSON file in `dir` (never one that is there already) → its path, or null when there is nothing.
        async exportTo(dir, { now = Date.now(), app = "" } = {}) {
            const value = await store.get();
            if (!value.entries.length) return null;
            const body = JSON.stringify({
                kind: "lunacy-ratings", v: 1, app, exportedAt: new Date(now).toISOString(),
                ...counts(value.entries), nameSets: value.nameSets, entries: value.entries,
            }, null, 1);
            await fs.mkdir(dir, { recursive: true });
            const base = `lunacy-ratings-${dayOf(now)}`;
            for (let k = 1; k <= MAX_EXPORT_TRIES; k += 1) {
                const target = path.join(dir, k === 1 ? `${base}.json` : `${base}-${k}.json`);
                let handle = null;
                try {
                    handle = await fs.open(target, "wx");
                } catch (error) {
                    if (error?.code === "EEXIST") continue;
                    throw error;
                }
                try {
                    await handle.writeFile(body, "utf8");
                } finally {
                    await handle.close();
                }
                return target;
            }
            throw new Error(`${base}: ${MAX_EXPORT_TRIES} files already`);
        },
    };
}
