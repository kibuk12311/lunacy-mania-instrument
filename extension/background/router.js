// The background's answers (extension/DESIGN.md §5.3): runtime messages lm:analyze, lm:osu, lm:info, lm:cache-clear
// and the port lm:fetch that streams the preview or the .osz to the player in base64 chunks. Everything it needs is
// passed in (background/sw.js and background/firefox.js wire the real parts), so the tests run it with fakes.
// Rule R1: the message listener answers only the types it owns, returns undefined for the rest and true only when
// it will call sendResponse.
import { ERR, MSG, PORT_FETCH, PRIORITY } from "../shared/protocol.js";
import { LANGS } from "../shared/lang.js";
import { MAX_RATE, MIN_RATE, rateKey } from "../shared/rates.js";
import { CHUNK_BYTES, bytesToBase64, createChunker } from "../shared/transfer.js";
import { oszUrl, osuUrl, previewUrl, readError } from "./fetchers.js";

export const OSU_FRESH_MS = 24 * 60 * 60 * 1000;
export const PROGRESS_EVERY_MS = 2000; // the protocol asks for at least every 5 s
const PRIORITIES = new Set(Object.values(PRIORITY));
const MD5 = /^[0-9a-f]{32}$/i;

const fail = (code, extra = {}) => ({ ok: false, error: { code, ...extra } });

