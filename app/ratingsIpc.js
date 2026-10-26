// Ratings of generated variants (wave 3, docs/2026-10-25-mapgen-v3-ml-addendum.md §2.7): rate-variant,
// ratings-summary and ratings-export, registered from registerCreateIpc (main.js stays frozen).
// - The store is userData/ratings.json (app/ratingsStore.js), made on the first handler call, never while
//   registering: registering does no I/O and touches no dep but ipcMain.
// - A rating copies what the generated store knows about the variant (its critic feature vector, the version, range,
//   engine) and a short hash of the song's path; no audio and no chart text.
// - The personal model is never fitted here: 2 s after the last rating main sends the stored votes to the generator
//   worker as a "fit-personal" job (deps.generatorClient.fitPersonal) and keeps the model it answers, also in the
//   store, so the next session starts with it. personal() hands generate-map the active model, or null.
// - The export writes a new JSON file into docsDir (never over an old one), for the user to send by hand.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { t } from "../src/i18n/i18n.js";
import { RATING_TAGS } from "../src/gen/personal.js";
import { createRatingsStore, RATINGS_FILE } from "./ratingsStore.js";

export { RATING_TAGS };
export const FIT_DEBOUNCE_MS = 2000;
const MAX_TAGS = 4;
const MAX_ID = 64;
const VOTES = [1, -1, 0];
const MAX_FAMILIES = 3;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// What is wrong with a rate-variant request, or null.
export function checkRating(raw) {
    if (!isObject(raw)) return "request";
    if (typeof raw.id !== "string" || !raw.id || raw.id.length > MAX_ID) return "id";
    if (!VOTES.includes(raw.vote)) return "vote";
    const tags = raw.tags ?? [];
    if (!Array.isArray(tags) || tags.length > MAX_TAGS || new Set(tags).size !== tags.length || !tags.every((x) => RATING_TAGS.includes(x))) return "tags";
    return null;
}

export const audioKeyOf = (audioPath) => createHash("sha1").update(String(audioPath ?? "")).digest("hex").slice(0, 12);

// The critic's feature names for a stored critic answer: its own, else CRITIC_FEATURES when the lengths agree.
async function featureNames(critic) {
    const features = critic?.features;
    if (!Array.isArray(features) || !features.length || !features.every((x) => x === null || isNum(x))) return null;
    if (Array.isArray(critic.names) && critic.names.length === features.length) return critic.names;
    const { CRITIC_FEATURES } = await import("../src/gen/criticFeatures.js");
    return CRITIC_FEATURES.length === features.length ? CRITIC_FEATURES : null;
}

// A rating entry from a generated store entry (app/generatedStore.js, put by createIpc's generate-map).
export async function entryFrom(id, stored, { vote, tags, at }) {
    const names = await featureNames(stored.critic);
    const families = (Array.isArray(stored.result?.top3) ? stored.result.top3 : []).map((p) => p?.name).filter((n) => typeof n === "string").slice(0, MAX_FAMILIES);
    return {
        id, at, vote, tags,
        version: typeof stored.version === "string" ? stored.version : "",
        range: isObject(stored.range) ? stored.range : null,
        families,
        modelKind: stored.engine ?? null,
        criticKind: stored.critic?.kind ?? null,
        features: names ? stored.critic.features : [],
        names: names ?? [],
        audioKey: audioKeyOf(stored.audioPath),
    };
}

async function appVersion() {
    try {
        return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version ?? "";
    } catch {
        return "";
    }
}

