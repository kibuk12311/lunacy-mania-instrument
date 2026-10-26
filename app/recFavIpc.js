// Main-process side of the favourites: the list in userData/favourites.json and its export as an osu!stable
// collection.db into Documents/<app>/коллекции, never into the osu! folder. Dependencies are injected; nothing throws.
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { cleanFavourite } from "../src/recommend/favourites.js";
import { encodeCollectionDb, COLLECTION_DB_VERSION } from "../src/recommend/collectionDb.js";
import { t } from "../src/i18n/i18n.js";
import { positiveId } from "./validate.js";

export const DEFAULT_COLLECTION_NAME = "Lunacy mania picks";
export const EXPORT_CONCURRENCY = 3;
const MAX_NAME = 64;

// The one folder an export writes to.
export const collectionsDir = (docsDir) => path.join(docsDir, "коллекции");

// What the window typed → the collection's name: no control characters, trimmed, at most 64; empty → the default.
export function collectionName(name) {
    const clean = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME).trim() : "";
    return clean || DEFAULT_COLLECTION_NAME;
}

const fail = (error) => ({ ok: false, message: error?.message || t("app.rec.unknownError") });
const md5Of = (bytes) => createHash("md5").update(bytes).digest("hex");

// fn over every item, at most `limit` at a time.
async function pool(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await fn(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// store: app/recStore.js; fetchBytes(url) → Buffer of an .osu; docsDir() → the app's documents folder;
// cardFor(id) → the card main handed out; onAdded(entry) and onExported(file) tell the picks handlers.
export function createFavHandlers({
    store, fetchBytes, docsDir, fs = nodeFs, log = () => {}, progress = () => {}, cardFor = () => null,
    onAdded = () => {}, onExported = () => {}, concurrency = EXPORT_CONCURRENCY,
}) {
    async function list() {
        try {
            return { ok: true, items: await store.favourites.list() };
        } catch (error) {
            return fail(error);
        }
    }

    async function add(req) {
        const id = positiveId(req?.card?.beatmapId);
        // the card main handed out is trusted over the copy the window sends back
        const card = (id && cardFor(id)) || req?.card;
        const entry = cleanFavourite(card);
        if (!id || !entry || entry.beatmapId !== id) return { ok: false, message: t("app.rec.noMapData") };
        try {
            const items = await store.favourites.add(entry);
            log(`rec fav add ${id}`);
            try {
                onAdded(entry);
            } catch (error) {
                log(`rec fav add ${id} journal failed: ${error?.message}`);
            }
            return { ok: true, items };
        } catch (error) {
            log(`rec fav add ${id} failed: ${error?.message}`);
            return fail(error);
        }
    }

    async function remove(req) {
        const id = positiveId(req?.beatmapId);
        if (!id) return { ok: false, message: t("app.rec.noMapData") };
        try {
            return { ok: true, items: await store.favourites.remove(id) };
        } catch (error) {
            return fail(error);
        }
    }

    // The MD5 of an .osu, or null when osu.ppy.sh has no file (it answers an empty 200 for a deleted map).
    async function hashOf(beatmapId) {
        try {
            const bytes = await fetchBytes(`https://osu.ppy.sh/osu/${beatmapId}`);
            if (!Buffer.isBuffer(bytes) || !bytes.includes("[HitObjects]")) throw new Error(t("app.rec.noOsuFile"));
            return md5Of(bytes);
        } catch (error) {
            log(`rec fav export ${beatmapId} skipped: ${error?.message}`);
            return null;
        }
    }

    async function run(name) {
        try {
            const items = await store.favourites.list();
            if (!items.length) return { ok: false, message: t("recommend.err.favEmpty") };
            const missing = items.filter((f) => !f.md5);
            const total = items.length;
            let done = total - missing.length;
            progress({ done, total });
            const found = new Map();
            await pool(missing, concurrency, async (f) => {
                const md5 = await hashOf(f.beatmapId);
                if (md5) found.set(f.beatmapId, md5);
                done += 1;
                progress({ done, total });
            });
            if (found.size) await store.favourites.setMd5(found);
            const known = items.filter((f) => f.md5 || found.has(f.beatmapId));
            const hashes = [...new Set(known.map((f) => f.md5 ?? found.get(f.beatmapId)))];
            const skipped = items.length - known.length;
            if (!hashes.length) return { ok: false, message: t("recommend.err.exportNone") };

            const dir = collectionsDir(docsDir());
            const file = path.join(dir, "collection.db");
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(`${file}.tmp`, encodeCollectionDb({ version: COLLECTION_DB_VERSION, collections: [{ name, hashes }] }));
            await fs.rename(`${file}.tmp`, file);
            onExported(file);
            log(`rec fav export "${name}" ${hashes.length} maps, ${skipped} skipped → ${file}`);
            return { ok: true, file, count: hashes.length, skipped };
        } catch (error) {
            log(`rec fav export failed: ${error?.message}`);
            return fail(error);
        }
    }

    // one export at a time: a second ask while one runs gets the same answer
    let exporting = null;
    function exportDb(req) {
        exporting ??= run(collectionName(req?.name)).finally(() => { exporting = null; });
        return exporting;
    }

    return { list, add, remove, exportDb };
}
