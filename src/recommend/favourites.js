// Favourite maps and the picks journal, as the two JSON files in userData hold them: { version: 1, items: [...] },
// newest first. Every function returns a new value and never throws; anything unknown is dropped.
import { numericToLabel } from "../core/labels.js";
import { cleanSeed } from "./similar.js";

export const MAX_FAVOURITES = 500;
export const MAX_PICKS = 1000;
// how a map was picked: downloaded from a card, opened through osu!direct, or added to the favourites
export const PICK_HOWS = ["download", "direct", "fav"];
const COVER_HOST = "https://assets.ppy.sh/";
const MD5 = /^[0-9a-f]{32}$/;

const id = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
const text = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const within = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const danOf = (v) => within(v, 0.01, 25);
const label = (x, dan) => (typeof x.danLabel === "string" && x.danLabel ? x.danLabel.slice(0, 40) : dan === null ? "" : numericToLabel(dan).text);

function parse(json) {
    if (typeof json !== "string") return json;
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}
const itemsOf = (json) => {
    const doc = parse(json);
    return doc && typeof doc === "object" && Array.isArray(doc.items) ? doc.items : [];
};

export function cleanFavourite(x) {
    if (!x || typeof x !== "object") return null;
    const beatmapId = id(x.beatmapId);
    const beatmapsetId = id(x.beatmapsetId);
    if (!beatmapId || !beatmapsetId) return null;
    const dan = danOf(x.dan);
    const cover = typeof x.cover === "string" && x.cover.startsWith(COVER_HOST) && x.cover.length <= 300 ? x.cover : null;
    const entry = {
        beatmapId, beatmapsetId,
        artist: text(x.artist), title: text(x.title), version: text(x.version), creator: text(x.creator),
        dan, danLabel: label(x, dan),
        bpm: within(x.bpm, 1, 2000), lengthSec: within(x.lengthSec, 0, 36000),
        cover,
        seed: cleanSeed(x.seed),
        addedAt: within(x.addedAt, 1, 8.64e15),
    };
    if (typeof x.md5 === "string" && MD5.test(x.md5)) entry.md5 = x.md5;
    return entry;
}

export function parseFavourites(json) {
    const items = [];
    const seen = new Set();
    for (const raw of itemsOf(json)) {
        const f = cleanFavourite(raw);
        if (!f || seen.has(f.beatmapId)) continue;
        seen.add(f.beatmapId);
        items.push(f);
        if (items.length >= MAX_FAVOURITES) break;
    }
    return { version: 1, items };
}

// A card on top, stamped with now; one already there stays as it is (its place, time and md5).
export function addFavourite(doc, card, now) {
    const items = parseFavourites(doc).items;
    const f = cleanFavourite({ ...card, md5: undefined, addedAt: now });
    if (!f || items.some((x) => x.beatmapId === f.beatmapId)) return { version: 1, items };
    return { version: 1, items: [f, ...items].slice(0, MAX_FAVOURITES) };
}

export function removeFavourite(doc, beatmapId) {
    return { version: 1, items: parseFavourites(doc).items.filter((f) => f.beatmapId !== beatmapId) };
}

// md5s: Map beatmapId → md5 (or [id, md5] pairs) of the .osu files the export fetched.
export function withMd5(doc, md5s) {
    const known = new Map(md5s);
    return {
        version: 1,
        items: parseFavourites(doc).items.map((f) => {
            const md5 = known.get(f.beatmapId);
            return typeof md5 === "string" && MD5.test(md5) ? { ...f, md5 } : f;
        }),
    };
}

export function cleanPick(x) {
    if (!x || typeof x !== "object" || !PICK_HOWS.includes(x.how)) return null;
    const beatmapId = id(x.beatmapId);
    const beatmapsetId = id(x.beatmapsetId);
    const at = within(x.at, 1, 8.64e15);
    if (!beatmapId || !beatmapsetId || at === null) return null;
    const dan = danOf(x.dan);
    return {
        beatmapId, beatmapsetId, artist: text(x.artist), title: text(x.title), version: text(x.version),
        dan, danLabel: label(x, dan), how: x.how, at,
    };
}

// One entry per map, the earliest time it was picked.
export function parsePicks(json) {
    const byId = new Map();
    for (const raw of itemsOf(json)) {
        const p = cleanPick(raw);
        if (p && !(byId.get(p.beatmapId)?.at <= p.at)) byId.set(p.beatmapId, p);
    }
    const items = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, MAX_PICKS);
    return { version: 1, items };
}

// The first time a map was picked wins: a map already in the journal keeps its entry.
export function addPick(doc, entry) {
    const items = parsePicks(doc).items;
    const p = cleanPick(entry);
    if (!p || items.some((x) => x.beatmapId === p.beatmapId)) return { version: 1, items };
    return { version: 1, items: [p, ...items].slice(0, MAX_PICKS) };
}
