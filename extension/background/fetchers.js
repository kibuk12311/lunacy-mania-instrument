// Every network request of the extension (extension/DESIGN.md §5.3), made by the background only:
//   GET https://osu.ppy.sh/osu/<beatmapId>                        the .osu (no cookies)
//   GET https://b.ppy.sh/preview/<setId>.mp3                       the set's 10 s preview (no cookies)
//   GET https://osu.ppy.sh/beatmapsets/<setId>/download?noVideo=1  the .osz with the user's own osu! session, only on
//                                                                  their click in the player
// Answers are { ok: true, … } or { ok: false, error: { code, status?, message? } } with codes of ERR.
import { ERR } from "../shared/protocol.js";

export const SITE = "https://osu.ppy.sh";
export const PREVIEW_HOST = "https://b.ppy.sh";
export const OSZ_CAP_BYTES = 300 * 1024 * 1024;
export const PREVIEW_CAP_BYTES = 20 * 1024 * 1024;
export const OSU_CAP_BYTES = 32 * 1024 * 1024;
const OSU_IN_FLIGHT = 2;
// one .osu request (headers and body) gives up after this, so a stalled connection cannot hold a slot for ever; it
// answers ERR.NETWORK (osu! did not answer), not ERR.TIMEOUT, which is the analysis' own timeout
export const OSU_TIMEOUT_MS = 30_000;
const RETRY_AFTER_MAX_MS = 10_000;
const RETRY_AFTER_DEFAULT_MS = 2_000;

export const osuUrl = (beatmapId) => `${SITE}/osu/${beatmapId}`;
export const previewUrl = (setId) => `${PREVIEW_HOST}/preview/${setId}.mp3`;
export const oszUrl = (setId, noVideo = true) => `${SITE}/beatmapsets/${setId}/download${noVideo ? "?noVideo=1" : ""}`;

// osu!'s own hosts: ppy.sh and its subdomains, https only
export function isPpyUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && (u.hostname === "ppy.sh" || u.hostname.endsWith(".ppy.sh"));
    } catch {
        return false;
    }
}

const fail = (code, extra = {}) => ({ ok: false, error: { code, ...extra } });
const isAbort = (error) => error?.name === "AbortError";

function thrown(error, what) {
    if (isAbort(error)) return fail(ERR.CANCELLED, { message: `${what} cancelled` });
    return fail(ERR.NETWORK, { message: `${what}: ${String(error?.message ?? error)}` });
}

// Seconds or an HTTP date → ms to wait, at most RETRY_AFTER_MAX_MS.
export function retryAfterMs(value, now = Date.now()) {
    if (value === null || value === undefined || value === "") return RETRY_AFTER_DEFAULT_MS;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (!Number.isFinite(ms)) return RETRY_AFTER_DEFAULT_MS;
    return Math.max(0, Math.min(RETRY_AFTER_MAX_MS, ms));
}

// The file name in Content-Disposition (filename*=UTF-8''… first), or null.
export function dispositionName(header) {
    if (!header) return null;
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
    if (star) {
        try {
            return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
        } catch {
            // fall through to the plain one
        }
    }
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
    const name = plain ? (plain[2] ?? plain[1]).trim() : "";
    return name || null;
}

const header = (response, name) => response.headers?.get?.(name) ?? null;
const lengthOf = (response) => {
    const n = Number(header(response, "content-length"));
    return Number.isFinite(n) && n > 0 ? n : null;
};

// A response body as pieces of bytes, stopping (and cancelling) past cap.
async function* piecesOf(response, cap, signal) {
    if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > cap) throw Object.assign(new Error("too big"), { lmCode: ERR.TOO_BIG });
        if (bytes.length) yield bytes;
        return;
    }
    const reader = response.body.getReader();
    let received = 0;
    try {
        for (;;) {
            if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
            const { done, value } = await reader.read();
            if (done) return;
            received += value.length;
            if (received > cap) throw Object.assign(new Error("too big"), { lmCode: ERR.TOO_BIG });
            yield value;
        }
    } finally {
        reader.cancel().catch(() => {});
    }
}

