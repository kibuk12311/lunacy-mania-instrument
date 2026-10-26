// tosu WebSocket v2 → { state, checksum, rate, mods, client }. In song select tosu reports the menu mods in play.mods.
// tosu v4 reads osu! stable and osu! lazer alike; its v2 payload names the one it reads in `client` ("stable" | "lazer").
// On lazer the "Songs folder" tosu reports is lazer's file store (<data>/files) and a map's files are hashed paths
// in it (a/ab/abc…, no extension), so a map is read there but nothing may ever be written next to it.
import { t } from "../src/i18n/i18n.js";

const STATE_BY_NUMBER = { 0: "menu", 2: "playing", 5: "songselect", 7: "results" };
const SPEED_RATES = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };

// "stable" | "lazer" | null (an older tosu, or no osu! running)
export function clientOf(json) {
    const c = String(json?.client ?? "").toLowerCase();
    return c === "stable" || c === "lazer" ? c : null;
}

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
    // lazer's own speeds (DT/HT at any speed, Rate Adjust) come in mods.rate; to 0.01, as lazer sets them
    const reported = Math.round(Number(json?.play?.mods?.rate) * 100) / 100;
    const rate = Number.isFinite(reported) && reported > 0 && (reported !== 1 || !speedMod)
        ? reported
        : (speedMod ? SPEED_RATES[speedMod] : 1);
    return {
        state: STATE_BY_NUMBER[json?.state?.number] ?? "other",
        checksum: json?.beatmap?.checksum ? String(json.beatmap.checksum) : null,
        rate,
        mods,
        client: clientOf(json),
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

async function fetchJsonV2(port, timeoutMs, fetchImpl = globalThis.fetch) {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/v2`, { signal: AbortSignal.timeout(timeoutMs) });
    // tosu answers 500 while it has no osu! process to read
    if (!res.ok) throw new Error(t("app.tosu.openOsu"));
    return res.json();
}

const join = (base, rel) => (rel ? `${String(base).replace(/[\\/]+$/, "")}\\${rel}` : null);

// The beatmap selected in osu!, from tosu's /json/v2: { client, path, audioPath, backgroundPath }.
// stable: Songs\<set folder>\<name>; lazer: <data>\files\<hash path> for each file. A file the map lacks is null.
export function beatmapOf(j) {
    const songs = j?.folders?.songs;
    const file = j?.directPath?.beatmapFile;
    const client = clientOf(j) ?? "stable";
    if (!songs || !file || (client === "lazer" && !j?.files?.beatmap)) throw new Error(t("app.tosu.noMap"));
    return {
        client,
        path: join(songs, file),
        audioPath: j?.files?.audio ? join(songs, j.directPath.beatmapAudio) : null,
        backgroundPath: j?.files?.background ? join(songs, j.directPath.beatmapBackground) : null,
    };
}

export async function fetchCurrentBeatmap(port, { timeoutMs = 5000, fetchImpl } = {}) {
    return beatmapOf(await fetchJsonV2(port, timeoutMs, fetchImpl));
}

// Absolute path of the beatmap selected in osu! (Songs folder + the map's relative path, both from tosu).
// On lazer it is the hashed .osu in lazer's file store: readable, never to be written next to.
export async function fetchCurrentBeatmapPath(port, options = {}) {
    return (await fetchCurrentBeatmap(port, options)).path;
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

// osu! stable's Songs folder (from tosu's /json/v2), or null: osu! closed, tosu down, no answer, or osu! lazer
// (it has no Songs folder: what tosu reports there is its hashed file store, which has no set folders to look in).
export async function fetchSongsFolder(port, { timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
    try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/json/v2`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const json = await res.json();
        if (clientOf(json) === "lazer") return null;
        const songs = json?.folders?.songs;
        return typeof songs === "string" && songs.trim() ? songs.trim().replace(/[\\/]+$/, "") : null;
    } catch {
        return null;
    }
}
