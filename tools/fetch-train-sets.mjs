// Extra training sets for the learned mapper: popular 4K rice sets from mania-tracker (with its dan labels),
// downloaded from public mirrors into a folder outside osu! (Songs is never touched), keeping only .osu and audio.
// Resumable: re-running skips what is done. A few downloads at a time with a short pause; the fastest mirror first.
// Usage: node tools/fetch-train-sets.mjs <outRoot> [targetSets=8000] [songsRoot="A:/Games/osu!/Songs"] [lanes=4]
//   <outRoot>/manifest.json      chosen sets: { setId, title, diffs: [{ beatmapId, version, dan, primary, patterns, msd }] }
//   <outRoot>/sets/<setId>/…      extracted .osu + audio
//   <outRoot>/state.jsonl         one line per finished set: { setId, ok, mirror, bytes, files, error }
import { mkdir, readdir, readFile, writeFile, appendFile, rm, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { createTrackerApi } from "../src/recommend/tracker.js";
import { createDownloader, MIRRORS } from "../src/recommend/download.js";

const [outRoot, targetArg = "8000", songsRoot = "A:/Games/osu!/Songs", lanesArg = "4"] = process.argv.slice(2);
if (!outRoot) throw new Error("usage: node tools/fetch-train-sets.mjs <outRoot> [targetSets] [songsRoot]");
const TARGET = Number(targetArg);
const LEVELS = Array.from({ length: 18 }, (_, i) => i + 1); // dan 1 … Theta
const PAGES_PER_LEVEL = 16; // 48 sets a page
const CONCURRENCY = Math.max(1, Math.min(8, Number(lanesArg) || 4));
const PAUSE_MS = 400;
// Measured: osu.direct ~10 MB/s per connection, sayobot ~0.3 MB/s (far away), beatconnect refusing at the time.
const MIRROR_ORDER = ["osu.direct", "dl.sayobot.cn", "beatconnect.io"].map((host) => MIRRORS.find((m) => m.host === host)).filter(Boolean);
const KEEP = /\.(osu|mp3|ogg|wav)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- choose the sets ----------------------------------------------------------------------------
async function localSetIds() {
    const ids = new Set();
    for (const name of await readdir(songsRoot).catch(() => [])) {
        const m = /^(\d+)\s/.exec(name);
        if (m) ids.add(Number(m[1]));
    }
    return ids;
}

async function chooseSets() {
    const file = path.join(outRoot, "manifest.json");
    const existing = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (existing?.sets?.length) return existing.sets;
    const api = createTrackerApi({ timeoutMs: 30000 });
    const local = await localSetIds();
    log(`local sets in Songs: ${local.size}`);
    const bySet = new Map();
    const perLevel = new Map(); // level → set ids in playcount order
    for (const level of LEVELS) {
        const order = [];
        for (let page = 0; page < PAGES_PER_LEVEL; page++) {
            const res = await api.searchMaps({
                sort: "playcount", dir: "desc", page, pageSize: 48, keys: "4k", vibro: "hide", lnMax: 15,
                danMin: level, danMax: level,
            }).catch((e) => { log(`search dan ${level} page ${page}: ${e.message}`); return null; });
            await sleep(1200);
            if (!res?.items?.length) break;
            for (const item of res.items) {
                const setId = item.beatmapsetId;
                if (!setId || local.has(setId)) continue;
                const entry = bySet.get(setId) ?? { setId, title: `${item.artist} - ${item.title}`, playCount: 0, diffs: new Map() };
                for (const d of item.diffs?.length ? item.diffs : [item]) {
                    if (d.keyCount !== 4 || !Number.isFinite(d.dan?.rawDan)) continue;
                    entry.diffs.set(d.beatmapId, {
                        beatmapId: d.beatmapId, version: d.version, dan: d.dan.rawDan, primary: d.primaryPattern ?? null,
                        patterns: d.patterns ?? null, msd: d.msd ?? null, lnShare: d.lnShare ?? 0,
                    });
                    entry.playCount = Math.max(entry.playCount, Number(d.playCount) || 0);
                }
                bySet.set(setId, entry);
                order.push(setId);
            }
            if (res.items.length < 48) break;
        }
        perLevel.set(level, [...new Set(order)]);
        log(`dan ${level}: ${perLevel.get(level).length} candidate sets`);
    }
    // round-robin over the dan levels so every level gets its share, most played first
    const chosen = [];
    const taken = new Set();
    for (let rank = 0; chosen.length < TARGET; rank++) {
        let any = false;
        for (const level of LEVELS) {
            const id = perLevel.get(level)[rank];
            if (id === undefined) continue;
            any = true;
            if (taken.has(id)) continue;
            taken.add(id);
            chosen.push(id);
            if (chosen.length >= TARGET) break;
        }
        if (!any) break;
    }
    const sets = chosen.map((id) => {
        const e = bySet.get(id);
        return { setId: id, title: e.title, playCount: e.playCount, diffs: [...e.diffs.values()] };
    });
    await mkdir(outRoot, { recursive: true });
    await writeFile(file, JSON.stringify({ made: new Date().toISOString(), target: TARGET, sets }), "utf8");
    log(`manifest: ${sets.length} sets, ${sets.reduce((s, x) => s + x.diffs.length, 0)} labelled diffs`);
    return sets;
}

// ---- unzip only what training needs ---------------------------------------------------------------
function unzipEntries(buf) {
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("not a zip");
    const count = buf.readUInt16LE(eocd + 10);
    // Some packers write a wrong directory offset (data glued in front); the directory always ends at the EOCD,
    // so take its real start from its size and shift every local header offset by the same amount.
    const declared = buf.readUInt32LE(eocd + 16);
    const actual = eocd - buf.readUInt32LE(eocd + 12);
    const shift = buf.readUInt32LE(declared) === 0x02014b50 ? 0 : actual - declared;
    let p = declared + shift;
    const out = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42) + shift;
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
        p += 46 + nameLen + extraLen + commentLen;
        if (!KEEP.test(name)) continue;
        // names come from a download: no absolute paths, no "..", no drive letters
        const parts = name.replace(/\\/g, "/").split("/").filter(Boolean);
        if (!parts.length || parts.some((s) => s === ".." || /[:]/.test(s))) continue;
        const lNameLen = buf.readUInt16LE(local + 26);
        const lExtraLen = buf.readUInt16LE(local + 28);
        const start = local + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compSize);
        const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
        if (data) out.push({ name: parts.join("/"), data });
    }
    return out;
}