// An error thrown while reading a body → the protocol's error.
export function readError(error, what) {
    if (error?.lmCode) return fail(error.lmCode, { message: `${what}: ${error.message}` });
    return thrown(error, what);
}

export function createFetchers({
    fetch = globalThis.fetch.bind(globalThis), md5Hex, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
    caps: { osz: oszCap = OSZ_CAP_BYTES, preview: previewCap = PREVIEW_CAP_BYTES, osu: osuCap = OSU_CAP_BYTES } = {},
    osuTimeoutMs = OSU_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
    if (typeof md5Hex !== "function") throw new Error("createFetchers needs md5Hex");

    // at most OSU_IN_FLIGHT .osu requests at a time
    let active = 0;
    const waiting = [];
    const acquire = () => (active < OSU_IN_FLIGHT ? (active += 1, Promise.resolve()) : new Promise((r) => waiting.push(r)));
    const release = () => {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
    };

    // an AbortSignal that fires after osuTimeoutMs; clear() stops the timer
    function deadline() {
        const controller = new AbortController();
        const timer = setTimer(() => controller.abort(), osuTimeoutMs);
        return { signal: controller.signal, clear: () => clearTimer(timer) };
    }
    const timedOut = () => fail(ERR.NETWORK, { message: `.osu: no answer in ${Math.round(osuTimeoutMs / 1000)} s` });

    async function getOsuOnce(beatmapId, signal) {
        try {
            return { response: await fetch(osuUrl(beatmapId), { credentials: "omit", redirect: "follow", cache: "no-cache", signal }) };
        } catch (error) {
            return { failed: signal.aborted ? timedOut() : thrown(error, ".osu") };
        }
    }

    // → { ok: true, beatmapId, text, md5, bytes: length, fetchedAt } | fail
    async function fetchOsu(beatmapId) {
        await acquire();
        // each try has its own deadline, which also covers reading its body
        let attempt = deadline();
        try {
            let { response, failed } = await getOsuOnce(beatmapId, attempt.signal);
            if (failed) return failed;
            if (response.status === 429) {
                attempt.clear();
                response.body?.cancel?.().catch?.(() => {});
                await sleep(retryAfterMs(header(response, "retry-after"), now()));
                attempt = deadline();
                ({ response, failed } = await getOsuOnce(beatmapId, attempt.signal));
                if (failed) return failed;
                if (response.status === 429) return fail(ERR.RATE_LIMITED, { status: 429, message: "osu! asks to slow down" });
            }
            if (response.url && !isPpyUrl(response.url)) return fail(ERR.HOST, { message: "the .osu came from outside osu!" });
            if (response.status === 404) return fail(ERR.NOT_FOUND, { status: 404 });
            if (!response.ok) return fail(ERR.HTTP, { status: response.status });
            if (/text\/html/i.test(header(response, "content-type") ?? "")) return fail(ERR.HTTP, { status: response.status, message: "osu! answered with a page instead of the .osu" });
            let bytes;
            try {
                const parts = [];
                for await (const piece of piecesOf(response, osuCap, attempt.signal)) parts.push(piece);
                bytes = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
                let at = 0;
                for (const p of parts) {
                    bytes.set(p, at);
                    at += p.length;
                }
            } catch (error) {
                return attempt.signal.aborted ? timedOut() : readError(error, ".osu");
            }
            if (!bytes.length) return fail(ERR.NOT_FOUND, { status: response.status, message: "empty .osu" });
            const text = new TextDecoder("utf-8").decode(bytes);
            return { ok: true, beatmapId, text, md5: md5Hex(bytes), bytes: bytes.length, fetchedAt: now() };
        } finally {
            attempt.clear();
            release();
        }
    }

    // → { ok: true, contentType, total, fileName: null, pieces: AsyncIterable<Uint8Array> } | fail
    async function openPreview(setId, { signal } = {}) {
        let response;
        try {
            response = await fetch(previewUrl(setId), { credentials: "omit", redirect: "follow", signal });
        } catch (error) {
            return thrown(error, "preview");
        }
        if (response.url && !isPpyUrl(response.url)) return fail(ERR.HOST, { message: "the preview came from outside osu!" });
        if (response.status === 404) return fail(ERR.NOT_FOUND, { status: 404 });
        if (response.status === 429) return fail(ERR.RATE_LIMITED, { status: 429 });
        if (!response.ok) return fail(ERR.HTTP, { status: response.status });
        const total = lengthOf(response);
        if (total && total > previewCap) return fail(ERR.TOO_BIG, { message: `preview of ${total} bytes` });
        return {
            ok: true,
            contentType: header(response, "content-type"),
            total,
            fileName: `${setId}.mp3`,
            pieces: piecesOf(response, previewCap, signal),
        };
    }

    // → { ok: true, contentType, total, fileName, pieces } | fail; the first piece is already checked for "PK\3\4".
    async function openOsz(setId, { signal, noVideo = true } = {}) {
        let response;
        try {
            response = await fetch(oszUrl(setId, noVideo), { credentials: "include", redirect: "follow", signal });
        } catch (error) {
            return thrown(error, ".osz");
        }
        const finalUrl = response.url || oszUrl(setId, noVideo);
        if (!isPpyUrl(finalUrl)) return fail(ERR.HOST, { message: "osu! sent the download to a host outside osu!" });
        const { status } = response;
        if (status === 401 || status === 403) return fail(ERR.LOGIN, { status });
        if (status === 404) return fail(ERR.NOT_FOUND, { status });
        if (status === 410 || status === 451) return fail(ERR.DISABLED, { status });
        if (status === 429) return fail(ERR.LIMIT, { status });
        if (!response.ok) return fail(ERR.HTTP, { status });
        // logged out, osu! sends the download back to the set's page (302 → 200 text/html)
        const onSetPage = (() => {
            try {
                const u = new URL(finalUrl);
                return u.hostname === "osu.ppy.sh" && new RegExp(`^/beatmapsets/${setId}/?$`).test(u.pathname);
            } catch {
                return false;
            }
        })();
        const notZip = () => (onSetPage
            ? fail(ERR.LOGIN, { status, message: "osu! answered with the set's page: not logged in" })
            : fail(ERR.NOT_ZIP, { status, message: "osu! did not send an .osz" }));
        const contentType = header(response, "content-type");
        if (/text\/html/i.test(contentType ?? "")) {
            response.body?.cancel?.().catch?.(() => {});
            return notZip();
        }
        const total = lengthOf(response);
        if (total && total > oszCap) {
            response.body?.cancel?.().catch?.(() => {});
            return fail(ERR.TOO_BIG, { message: `.osz of ${total} bytes` });
        }
        const pieces = piecesOf(response, oszCap, signal);
        // read until the first 4 bytes are there to check the zip signature
        const head = [];
        let have = 0;
        try {
            while (have < 4) {
                const { done, value } = await pieces.next();
                if (done) break;
                head.push(value);
                have += value.length;
            }
        } catch (error) {
            return readError(error, ".osz");
        }
        const first = new Uint8Array(Math.min(4, have));
        let at = 0;
        for (const p of head) {
            const take = p.subarray(0, first.length - at);
            first.set(take, at);
            at += take.length;
            if (at >= first.length) break;
        }
        const isZip = first.length === 4 && first[0] === 0x50 && first[1] === 0x4b && first[2] === 3 && first[3] === 4;
        if (!isZip) {
            pieces.return?.().catch?.(() => {});
            return notZip();
        }
        async function* all() {
            yield* head;
            yield* pieces;
        }
        return {
            ok: true,
            contentType,
            total,
            fileName: dispositionName(header(response, "content-disposition")) ?? `${setId}.osz`,
            pieces: all(),
        };
    }

    // streamPreview / streamOsz are the names DESIGN §5.3 uses
    return { fetchOsu, openPreview, openOsz, streamPreview: openPreview, streamOsz: openOsz };
}
