// The mapper styles of every model file, for the create tab's style picker (0.9.5), read without loading the models:
// the window shows the styles of the model picked in the picker before anything was generated with it.
// - scanStyles(file): the file is read in chunks up to its first `"styles": [ … ]`, and only that array is parsed (the
//   118 MB mapper-xgb3.json keeps its styles near the end, the nn-v2 files near the start; mapper.json has none). A
//   file without one, or with a broken one, has no styles: [].
// - createStyleCatalog({ dirs, cacheFile }): forFile(name) → the styles of that model file, from the first folder of
//   `dirs` that has it (as the worker reads them: LUNACY_MODEL_DIR first, then the app's models/); bySize(files) → per
//   picker choice (auto, xgb3, s, m, l) the styles of the file the worker would load for it (modelOrder), the names
//   shown (src/gen/styleNames.js: the nn-v2 lists are named from XGBoost v3's), most maps first. Each file is scanned
//   once: the lists are kept in memory and in cacheFile (userData\model-styles.json) by path, size and change time,
//   so a start of the app scans nothing until a model file changes.
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { createJsonStore } from "./jsonStore.js";
import { MODEL_SIZES, modelDirs, modelOrder } from "./generatorJobs.js";
import { displayStyles, namesFrom } from "../src/gen/styleNames.js";

const CHUNK = 1 << 20;
const NEEDLE = Buffer.from('"styles"');
const MAX_STYLES_BYTES = 8 << 20; // a styles array larger than this is not one
const CACHE_VERSION = 1;
const MAX_KEY = 128;

const clean = (list) => (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s.key === "string" && s.key && s.key.length <= MAX_KEY)
    .map((s) => ({ key: s.key, name: typeof s.name === "string" ? s.name : null, maps: Number(s.maps) || 0 }));

const isSpace = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

// The bytes of the JSON array that starts at buf[at] ("["), or null when it does not end inside buf.
function arrayEnd(buf, at) {
    let depth = 0;
    let inString = false;
    for (let i = at; i < buf.length; i += 1) {
        const b = buf[i];
        if (inString) {
            if (b === 0x5c) i += 1; // a backslash: skip what it escapes
            else if (b === 0x22) inString = false;
        } else if (b === 0x22) inString = true;
        else if (b === 0x5b || b === 0x7b) depth += 1;
        else if (b === 0x5d || b === 0x7d) {
            depth -= 1;
            if (depth === 0) return i + 1;
        }
    }
    return null;
}

export async function scanStyles(file, { fs = nodeFs } = {}) {
    const handle = await fs.open(file, "r");
    try {
        const chunk = Buffer.alloc(CHUNK);
        let buf = Buffer.alloc(0);
        let from = 0;
        let found = false; // buf starts with the array once found
        for (;;) {
            const { bytesRead } = await handle.read(chunk, 0, CHUNK, null);
            if (!bytesRead) return [];
            buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
            while (!found) {
                const hit = buf.indexOf(NEEDLE, from);
                if (hit < 0) {
                    // keep what could be the start of a key cut in two
                    buf = buf.subarray(Math.max(0, buf.length - NEEDLE.length + 1));
                    from = 0;
                    break;
                }
                let i = hit + NEEDLE.length;
                while (i < buf.length && isSpace(buf[i])) i += 1;
                if (i < buf.length && buf[i] === 0x3a) {
                    i += 1;
                    while (i < buf.length && isSpace(buf[i])) i += 1;
                    if (i < buf.length && buf[i] === 0x5b) {
                        buf = buf.subarray(i);
                        found = true;
                        break;
                    }
                }
                if (i >= buf.length) {
                    // the rest of this key is in the next chunk
                    buf = buf.subarray(hit);
                    from = 0;
                    break;
                }
                from = hit + 1; // "styles" as a value, or not an array
            }
            if (!found) continue;
            const end = arrayEnd(buf, 0);
            if (end !== null) {
                try {
                    return clean(JSON.parse(buf.subarray(0, end).toString("utf8")));
                } catch {
                    return [];
                }
            }
            if (buf.length > MAX_STYLES_BYTES) return [];
        }
    } finally {
        await handle.close();
    }
}

export function createStyleCatalog({ dirs = () => modelDirs(), cacheFile = null, fs = nodeFs, scan = (file) => scanStyles(file, { fs }) } = {}) {
    const dirList = () => (typeof dirs === "function" ? dirs() : dirs);
    const store = cacheFile ? createJsonStore({ file: cacheFile, fs, fallback: { v: CACHE_VERSION, files: {} }, normalize: (x) => (x?.v === CACHE_VERSION && x.files && typeof x.files === "object" ? x : { v: CACHE_VERSION, files: {} }) }) : null;
    const memo = new Map(); // path → { size, mtimeMs, list: Promise<styles> }

    async function locate(name) {
        for (const dir of dirList()) {
            const file = path.join(dir, name);
            const info = await fs.stat(file).catch(() => null);
            if (info?.isFile()) return { file, size: info.size, mtimeMs: Math.round(info.mtimeMs) };
        }
        return null;
    }

    async function listOf({ file, size, mtimeMs }) {
        const cached = store ? (await store.get().catch(() => null))?.files?.[file] : null;
        if (cached && cached.size === size && cached.mtimeMs === mtimeMs && Array.isArray(cached.styles)) return clean(cached.styles);
        const styles = await scan(file).catch(() => []);
        if (store) await store.update((all) => ({ ...all, files: { ...all.files, [file]: { size, mtimeMs, styles } } })).catch(() => {});
        return styles;
    }

    // the styles of one model file ([] when it is not there or has none)
    async function forFile(name) {
        const where = await locate(name);
        if (!where) return [];
        const was = memo.get(where.file);
        if (was && was.size === where.size && was.mtimeMs === where.mtimeMs) return was.list;
        const list = listOf(where);
        memo.set(where.file, { ...where, list });
        return list;
    }

    // { auto, xgb3, s, m, l } → the styles shown for that choice; `files`: the model files there (listModelFiles)
    async function bySize(files) {
        const fileOf = (size) => modelOrder(size).find((name) => files.includes(name)) ?? null;
        const raw = {};
        for (const size of MODEL_SIZES) {
            const name = fileOf(size);
            raw[size] = name ? await forFile(name) : [];
        }
        const names = namesFrom(Object.values(raw));
        return Object.fromEntries(MODEL_SIZES.map((size) => [size, displayStyles(raw[size], names)]));
    }

    return { forFile, bySize };
}
