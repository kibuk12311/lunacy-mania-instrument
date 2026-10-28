// Calls from the osu! page (content script) and the player to the background (extension/DESIGN.md §5.2). Every
// function resolves, never rejects: { ok: true, … } or { ok: false, error: { code, status?, message? } } with a code
// of ERR; message is an English diagnostic, the UI words the code. A dead extension context (the extension was
// reloaded under an open tab) is ERR.CONTEXT.
import { ERR, MSG, PORT_FETCH } from "./protocol.js";
import { base64ToBytes, concatBytes } from "./transfer.js";

const defaultRuntime = () => globalThis.chrome?.runtime ?? globalThis.browser?.runtime ?? null;

const fail = (code, extra = {}) => ({ ok: false, error: { code, ...extra } });

// An exception or runtime.lastError → an error object of the protocol.
export function errorOf(problem) {
    const message = String(problem?.message ?? problem ?? "");
    if (/context invalidated|Receiving end does not exist|Could not establish connection|runtime is unavailable/i.test(message)) {
        return { code: ERR.CONTEXT, message };
    }
    return { code: ERR.NETWORK, message: message || "no answer from the extension" };
}
const portClosed = (message) => /message port closed|before a response was received/i.test(message);

export function createClient(getRuntime = defaultRuntime) {
    const runtime = () => {
        const rt = typeof getRuntime === "function" ? getRuntime() : getRuntime;
        if (!rt?.sendMessage || !rt?.id) throw new Error("extension runtime is unavailable (context invalidated)");
        return rt;
    };

    // One request/answer. A port closed without an answer (the service worker went away) is tried once more.
    function send(message, { retry = 1 } = {}) {
        return new Promise((resolve) => {
            let rt;
            try {
                rt = runtime();
                rt.sendMessage(message, (answer) => {
                    const lastError = rt.lastError;
                    if (lastError) {
                        if (retry > 0 && portClosed(lastError.message)) resolve(send(message, { retry: retry - 1 }));
                        else resolve({ ok: false, error: errorOf(lastError) });
                        return;
                    }
                    if (!answer || typeof answer !== "object") resolve(fail(ERR.CONTEXT, { message: "empty answer from the background" }));
                    else resolve(answer);
                });
            } catch (error) {
                resolve({ ok: false, error: errorOf(error) });
            }
        });
    }

    async function analyze({ beatmapId, checksum = null, rate = 1, lang = "en", priority = "normal" } = {}) {
        const answer = await send({ type: MSG.ANALYZE, beatmapId, checksum, rate, lang, priority });
        return answer.ok ? answer : { ok: false, beatmapId, rate, error: answer.error ?? { code: ERR.CONTEXT } };
    }

    async function getOsu({ beatmapId, checksum = null } = {}) {
        const answer = await send({ type: MSG.OSU, beatmapId, checksum });
        return answer.ok ? answer : { ok: false, beatmapId, error: answer.error ?? { code: ERR.CONTEXT } };
    }

    const info = () => send({ type: MSG.INFO });
    const clearCache = () => send({ type: MSG.CACHE_CLEAR });

    // Bytes through the port PORT_FETCH: meta, base64 chunks, progress, then done or error.
    function stream(request, { onProgress, signal } = {}) {
        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve(fail(ERR.CANCELLED));
                return;
            }
            let port;
            let finished = false;
            let meta = { contentType: null, total: null, fileName: null };
            const parts = [];
            let received = 0;
            const progress = (r, total) => {
                try {
                    onProgress?.({ received: r, total: total ?? null });
                } catch {
                    // the caller's callback is not ours to break on
                }
            };
            const onAbort = () => {
                try {
                    port?.postMessage({ type: "cancel" });
                } catch {
                    // the port is gone anyway
                }
                finish(fail(ERR.CANCELLED));
            };
            const finish = (value) => {
                if (finished) return;
                finished = true;
                signal?.removeEventListener?.("abort", onAbort);
                try {
                    port?.disconnect();
                } catch {
                    // already closed
                }
                resolve(value);
            };
            try {
                port = runtime().connect({ name: PORT_FETCH });
            } catch (error) {
                resolve({ ok: false, error: errorOf(error) });
                return;
            }
            signal?.addEventListener?.("abort", onAbort, { once: true });
            port.onMessage.addListener((m) => {
                if (finished || !m || typeof m !== "object") return;
                if (m.type === "meta") {
                    meta = { contentType: m.contentType ?? null, total: Number.isFinite(m.total) ? m.total : null, fileName: m.fileName ?? null };
                    progress(received, meta.total);
                } else if (m.type === "chunk") {
                    const bytes = base64ToBytes(m.data);
                    parts.push(bytes);
                    received += bytes.length;
                    progress(received, meta.total);
                } else if (m.type === "progress") {
                    progress(received, Number.isFinite(m.total) ? m.total : meta.total);
                } else if (m.type === "done") {
                    finish({ ok: true, bytes: concatBytes(parts), contentType: meta.contentType, fileName: meta.fileName });
                } else if (m.type === "error") {
                    const { type, ...error } = m;
                    finish({ ok: false, error: { code: error.code ?? ERR.NETWORK, ...error } });
                }
            });
            port.onDisconnect.addListener(() => {
                const rt = defaultRuntimeSafe(getRuntime);
                const lastError = rt?.lastError;
                finish({ ok: false, error: lastError ? errorOf(lastError) : { code: ERR.NETWORK, message: "the background closed the download" } });
            });
            try {
                port.postMessage(request);
            } catch (error) {
                finish({ ok: false, error: errorOf(error) });
            }
        });
    }

    const getPreview = ({ setId, onProgress, signal } = {}) => stream({ type: "get", what: "preview", setId }, { onProgress, signal })
        .then((r) => (r.ok ? { ok: true, bytes: r.bytes, contentType: r.contentType } : r));
    const getOsz = ({ setId, noVideo = true, onProgress, signal } = {}) => stream({ type: "get", what: "osz", setId, noVideo: noVideo !== false }, { onProgress, signal });

    return { analyze, getOsu, getPreview, getOsz, info, clearCache };
}

function defaultRuntimeSafe(getRuntime) {
    try {
        return typeof getRuntime === "function" ? getRuntime() : getRuntime;
    } catch {
        return null;
    }
}

const client = createClient();
export const analyze = client.analyze;
export const getOsu = client.getOsu;
export const getPreview = client.getPreview;
export const getOsz = client.getOsz;
export const info = client.info;
export const clearCache = client.clearCache;
