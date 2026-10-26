// tosu WebSocket v2 → { state, checksum, rate, mods }. In song select tosu reports the menu mods in play.mods.
import { t } from "../src/i18n/i18n.js";

const STATE_BY_NUMBER = { 0: "menu", 2: "playing", 5: "songselect", 7: "results" };
const SPEED_RATES = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };

function modCodes(mods) {
    if (Array.isArray(mods?.array) && mods.array.length) {
        return mods.array.map((m) => String(m?.acronym ?? m).toUpperCase());
    }
    const name = String(mods?.name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return name.match(/.{1,2}/g) ?? [];
}

export function parseFrame(json) {
    const mods = modCodes(json?.play?.mods);
    const speedMod = mods.find((m) => m in SPEED_RATES);
    const reported = Number(json?.play?.mods?.rate);
    const rate = Number.isFinite(reported) && reported > 0 && (reported !== 1 || !speedMod)
        ? reported
        : (speedMod ? SPEED_RATES[speedMod] : 1);
    return {
        state: STATE_BY_NUMBER[json?.state?.number] ?? "other",
        checksum: json?.beatmap?.checksum ? String(json.beatmap.checksum) : null,
        rate,
        mods,
    };
}

// path and parse let another reader (the overlay) use the same reconnecting socket for other tosu feeds.
export function connectTosu({
    port, retryMs = 2000, connectTimeoutMs = 5000, WebSocketImpl = globalThis.WebSocket, onFrame, onStatus,
    path = "/websocket/v2", parse = parseFrame,
}) {
    let socket = null;
    let closed = false;
    let retryTimer = null;
    let connectTimer = null;

    function open() {
        if (closed) return;
        onStatus?.("connecting");
        const current = new WebSocketImpl(`ws://127.0.0.1:${port}${path}`);
        socket = current;
        let opened = false;
        let finished = false;

        // Electron's WebSocket fires "error" without "close" on a refused port, so either one ends this attempt.
        const retry = () => {
            if (finished || closed) return;
            finished = true;
            clearTimeout(connectTimer);
            try { current.close(); } catch { /* already closed */ }
            onStatus?.("down");
            retryTimer = setTimeout(open, retryMs);
        };

        connectTimer = setTimeout(() => { if (!opened) retry(); }, connectTimeoutMs);
        current.addEventListener("open", () => {
            opened = true;
            clearTimeout(connectTimer);
            onStatus?.("connected");
        });
        current.addEventListener("message", (event) => {
            try {
                onFrame(parse(JSON.parse(String(event.data))));
            } catch {
                // a malformed frame is skipped; the next one replaces it
            }
        });
        current.addEventListener("close", retry);
        current.addEventListener("error", retry);
    }

    open();
    return {
        close() {
            closed = true;
            clearTimeout(retryTimer);
            clearTimeout(connectTimer);
            socket?.close();
        },
    };
}

export async function fetchCurrentOsu(port, { timeoutMs = 5000 } = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/files/beatmap/file`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(t("app.tosu.status", { status: res.status }));
    return res.text();
}

// Absolute path of the beatmap selected in osu! (Songs folder + the map's relative path, both from tosu).
export async function fetchCurrentBeatmapPath(port, { timeoutMs = 5000 } = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/json/v2`, { signal: AbortSignal.timeout(timeoutMs) });
    // tosu answers 500 while it has no osu! process to read
    if (!res.ok) throw new Error(t("app.tosu.openOsu"));
    const j = await res.json();
    const songs = j?.folders?.songs;
    const file = j?.directPath?.beatmapFile;
    if (!songs || !file) throw new Error(t("app.tosu.noMap"));
    return `${songs.replace(/[\\/]+$/, "")}\\${file}`;
}

// osu! account logged in on this PC ({ id, name } from tosu's profile), or null: osu! closed, nobody logged in, tosu down.
export async function fetchProfile(port, { timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
    try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/json/v2`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const profile = (await res.json())?.profile;
        const id = Number(profile?.id);
        if (!Number.isSafeInteger(id) || id <= 0) return null;
        return { id, name: typeof profile.name === "string" ? profile.name.trim() : "" };
    } catch {
        return null;
    }
}

// osu!'s Songs folder (from tosu's /json/v2), or null: osu! closed, tosu down, no answer.
export async function fetchSongsFolder(port, { timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
    try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/json/v2`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const songs = (await res.json())?.folders?.songs;
        return typeof songs === "string" && songs.trim() ? songs.trim().replace(/[\\/]+$/, "") : null;
    } catch {
        return null;
    }
}
