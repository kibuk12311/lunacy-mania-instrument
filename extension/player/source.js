// Where the demo's chart and audio come from (extension/DESIGN.md §5.6): the 10 s preview, the full .osz downloaded
// with the user's own osu! session, or an .osz from disk. Pure helpers; main.js does the calls.
import { langForLocale } from "../shared/lang.js";
import { MIN_RATE, MAX_RATE, rateKey } from "../shared/rates.js";
import { parseChart, unplayableReason } from "./chart.js";

export const SOURCES = Object.freeze(["preview", "full", "file"]);
export const PREVIEW_TAIL_MS = 300; // notes this close to the preview's end are left out

const positiveInt = (v) => (/^\d{1,12}$/.test(String(v ?? "")) && Number(v) > 0 ? Number(v) : null);

// location.hash → the player's parameters (DESIGN §5.5); anything odd falls back to a safe value.
export function parseParams(hash, navLanguage = "en") {
    const q = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
    const rate = Number(q.get("rate"));
    const lang = q.get("lang");
    const login = q.get("login");
    const checksum = String(q.get("checksum") ?? "").toLowerCase();
    return {
        set: positiveInt(q.get("set")),
        map: positiveInt(q.get("map")),
        src: SOURCES.includes(q.get("src")) ? q.get("src") : "preview",
        rate: Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE ? rateKey(rate) : null,
        lang: lang === "ru" || lang === "en" ? lang : langForLocale(navLanguage),
        checksum: /^[0-9a-f]{32}$/.test(checksum) ? checksum : null,
        login: login === "1" ? true : login === "0" ? false : null,
        previewWarn: q.get("previewWarn") === "1",
    };
}

// The preview's notes: audio 0 = previewTime; heads in [previewTime, previewTime + duration − 300 ms]; an LN whose
// tail is past that end is dropped. Times stay chart ms.
export function previewStretch(notes, previewTime, durationSec) {
    const startMs = Number(previewTime);
    const endMs = startMs + Math.max(0, Number(durationSec) || 0) * 1000 - PREVIEW_TAIL_MS;
    const picked = notes.filter((n) => n.t >= startMs && n.t <= endMs && (n.end === null || n.end <= endMs));
    return { notes: picked, startMs, endMs: startMs + Math.max(0, Number(durationSec) || 0) * 1000 };
}

// Zip entry names as osu! writes them: case-insensitive, "\" = "/", no leading "./" or "/".
export const normalizeName = (name) => String(name ?? "").trim().replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "").toLowerCase();

// The entry named by AudioFilename (path first, then the bare file name), or null.
export function findAudio(entries, audioFilename) {
    const want = normalizeName(audioFilename);
    if (!want) return null;
    const files = entries.filter((e) => !e.name.endsWith("/"));
    const exact = files.find((e) => normalizeName(e.name) === want);
    if (exact) return exact;
    const base = want.split("/").pop();
    const byBase = files.filter((e) => normalizeName(e.name).split("/").pop() === base);
    return byBase.length === 1 ? byBase[0] : null;
}

// maps: [{ name, md5, chart }]. Which one to play: BeatmapID = map, else MD5 = checksum, else the only 4K mania map,
// else { choices } (the 4K mania maps, for the user to pick), else { none }.
export function chooseOsu(maps, { map = null, checksum = null } = {}) {
    if (map) {
        const byId = maps.find((m) => m.chart.beatmapId === map);
        if (byId) return { pick: byId, by: "id" };
    }
    if (checksum) {
        const byMd5 = maps.find((m) => String(m.md5).toLowerCase() === checksum);
        if (byMd5) return { pick: byMd5, by: "md5" };
    }
    const playable = maps.filter((m) => unplayableReason(m.chart) === null);
    if (playable.length === 1) return { pick: playable[0], by: "only" };
    if (playable.length > 1) return { choices: playable };
    return { none: true };
}

// Reads every .osu of an .osz. bytes → { ok: true, entries, maps } | { ok: false, code }.
export async function readOszMaps(bytes, { readZip, md5Hex }) {
    let entries;
    try {
        entries = await readZip(bytes);
    } catch {
        return { ok: false, code: "not-zip" };
    }
    const maps = [];
    for (const entry of entries) {
        if (!/\.osu$/i.test(entry.name)) continue;
        try {
            const data = await entry.read();
            const text = new TextDecoder("utf-8").decode(data);
            maps.push({ name: entry.name, md5: md5Hex ? md5Hex(data) : null, text, chart: parseChart(text) });
        } catch { /* a damaged entry is skipped */ }
    }
    if (!maps.length) return { ok: false, code: "no-chart" };
    return { ok: true, entries, maps };
}

// The chosen map's audio bytes. → { ok: true, bytes, name } | { ok: false, code: "no-audio", name }
export async function readAudio(entries, chart) {
    const entry = findAudio(entries, chart.audioFilename);
    if (!entry) return { ok: false, code: "no-audio", name: chart.audioFilename };
    try {
        return { ok: true, bytes: await entry.read(), name: entry.name };
    } catch {
        return { ok: false, code: "no-audio", name: chart.audioFilename };
    }
}

// Codes after which the player offers the "drop or pick an .osz" fallback.
export const FILE_FALLBACK = Object.freeze(new Set([
    "login", "limit", "network", "http", "not-found", "rate-limited", "disabled", "not-zip", "too-big", "host",
    "permission", "no-chart", "no-audio", "decode", "no-preview", "preview-empty", "timeout", "context",
]));
