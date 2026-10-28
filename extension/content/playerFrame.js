// The demo player as an overlay iframe (extension/DESIGN.md §5.5): an extension page over the whole osu! page, one at
// a time. Its parameters go in the URL hash; it says "close" by postMessage, which is taken only from that iframe's
// window and the extension's own origin. Esc in the page and Turbo leaving the page close it too. While it is open
// the page does not scroll (the old overflow comes back on close) and focus returns where it was.
import { PLAYER_SOURCE } from "../shared/protocol.js";
import { formatRate } from "../shared/rates.js";

export const PLAYER_PAGE = "player/player.html";
export const SOURCES = Object.freeze(["preview", "full", "file"]);

const loginParam = (login) => (login === true ? "1" : login === false ? "0" : "");

// { setId, beatmapId, src, rate, lang, checksum, login, previewWarn } → "set=…&map=…&…" (the order of §5.5)
export function playerParams({ setId, beatmapId, src = "preview", rate = 1, lang = "en", checksum = null, login = null, previewWarn = false } = {}) {
    const params = new URLSearchParams();
    params.set("set", String(setId ?? ""));
    params.set("map", String(beatmapId ?? ""));
    params.set("src", SOURCES.includes(src) ? src : "preview");
    params.set("rate", formatRate(Number.isFinite(Number(rate)) ? Number(rate) : 1));
    params.set("lang", lang === "ru" ? "ru" : "en");
    params.set("checksum", checksum ?? "");
    params.set("login", loginParam(login));
    params.set("previewWarn", previewWarn ? "1" : "0");
    return params.toString();
}

export const playerUrl = (base, params) => `${base}#${playerParams(params)}`;

// The origin of the extension's pages (chrome-extension://<id> / moz-extension://<uuid>).
export function extensionOrigin(runtime) {
    const url = new URL(runtime.getURL(""));
    return url.origin && url.origin !== "null" ? url.origin : `${url.protocol}//${url.host}`;
}

export function createPlayerFrame({ doc = globalThis.document, win = globalThis.window, runtime = globalThis.chrome?.runtime, onClose = () => {} } = {}) {
    let frame = null;
    let savedOverflow = null;
    let returnFocus = null;
    let origin = null;

    const onMessage = (event) => {
        if (!frame || event.source !== frame.contentWindow || event.source == null) return;
        if (event.origin !== origin) return;
        const data = event.data;
        if (!data || typeof data !== "object" || data.source !== PLAYER_SOURCE) return;
        if (data.type === "close") close();
    };
    const onKey = (event) => {
        if (frame && event.key === "Escape") {
            event.preventDefault?.();
            event.stopPropagation?.();
            close();
        }
    };
    const onLoad = () => {
        try {
            frame?.focus();
            frame?.contentWindow?.focus?.();
        } catch {
            // focus is a nicety
        }
    };

    function open(params) {
        close();
        origin = extensionOrigin(runtime);
        const iframe = doc.createElement("iframe");
        iframe.setAttribute("data-lm-player", "");
        iframe.setAttribute("allow", "autoplay");
        iframe.setAttribute("title", "Lunacy mania demo");
        iframe.setAttribute("src", playerUrl(runtime.getURL(PLAYER_PAGE), params));
        Object.assign(iframe.style, {
            position: "fixed", inset: "0", top: "0", left: "0", width: "100vw", height: "100vh",
            border: "0", margin: "0", padding: "0", zIndex: "2147483646", background: "transparent",
        });
        iframe.addEventListener("load", onLoad);
        returnFocus = doc.activeElement ?? null;
        const html = doc.documentElement;
        savedOverflow = html.style.overflow ?? "";
        html.style.overflow = "hidden";
        (doc.body ?? html).append(iframe);
        frame = iframe;
        win.addEventListener("message", onMessage);
        doc.addEventListener("keydown", onKey, true);
        return iframe;
    }

    function close() {
        if (!frame) return false;
        const old = frame;
        frame = null;
        win.removeEventListener("message", onMessage);
        doc.removeEventListener("keydown", onKey, true);
        old.removeEventListener("load", onLoad);
        old.remove();
        doc.documentElement.style.overflow = savedOverflow ?? "";
        savedOverflow = null;
        try {
            returnFocus?.focus?.();
        } catch {
            // the element may be gone
        }
        returnFocus = null;
        try {
            onClose();
        } catch {
            // the page's own listener
        }
        return true;
    }

    return { open, close, isOpen: () => frame !== null, get frame() { return frame; } };
}
