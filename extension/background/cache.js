// The background's cache (extension/DESIGN.md §5.3): IndexedDB "lunacy-mania" v1 with two stores,
//   osu      { beatmapId, md5, text, size, fetchedAt, usedAt }   at most 64 MB of .osu text, least recently used out
//   results  { key, result, savedAt, usedAt }                     at most 5000 results, least recently used out
// with a small memory LRU in front. Results are stored worded in English (background/relabel.js rewords them).
// The backend is injectable (memoryBackend() for tests); a failing backend leaves the memory layer working.
export const DB_NAME = "lunacy-mania";
export const DB_VERSION = 1;
export const STORES = Object.freeze({ OSU: "osu", RESULTS: "results" });
export const OSU_CAP_BYTES = 64 * 1024 * 1024;
export const RESULT_CAP = 5000;
// usedAt is written back at most this often per entry (a read should not rewrite a 1 MB .osu every time)
const TOUCH_EVERY_MS = 10 * 60 * 1000;

export class Lru {
    constructor(limit) {
        this.limit = limit;
        this.map = new Map();
    }
    get(key) {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }
    set(key, value) {
        this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    }
    delete(key) {
        this.map.delete(key);
    }
    clear() {
        this.map.clear();
    }
    get size() {
        return this.map.size;
    }
}

const KEY_PATH = { [STORES.OSU]: "beatmapId", [STORES.RESULTS]: "key" };

// The same interface as idbBackend, in memory (tests; also the fallback when IndexedDB is missing).
export function memoryBackend() {
    const stores = { [STORES.OSU]: new Map(), [STORES.RESULTS]: new Map() };
    const clone = (v) => (v === undefined ? undefined : structuredClone(v));
    return {
        stores,
        async get(store, key) {
            return clone(stores[store].get(key));
        },
        async put(store, value) {
            stores[store].set(value[KEY_PATH[store]], clone(value));
        },
        async delete(store, key) {
            stores[store].delete(key);
        },
        async clear(store) {
            stores[store].clear();
        },
        async meta(store) {
            return [...stores[store].values()].map((v) => ({ key: v[KEY_PATH[store]], size: v.size ?? 0, usedAt: v.usedAt ?? 0 }));
        },
    };
}

export function idbBackend(idb = globalThis.indexedDB, name = DB_NAME) {
    let opening = null;
    const open = () => {
        opening ??= new Promise((resolve, reject) => {
            const request = idb.open(name, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORES.OSU)) db.createObjectStore(STORES.OSU, { keyPath: KEY_PATH[STORES.OSU] });
                if (!db.objectStoreNames.contains(STORES.RESULTS)) db.createObjectStore(STORES.RESULTS, { keyPath: KEY_PATH[STORES.RESULTS] });
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => {
                    db.close();
                    opening = null;
                };
                db.onclose = () => {
                    opening = null;
                };
                resolve(db);
            };
            request.onerror = () => {
                opening = null;
                reject(request.error);
            };
            request.onblocked = () => {
                opening = null;
                reject(new Error("IndexedDB blocked"));
            };
        });
        return opening;
    };
    async function run(store, mode, act) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, mode);
            let out;
            act(tx.objectStore(store), (value) => {
                out = value;
            });
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
        });
    }
    const simple = (store, mode, call) => run(store, mode, (s, set) => {
        const request = call(s);
        request.onsuccess = () => set(request.result);
    });
    return {
        get: (store, key) => simple(store, "readonly", (s) => s.get(key)),
        put: (store, value) => simple(store, "readwrite", (s) => s.put(value)),
        delete: (store, key) => simple(store, "readwrite", (s) => s.delete(key)),
        clear: (store) => simple(store, "readwrite", (s) => s.clear()),
        meta: (store) => run(store, "readonly", (s, set) => {
            const out = [];
            set(out);
            const request = s.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                out.push({ key: cursor.primaryKey, size: cursor.value?.size ?? 0, usedAt: cursor.value?.usedAt ?? 0 });
                cursor.continue();
            };
        }),
    };
}

