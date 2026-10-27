// The shared result cache's folder: userData\results-<analyzer fingerprint> (src/core/analyzerVersion.js), so an app
// update that leaves the analysis alone keeps every saved result. Up to 0.9.9 the folder was named by the app version
// (results-0.9.9). A version whose release had today's fingerprint (src/core/analyzerReleases.js) holds answers this
// analyzer would give itself: the newest such folder is renamed into place, the results of the others are moved in
// where missing (renamed one by one, never copied). The other old results-<x.y.z> folders are removed. tidy: false
// (a dev run, which shares userData with the installed app, or a start that could not read its own files) renames,
// moves and removes nothing. A results-<16 hex> folder of another analyzer is never removed: the installed app and a
// portable copy of another version share userData too, and each would wipe the other's results.
// Failures are logged and never stop the app.
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { RELEASE_FINGERPRINTS } from "../src/core/analyzerReleases.js";

const VERSION_DIR = /^results-(\d+)\.(\d+)\.(\d+)$/;
const FINGERPRINT_DIR = /^results-[0-9a-f]{16}$/;

export const resultsDirName = (fingerprint) => `results-${fingerprint}`;
// a folder of the app's results, of any version or analyzer
export const isResultsDir = (name) => VERSION_DIR.test(name) || FINGERPRINT_DIR.test(name);
const versionOf = (name) => VERSION_DIR.exec(name)?.slice(1).map(Number) ?? null;
const newestFirst = (a, b) => {
    const [x, y] = [versionOf(a), versionOf(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

// → { dir, done }: dir is ready at once (the newest folder of the same analyzer renamed into place, else new);
// done settles once the others' results are moved in and the rest removed (in the background: thousands of files).
export async function prepareResultsDir({
    userData, fingerprint, releases = RELEASE_FINGERPRINTS, fs = nodeFs, log = () => {}, tidy = true,
}) {
    const name = resultsDirName(fingerprint);
    const dir = path.join(userData, name);
    if (!tidy) return { dir, done: Promise.resolve() };
    let entries;
    try {
        entries = await fs.readdir(userData, { withFileTypes: true });
    } catch {
        return { dir, done: Promise.resolve() }; // a first start: no userData yet
    }
    const folders = entries.filter((e) => e.isDirectory() && isResultsDir(e.name) && e.name !== name).map((e) => e.name);
    const sameAnalyzer = (n) => VERSION_DIR.test(n) && releases[n.slice("results-".length)] === fingerprint;
    const same = folders.filter(sameAnalyzer).sort(newestFirst);
    const others = folders.filter((n) => VERSION_DIR.test(n) && !same.includes(n)); // the old per-version folders only
    let stuck = false; // the newest would not rename: the same analyzer's folders all stay for the next start
    if (same.length && !entries.some((e) => e.name === name)) {
        const newest = same.shift();
        try {
            await fs.rename(path.join(userData, newest), dir);
            log(`analysis results: ${newest} kept as ${name} (same analyzer)`);
        } catch (error) {
            stuck = true;
            log(`analysis results: could not keep ${newest} as ${name}: ${error?.message}`);
        }
    }
    const done = (async () => {
        for (const from of stuck ? [] : same) {
            const moved = await moveMissing(fs, path.join(userData, from), dir);
            log(`analysis results: ${moved} kept from ${from} (same analyzer)`);
        }
        const removed = [];
        for (const old of stuck ? others : [...same, ...others]) {
            try {
                await fs.rm(path.join(userData, old), { recursive: true, force: true });
                removed.push(old);
            } catch (error) {
                log(`analysis results: could not remove ${old}: ${error?.message}`);
            }
        }
        if (removed.length) log(`analysis results: removed ${removed.join(", ")}`);
    })().catch((error) => log(`analysis results: tidying failed: ${error?.message}`));
    return { dir, done };
}

// Each file of `from` that `to` lacks renamed into `to` → how many; the same analyzer wrote both, so either will do.
async function moveMissing(fs, from, to) {
    let names = [];
    try {
        await fs.mkdir(to, { recursive: true });
        names = await fs.readdir(from);
    } catch {
        return 0;
    }
    const there = new Set(await fs.readdir(to).catch(() => []));
    let moved = 0;
    for (const file of names) {
        if (there.has(file)) continue;
        try {
            await fs.rename(path.join(from, file), path.join(to, file));
            moved += 1;
        } catch {
            // a result written meanwhile, or a file in use: the folder goes anyway
        }
    }
    return moved;
}
