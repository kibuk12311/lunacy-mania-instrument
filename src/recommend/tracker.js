// Read-only client for the public mania-tracker API (main process only).
import { t } from "../i18n/i18n.js";

// a function, so the message comes in the language the app is in when it fails
const down = () => t("core.tracker.down");
// A 429 that asks to wait at most this long is waited out and tried once more.
const MAX_RETRY_WAIT_MS = 10000;
const DEFAULT_RETRY_WAIT_MS = 5000;
// Searches are remembered as long as the server's own Cache-Control (max-age=60).
const SEARCH_CACHE_MS = 60000;
const SEARCH_CACHE_SIZE = 50;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long a 429 asks to wait: Retry-After (seconds), else the body's retryAfterMs, else 5 s.
async function retryAfterMs(res) {
    const header = res.headers.get("retry-after")?.trim();
    if (header && Number.isFinite(Number(header)) && Number(header) >= 0) return Number(header) * 1000;
    try {
        const ms = Number((await res.json())?.retryAfterMs);
        if (Number.isFinite(ms) && ms >= 0) return ms;
    } catch {
        // no usable body
    }
    return DEFAULT_RETRY_WAIT_MS;
}

export function createTrackerApi({
    fetchImpl = globalThis.fetch, base = "https://api.mania-tracker.com", timeoutMs = 15000, sleep = wait, now = Date.now,
} = {}) {
    function urlFor(path, query = {}) {
        const url = new URL(path, base);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
        return url.toString();
    }

    async function send(url) {
        try {
            return await fetchImpl(url, {
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch {
            throw new Error(down());
        }
    }

    async function fetchJson(url) {
        let res = await send(url);
        for (let retried = false; res.status === 429; retried = true) {
            const ms = await retryAfterMs(res);
            if (retried || ms > MAX_RETRY_WAIT_MS) {
                throw new Error(t("core.tracker.rateLimited", { seconds: Math.max(1, Math.ceil(ms / 1000)) }));
            }
            await sleep(ms);
            res = await send(url);
        }
        if (!res.ok) throw new Error(t("core.tracker.status", { status: res.status }));
        try {
            return await res.json();
        } catch (error) {
            // A timeout while reading the body is still "not answering".
            if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new Error(down());
            throw new Error(t("core.tracker.badReply"));
        }
    }

    const getJson = (path, query) => fetchJson(urlFor(path, query));

    async function findUser(query) {
        const q = String(query ?? "").trim();
        if (!q) return null;
        const json = await getJson("/api/users/search", { q });
        const users = Array.isArray(json?.users) ? json.users.filter((u) => u && u.id != null) : [];
        const exact = users.find((u) => String(u.username ?? "").toLowerCase() === q.toLowerCase());
        // Digits that are nobody's name are taken as an osu! user id.
        const pick = exact ?? (/^\d+$/.test(q) ? null : users[0]);
        if (pick) return { id: Number(pick.id), username: String(pick.username ?? pick.id), avatarUrl: pick.avatarUrl ?? null };
        if (/^\d+$/.test(q)) return { id: Number(q), username: q, avatarUrl: null };
        return null;
    }

    function skills(id) {
        return getJson(`/api/profiles/${encodeURIComponent(id)}/skills`);
    }

    // Top-200 plays per axis (rejected ones too), merged: beatmapId → the best play (its accuracy, rate and the day
    // it was played, ms or null).
    async function playedMaps(id, axes) {
        const unique = [...new Set(axes)];
        const pages = await Promise.all(unique.map((axis) => getJson(`/api/profiles/${encodeURIComponent(id)}/skill-plays`, {
            keys: 4, axis, limit: 200, offset: 0, rejected: 1,
        })));
        const played = new Map();
        for (const page of pages) {
            const rows = [...(Array.isArray(page?.items) ? page.items : []), ...(Array.isArray(page?.rejected) ? page.rejected : [])];
            for (const row of rows) {
                const beatmapId = Number(row?.beatmapId);
                if (!Number.isFinite(beatmapId)) continue;
                const accuracy = Number(row.accuracy) || 0;
                const known = played.get(beatmapId);
                if (known && known.accuracy >= accuracy) continue;
                const playedAt = Date.parse(row.playedAt);
                played.set(beatmapId, {
                    beatmapsetId: Number(row.beatmapsetId), accuracy, rate: Number(row.rate) || 1, playedAt: Number.isFinite(playedAt) ? playedAt : null,
                });
            }
        }
        return played;
    }

    // Switching goals back and forth repeats the same searches; the server's rate limit counts each one.
    // The recent plays (about 200 KB) are kept as long, per player.
    const searchCache = new Map(); // url → { at, job }
    function cachedGet(url) {
        const hit = searchCache.get(url);
        if (hit && now() - hit.at < SEARCH_CACHE_MS) return hit.job;
        // entries sit in the order they were made, so the expired ones (~0.15 MB a page) are at the front
        for (const [key, entry] of searchCache) {
            if (now() - entry.at < SEARCH_CACHE_MS) break;
            searchCache.delete(key);
        }
        const job = fetchJson(url);
        searchCache.delete(url);
        searchCache.set(url, { at: now(), job });
        job.catch(() => { if (searchCache.get(url)?.job === job) searchCache.delete(url); });
        if (searchCache.size > SEARCH_CACHE_SIZE) searchCache.delete(searchCache.keys().next().value);
        return job;
    }

    async function searchMaps(params) {
        const json = await cachedGet(urlFor("/api/snapshots/maps-search", params));
        return {
            items: Array.isArray(json?.items) ? json.items : [],
            total: Number(json?.total) || 0,
            page: Number(json?.page) || 0,
            pageSize: Number(json?.pageSize) || 0,
        };
    }

    // The last ~70 osu! scores of the player (the server's own copy of them), as they come.
    function recent(id) {
        return cachedGet(urlFor(`/api/profiles/${encodeURIComponent(id)}/recent`));
    }

    // One page (25) of 4K skill snapshots, newest first; before: the page cursor the previous page gave (nextBefore).
    function skillHistory(id, { before } = {}) {
        const cursor = typeof before === "number" && Number.isSafeInteger(before) && before > 0 ? before : undefined;
        return getJson(`/api/profiles/${encodeURIComponent(id)}/skill-history`, { keys: 4, before: cursor });
    }

    return { findUser, skills, playedMaps, searchMaps, recent, skillHistory };
}