export function createCache({
    backend = memoryBackend(), osuCapBytes = OSU_CAP_BYTES, resultCap = RESULT_CAP,
    memOsu = 24, memResults = 600, now = () => Date.now(), onError = () => {},
} = {}) {
    const mem = { [STORES.OSU]: new Lru(memOsu), [STORES.RESULTS]: new Lru(memResults) };
    // key → { size, usedAt } of what the backend holds, read once per background lifetime
    const index = { [STORES.OSU]: null, [STORES.RESULTS]: null };
    let queue = Promise.resolve(); // trims run one after another

    const safely = async (what, fn, fallback) => {
        try {
            return await fn();
        } catch (error) {
            onError(what, error);
            return fallback;
        }
    };

    async function indexOf(store) {
        if (!index[store]) {
            const rows = await safely(`meta ${store}`, () => backend.meta(store), []);
            index[store] ??= new Map(rows.map((r) => [r.key, { size: r.size, usedAt: r.usedAt }]));
        }
        return index[store];
    }

    // Drops the least recently used entries until the store is within its cap (bytes for osu, count for results).
    function trim(store, keep) {
        queue = queue.then(async () => {
            const idx = await indexOf(store);
            const measure = store === STORES.OSU ? () => [...idx.values()].reduce((s, v) => s + v.size, 0) : () => idx.size;
            const cap = store === STORES.OSU ? osuCapBytes : resultCap;
            let total = measure();
            if (total <= cap) return;
            const oldest = [...idx.entries()].filter(([k]) => k !== keep).sort((a, b) => a[1].usedAt - b[1].usedAt);
            for (const [key, info] of oldest) {
                if (total <= cap) break;
                idx.delete(key);
                mem[store].delete(key);
                await safely(`delete ${store}`, () => backend.delete(store, key));
                total -= store === STORES.OSU ? info.size : 1;
            }
        }).catch((error) => onError(`trim ${store}`, error));
        return queue;
    }

    async function read(store, key) {
        const hit = mem[store].get(key);
        if (hit) return hit;
        const row = await safely(`get ${store}`, () => backend.get(store, key), undefined);
        if (!row) return null;
        mem[store].set(key, row);
        const t = now();
        if (t - (row.usedAt ?? 0) > TOUCH_EVERY_MS) {
            row.usedAt = t;
            (await indexOf(store)).set(key, { size: row.size ?? 0, usedAt: t });
            safely(`touch ${store}`, () => backend.put(store, row));
        }
        return row;
    }

    async function write(store, row) {
        const key = row[KEY_PATH[store]];
        mem[store].set(key, row);
        await safely(`put ${store}`, () => backend.put(store, row));
        (await indexOf(store)).set(key, { size: row.size ?? 0, usedAt: row.usedAt });
        await trim(store, key);
    }

    return {
        // → { beatmapId, md5, text, size, fetchedAt, usedAt } | null
        getOsu: (beatmapId) => read(STORES.OSU, Number(beatmapId)),
        async putOsu({ beatmapId, md5, text, fetchedAt = now() }) {
            const t = now();
            await write(STORES.OSU, { beatmapId: Number(beatmapId), md5, text, size: text.length, fetchedAt, usedAt: t });
        },
        async getResult(key) {
            const row = await read(STORES.RESULTS, key);
            return row ? row.result : null;
        },
        async putResult(key, result) {
            const t = now();
            await write(STORES.RESULTS, { key, result, savedAt: t, usedAt: t });
        },
        async clear() {
            for (const store of Object.values(STORES)) {
                mem[store].clear();
                index[store] = new Map();
                await safely(`clear ${store}`, () => backend.clear(store));
            }
        },
        // for tests and the log
        async stats() {
            const osu = await indexOf(STORES.OSU);
            const results = await indexOf(STORES.RESULTS);
            return { osuEntries: osu.size, osuBytes: [...osu.values()].reduce((s, v) => s + v.size, 0), results: results.size };
        },
    };
}