// a positive integer id (numbers or digit strings), else null
export function toId(value) {
    const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// → { beatmapId, checksum, rate, lang, priority } | { error }
export function validateAnalyze(message) {
    const beatmapId = toId(message?.beatmapId);
    if (!beatmapId) return { error: { code: ERR.BAD_REQUEST, message: "beatmapId must be a positive integer" } };
    const raw = message.rate === undefined || message.rate === null ? 1 : Number(message.rate);
    if (!Number.isFinite(raw) || raw < MIN_RATE || raw > MAX_RATE) {
        return { error: { code: ERR.BAD_REQUEST, message: `rate must be within ${MIN_RATE}–${MAX_RATE}` } };
    }
    return {
        beatmapId,
        checksum: typeof message.checksum === "string" && MD5.test(message.checksum) ? message.checksum.toLowerCase() : null,
        rate: rateKey(raw),
        lang: LANGS.includes(message.lang) ? message.lang : "en",
        priority: PRIORITIES.has(message.priority) ? message.priority : PRIORITY.NORMAL,
    };
}

// Results of these kinds are kept; an "error" result (a calculator that failed this once) is worked out again.
const KEEP = new Set(["ok", "not-rice", "too-short"]);

export function createRouter({
    fetchers, cache, host, relabel = (r) => r, readOsuMeta, analyzer, version = "0.0.0",
    now = () => Date.now(), permits = async () => true, runtimeId = null,
    setInterval: every = setInterval, clearInterval: stopEvery = clearInterval, osuFreshMs = OSU_FRESH_MS,
} = {}) {
    const inflightOsu = new Map();
    const inflightResults = new Map();
    const metaCache = new Map(); // md5 → OsuMeta, small: .osu texts of the open pages
    const analyzerInfo = { fingerprint: analyzer?.fingerprint ?? null, appVersion: analyzer?.appVersion ?? null };

    const shared = (map, key, make) => {
        if (map.has(key)) return map.get(key);
        const promise = Promise.resolve().then(make).finally(() => map.delete(key));
        map.set(key, promise);
        return promise;
    };

    function metaOf(md5, text) {
        let meta = metaCache.get(md5);
        if (!meta) {
            meta = readOsuMeta(text);
            metaCache.set(md5, meta);
            if (metaCache.size > 200) metaCache.delete(metaCache.keys().next().value);
        }
        return meta;
    }

    // The .osu of a difficulty: the cached one when it is still the one osu! names (checksum) or, without a checksum,
    // when it is less than a day old; else fetched (once for concurrent asks).
    async function osuOf(beatmapId, checksum) {
        const entry = await cache.getOsu(beatmapId);
        if (entry && (checksum ? entry.md5 === checksum : now() - entry.fetchedAt < osuFreshMs)) {
            return { ok: true, text: entry.text, md5: entry.md5, cached: true };
        }
        return shared(inflightOsu, beatmapId, async () => {
            if (!(await permits(osuUrl(beatmapId)))) return fail(ERR.PERMISSION, { message: "no access to osu.ppy.sh" });
            const got = await fetchers.fetchOsu(beatmapId);
            if (!got.ok) {
                // osu! unreachable but an older copy is here: better than nothing
                if (entry && got.error.code !== ERR.NOT_FOUND) return { ok: true, text: entry.text, md5: entry.md5, cached: true, stale: true };
                return got;
            }
            await cache.putOsu({ beatmapId, md5: got.md5, text: got.text, fetchedAt: got.fetchedAt ?? now() });
            return { ok: true, text: got.text, md5: got.md5, cached: false };
        });
    }

    async function analyze(message) {
        const req = validateAnalyze(message);
        const beatmapId = req.beatmapId ?? toId(message?.beatmapId) ?? message?.beatmapId ?? null;
        if (req.error) return { ok: false, beatmapId, rate: message?.rate ?? null, error: req.error };
        const { rate, lang, priority } = req;
        const osu = await osuOf(beatmapId, req.checksum);
        if (!osu.ok) return { ok: false, beatmapId, rate, error: osu.error };
        const key = `${analyzerInfo.fingerprint}|${osu.md5}|${rate.toFixed(2)}`;
        let cached = true;
        let result = await cache.getResult(key);
        if (!result) {
            cached = false;
            // a more urgent ask for a job already waiting moves it up
            if (inflightResults.has(key)) host.bump?.(key, priority);
            const answer = await shared(inflightResults, key, async () => {
                const got = await host.analyze(osu.text, rate, priority, key);
                if (got.ok && KEEP.has(got.result?.kind)) await cache.putResult(key, got.result);
                return got;
            });
            if (!answer.ok) return { ok: false, beatmapId, rate, error: { code: answer.code ?? ERR.ANALYSIS, message: answer.message } };
            result = answer.result;
        }
        return { ok: true, beatmapId, rate, cached, meta: metaOf(osu.md5, osu.text), result: relabel(result, lang), analyzer: { ...analyzerInfo } };
    }

    async function getOsu(message) {
        const beatmapId = toId(message?.beatmapId);
        if (!beatmapId) return { ok: false, beatmapId: message?.beatmapId ?? null, error: { code: ERR.BAD_REQUEST, message: "beatmapId must be a positive integer" } };
        const checksum = typeof message.checksum === "string" && MD5.test(message.checksum) ? message.checksum.toLowerCase() : null;
        const osu = await osuOf(beatmapId, checksum);
        if (!osu.ok) return { ok: false, beatmapId, error: osu.error };
        return { ok: true, beatmapId, text: osu.text, md5: osu.md5, meta: metaOf(osu.md5, osu.text) };
    }

    const HANDLERS = {
        [MSG.ANALYZE]: analyze,
        [MSG.OSU]: getOsu,
        [MSG.INFO]: async () => ({ ok: true, version, analyzer: { ...analyzerInfo } }),
        [MSG.CACHE_CLEAR]: async () => {
            await cache.clear();
            metaCache.clear();
            return { ok: true };
        },
    };

    function onMessage(message, sender, sendResponse) {
        if (!message || typeof message !== "object" || message.target !== undefined) return undefined;
        const handler = Object.hasOwn(HANDLERS, message.type) ? HANDLERS[message.type] : null;
        if (!handler) return undefined;
        if (runtimeId && sender?.id && sender.id !== runtimeId) return undefined;
        Promise.resolve()
            .then(() => handler(message))
            .catch((error) => fail(ERR.ANALYSIS, { message: String(error?.message ?? error) }))
            .then((answer) => {
                try {
                    sendResponse(answer);
                } catch {
                    // the asking page is gone
                }
            });
        return true;
    }

    // Streams one download to the port: meta, chunks, progress at least every PROGRESS_EVERY_MS, done or error.
    async function pipe(port, request, signal, isOpen) {
        const post = (m) => {
            if (!isOpen()) return;
            try {
                port.postMessage(m);
            } catch {
                // closed under us
            }
        };
        const setId = toId(request.setId);
        if (!setId || (request.what !== "preview" && request.what !== "osz")) {
            post({ type: "error", code: ERR.BAD_REQUEST, message: "need what = preview | osz and a positive setId" });
            return;
        }
        const noVideo = request.noVideo !== false;
        const url = request.what === "preview" ? previewUrl(setId) : oszUrl(setId, noVideo);
        if (!(await permits(url))) {
            post({ type: "error", code: ERR.PERMISSION, message: "no access to osu!'s download hosts" });
            return;
        }
        const opened = request.what === "preview"
            ? await fetchers.openPreview(setId, { signal })
            : await fetchers.openOsz(setId, { signal, noVideo });
        if (!opened.ok) {
            post({ type: "error", ...opened.error });
            return;
        }
        const total = opened.total ?? null;
        post({ type: "meta", contentType: opened.contentType ?? null, total, fileName: opened.fileName ?? null });
        const chunker = createChunker(CHUNK_BYTES);
        let received = 0;
        const ticker = every(() => post({ type: "progress", received, total }), PROGRESS_EVERY_MS);
        try {
            for await (const piece of opened.pieces) {
                received += piece.length;
                for (const part of chunker.push(piece)) post({ type: "chunk", data: bytesToBase64(part) });
            }
            const rest = chunker.flush();
            if (rest.length) post({ type: "chunk", data: bytesToBase64(rest) });
            post({ type: "progress", received, total });
            post({ type: "done", received });
        } catch (error) {
            post({ type: "error", ...readError(error, request.what).error });
        } finally {
            stopEvery(ticker);
        }
    }

    function onConnect(port) {
        if (!port || port.name !== PORT_FETCH) return;
        if (runtimeId && port.sender?.id && port.sender.id !== runtimeId) {
            port.disconnect();
            return;
        }
        const controller = new AbortController();
        let open = true;
        let started = false;
        port.onDisconnect.addListener(() => {
            open = false;
            controller.abort();
        });
        port.onMessage.addListener((m) => {
            if (!m || typeof m !== "object") return;
            if (m.type === "cancel") {
                controller.abort();
                return;
            }
            if (m.type !== "get" || started) return;
            started = true;
            pipe(port, m, controller.signal, () => open && !controller.signal.aborted).catch(() => {});
        });
    }

    return { onMessage, onConnect, analyze, getOsu };
}
