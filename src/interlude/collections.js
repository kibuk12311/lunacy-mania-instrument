// Interlude's Data/collections.json, re-implemented from reading Prelude (MIT): prelude/src/Data/UserDatabase/
// Collections.fs and the Percyqaz.Data JSON codecs (records → objects by field name, a tuple → an array, a Setting →
// its value, Dictionary<string, _> → an object, Set → an array). Its shape:
//   { "Folders":   { "<name>": { "Charts": [{ "Hash": "<id>" }], "Icon": "" } },
//     "Playlists": { "<name>": { "Charts": [[{ "Hash": "<id>" }, { "Mods": {}, "Rate": 1.05 }]], "Icon": "" } },
//     "Likes": ["<id>"] }
// A folder and a playlist may not share a name (Collections.Exists looks at both). A playlist's rate is bounded to
// 0.5–3.0 and kept to two decimals (Setting.rate, prelude/src/Shared/Units.fs).
export const MIN_RATE = 0.5;
export const MAX_RATE = 3.0;
const MAX_NAME = 64;

export const playlistRate = (rate) => {
    const r = Number(rate);
    return Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, Number.isFinite(r) ? r : 1)) * 100) / 100;
};

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isHash = (h) => typeof h === "string" && /^[0-9A-F]{64}$/.test(h);

// collections.json's text → the parsed value, every part this needs checked; throws on anything else, so a file
// Interlude would not read is never written over.
export function parseCollections(text) {
    const data = JSON.parse(String(text).replace(/^﻿/, ""));
    if (!isObject(data)) throw new Error("collections.json is not an object");
    for (const key of ["Folders", "Playlists"]) {
        if (data[key] === undefined) data[key] = {};
        if (!isObject(data[key])) throw new Error(`collections.json: ${key} is not an object`);
    }
    if (data.Likes === undefined) data.Likes = [];
    if (!Array.isArray(data.Likes)) throw new Error("collections.json: Likes is not a list");
    return data;
}

export const emptyCollections = () => ({ Folders: {}, Playlists: {}, Likes: [] });

// A collection name: no control characters, trimmed, at most 64 characters; empty → fallback.
export function cleanName(name, fallback = "Lunacy mania") {
    const clean = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME).trim() : "";
    return clean || fallback;
}

// name, or "name (2)", "name (3)" … : the first one neither a folder nor a playlist has.
export function uniqueName(data, name) {
    const taken = (n) => Object.hasOwn(data.Folders, n) || Object.hasOwn(data.Playlists, n);
    if (!taken(name)) return name;
    for (let n = 2; ; n += 1) if (!taken(`${name} (${n})`)) return `${name} (${n})`;
}

// Adds a playlist (entries [{ hash, rate }], in order, the same chart allowed more than once) or a folder (hashes,
// each once) under a name of its own. Nothing already there is changed. → { data, name, count }
export function addCollection(data, { kind, name, entries }) {
    const list = (entries ?? []).filter((e) => isHash(e?.hash));
    if (!list.length) throw new Error("no charts to add");
    const unique = uniqueName(data, cleanName(name));
    if (kind === "folder") {
        const hashes = [...new Set(list.map((e) => e.hash))];
        data.Folders[unique] = { Charts: hashes.map((hash) => ({ Hash: hash })), Icon: "" };
        return { data, name: unique, count: hashes.length };
    }
    data.Playlists[unique] = {
        Charts: list.map((e) => [{ Hash: e.hash }, { Mods: {}, Rate: playlistRate(e.rate) }]),
        Icon: "",
    };
    return { data, name: unique, count: list.length };
}

export const stringifyCollections = (data) => `${JSON.stringify(data, null, 2)}\n`;