// ---- mirror limits ------------------------------------------------------------------------------
// A mirror that answers 429 is left alone until its own reset time (osu.direct: a daily budget of 200 sets / 8 GB,
// x-download-budget-reset in unix seconds; others: Retry-After), instead of being asked again for every set.
const blockedUntil = new Map(); // host → ms
function limitedFetch(url, options) {
    const host = new URL(url).host;
    if ((blockedUntil.get(host) ?? 0) > Date.now()) return Promise.resolve(new Response("waiting for the mirror's limit to reset", { status: 429 }));
    return fetch(url, options).then((res) => {
        if (res.status === 429) {
            const reset = Number(res.headers.get("x-download-budget-reset"));
            const remaining = res.headers.get("x-download-budget-remaining");
            const retry = Number(res.headers.get("retry-after"));
            const until = remaining === "0" && reset > 0 ? reset * 1000 : Date.now() + (retry > 0 ? retry * 1000 : 10 * 60_000);
            if ((blockedUntil.get(host) ?? 0) < until) {
                blockedUntil.set(host, until);
                log(`${host} is limiting us; back at ${new Date(until).toISOString().slice(0, 16)}Z`);
            }
        }
        return res;
    });
}

// ---- download loop ------------------------------------------------------------------------------
async function main() {
    const sets = await chooseSets();
    const stateFile = path.join(outRoot, "state.jsonl");
    const done = new Set((await readFile(stateFile, "utf8").catch(() => "")).split("\n").filter(Boolean)
        .map((l) => JSON.parse(l)).filter((s) => s.ok || s.final).map((s) => s.setId));
    const todo = sets.filter((s) => !done.has(s.setId));
    log(`${done.size} already done, ${todo.length} to fetch`);
    const oszDir = path.join(outRoot, "osz");
    let next = 0;
    let finished = 0;
    let bytes = 0;
    async function lane(k) {
        while (next < todo.length) {
            const s = todo[next++];
            const downloader = createDownloader({ dir: oszDir, mirrors: MIRROR_ORDER, fetchImpl: limitedFetch });
            const record = { setId: s.setId };
            try {
                const r = await downloader.download({ beatmapsetId: s.setId, artist: "", title: "" });
                const files = unzipEntries(await readFile(r.file));
                const dir = path.join(outRoot, "sets", String(s.setId));
                for (const f of files) {
                    const target = path.join(dir, ...f.name.split("/"));
                    await mkdir(path.dirname(target), { recursive: true });
                    await writeFile(target, f.data);
                }
                const size = (await stat(r.file)).size;
                await rm(r.file, { force: true }); // the extracted files are kept, the .osz is not needed
                Object.assign(record, { ok: true, mirror: r.mirror, bytes: size, files: files.length });
                bytes += size;
            } catch (error) {
                const all = error?.details?.join("; ") ?? error?.message;
                // a set every mirror refuses is final; network trouble is tried again on the next run
                Object.assign(record, { ok: false, final: /404|не \.osz|not an \.osz/i.test(all ?? ""), error: String(all).slice(0, 300) });
            }
            await appendFile(stateFile, `${JSON.stringify(record)}\n`, "utf8");
            finished++;
            if (finished % 20 === 0 || !record.ok) {
                log(`lane ${k}: ${finished}/${todo.length} (${(bytes / 1e9).toFixed(1)} GB) ${record.ok ? "" : `failed ${s.setId}: ${record.error}`}`);
            }
            await sleep(PAUSE_MS);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, k) => lane(k)));
    log(`done: ${finished} sets this run, ${(bytes / 1e9).toFixed(1)} GB`);
}

await main();