// → { personal(), idle() }: personal() is the cached active PersonalModel main adds to the generate-map payload
// (null when there is none, or it is not active); idle() settles once no fit is waiting or running (for tests).
// opts are for tests: the debounce, its timers and the clock.
export function registerRatingsIpc(deps, { debounceMs = FIT_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
    const { ipcMain } = deps;
    let store = null;
    let model = null; // the last model the worker fitted (or the store kept)
    let loading = null;
    let timer = null;
    let fitting = Promise.resolve();
    let pending = null; // { promise, resolve } while a fit waits for its timer

    const log = (line) => { try { deps.log?.(line); } catch { /* a log that went away */ } };
    const storeOf = () => {
        if (!store) {
            const dir = deps.paths?.userData;
            if (typeof dir !== "string" || !dir) throw new Error("no userData folder");
            store = createRatingsStore({ file: path.join(dir, RATINGS_FILE) });
        }
        return store;
    };
    // the store and the model it kept, once
    const ready = () => (loading ??= (async () => {
        const s = storeOf();
        model = (await s.model()) ?? null;
        return s;
    })().catch((error) => { loading = null; throw error; }));

    async function fitNow() {
        const s = await ready();
        const entries = (await s.entries()).filter((e) => e.features.length);
        const client = deps.generatorClient;
        if (!entries.length || typeof client?.fitPersonal !== "function") {
            model = null;
            await s.setModel(null);
            return;
        }
        const out = await client.fitPersonal({ entries: entries.map(({ vote, tags, features, names }) => ({ vote, tags, features, names })) });
        if (out?.kind !== "personal") {
            log(`personal fit failed: ${out?.message}`);
            return;
        }
        model = out.personal ?? null;
        await s.setModel(model);
        log(`personal fit: ${entries.length} votes, auc ${model?.looAuc ?? "—"}, ${model?.active ? "active" : "inactive"}`);
    }

    // one fit at a time, FIT_DEBOUNCE_MS after the last rating
    function scheduleFit() {
        if (timer !== null) clearTimer(timer);
        if (!pending) {
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            pending = { promise, resolve };
        }
        const mine = pending;
        timer = setTimer(() => {
            timer = null;
            pending = null;
            fitting = fitting.then(fitNow).catch((error) => log(`personal fit failed: ${error?.message}`));
            fitting.then(mine.resolve);
        }, debounceMs);
    }

    const badRating = (what) => ({ ok: false, code: "badRating", message: t("create.err.badRating", { what }) });
    const failed = (error) => ({ ok: false, code: "failed", message: t("create.err.badRating", { what: String(error?.message ?? error) }) });

    ipcMain.handle("rate-variant", async (_e, raw) => {
        const what = checkRating(raw);
        if (what) return badRating(what);
        try {
            const s = await ready();
            const tags = [...(raw.tags ?? [])];
            let n;
            if (raw.vote === 0) {
                n = await s.remove(raw.id);
            } else {
                const stored = deps.generatedStore?.get?.(raw.id) ?? null;
                const before = stored ? null : await s.find(raw.id);
                if (!stored && !before) return { ok: false, code: "unknownId", message: t("app.gen.unknownId") };
                const entry = stored
                    ? await entryFrom(raw.id, stored, { vote: raw.vote, tags, at: now() })
                    : { ...before, vote: raw.vote, tags, at: now() };
                n = await s.put(entry);
            }
            scheduleFit();
            return { ok: true, n };
        } catch (error) {
            log(`rating failed: ${error?.message}`);
            return failed(error);
        }
    });

    ipcMain.handle("ratings-summary", async () => {
        try {
            const s = await ready();
            const { n, up, down } = await s.summary();
            return { ok: true, n, up, down, active: Boolean(model?.active), auc: isNum(model?.looAuc) ? model.looAuc : null };
        } catch (error) {
            return { ok: false, message: String(error?.message ?? error) };
        }
    });

    ipcMain.handle("ratings-export", async () => {
        try {
            const s = await ready();
            const dir = deps.paths?.docsDir;
            if (typeof dir !== "string" || !dir) throw new Error("no documents folder");
            const file = await s.exportTo(dir, { now: now(), app: await appVersion() });
            if (!file) return { ok: false, code: "empty", message: t("create.ml.exportEmpty") };
            log(`ratings exported to ${file}`);
            return { ok: true, file };
        } catch (error) {
            return { ok: false, code: "failed", message: String(error?.message ?? error) };
        }
    });

    return {
        // the cached model when it is active; the first call reads the store (with the model it kept) in the background
        personal() {
            if (!loading && typeof deps.paths?.userData === "string") ready().catch(() => {});
            return model?.active ? model : null;
        },
        idle: async () => {
            await pending?.promise;
            await fitting;
        },
    };
}
