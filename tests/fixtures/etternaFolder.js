// An invented Etterna install for tests: Songs/<pack>/<song>/ with .sm or .ssc text and a stub audio file, songs
// without a pack, AdditionalSongs/, Save/Preferences.ini, and Cache/cache.db in the shape Etterna 0.75 writes it
// (dbinfo VERSION 248; steps with STEPFILENAME from the install root, CHARTKEY "X" + 40 hex, MSD as 14 rates of 8).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// four measures of a one-note-a-beat stream, or with a hold from the first beat
function notes(measures, hold) {
    const one = (m) => (hold && m === 0 ? ["2000", "0100", "3010", "0001"] : ["1000", "0100", "0010", "0001"]).join("\n");
    return Array.from({ length: measures }, (_, m) => one(m)).join("\n,\n");
}

// one #NOTES block of an .sm
export function smChart({ type = "dance-single", difficulty = "Hard", meter = 10, credit = "Charter", measures = 4, hold = false } = {}) {
    return `#NOTES:\n     ${type}:\n     ${credit}:\n     ${difficulty}:\n     ${meter}:\n     0,0,0,0,0:\n${notes(measures, hold)}\n;\n`;
}

// a whole .sm: a song's tags, then its charts
export function smText({ title = "Song", artist = "Artist", offset = "0.000", bpms = "0.000=120.000", warps = "", charts = [smChart()] } = {}) {
    return [
        `#TITLE:${title};`, `#ARTIST:${artist};`, `#MUSIC:audio.ogg;`, `#OFFSET:${offset};`, `#BPMS:${bpms};`,
        `#STOPS:;`, ...(warps ? [`#WARPS:${warps};`] : []), "", ...charts,
    ].join("\n");
}

// a whole .ssc with the same charts
export function sscText({ title = "Song", artist = "Artist", offset = "0.000", bpms = "0.000=120.000", charts = [{}] } = {}) {
    const blocks = charts.map(({ type = "dance-single", difficulty = "Hard", meter = 10, credit = "Charter", measures = 4, hold = false }) => [
        "#NOTEDATA:;", `#STEPSTYPE:${type};`, `#DIFFICULTY:${difficulty};`, `#METER:${meter};`, `#CREDIT:${credit};`,
        `#NOTES:\n${notes(measures, hold)}\n;`, "",
    ].join("\n"));
    return [`#VERSION:0.83;`, `#TITLE:${title};`, `#ARTIST:${artist};`, `#MUSIC:audio.ogg;`, `#OFFSET:${offset};`, `#BPMS:${bpms};`, "", ...blocks].join("\n");
}

// MSD text for one chart: 14 rates (0.7x … 2.0x) of 8 numbers, Overall first, growing with the rate
export function msdText(overallAtOne) {
    return Array.from({ length: 14 }, (_, i) => {
        const o = overallAtOne * (0.7 + i * 0.1);
        return [o, o - 1, o - 2, o - 3, o - 4, o - 5, o - 6, o - 7].map((v) => v.toFixed(2)).join(",");
    }).join(":");
}

// A song folder: files { name: text } beside a stub audio.ogg
async function song(dir, files) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "audio.ogg"), "not really audio");
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
}

// root: an empty folder. songs: [{ at: "Songs/Pack A/Song 1", files: { "Song 1.sm": text } }]; cache: null (no cache),
// or { version = 248, steps: [{ file: "/Songs/Pack A/Song 1/Song 1.sm", type = "dance-single", key, msd, meter }] };
// additionalFolders: absolute paths written to Save/Preferences.ini.
export async function makeEtternaFolder(root, { songs = [], cache = null, additionalFolders = [], sqlite } = {}) {
    await mkdir(path.join(root, "Songs"), { recursive: true });
    await mkdir(path.join(root, "Program"), { recursive: true });
    await writeFile(path.join(root, "Program", "Etterna.exe"), "not really the game");
    for (const s of songs) await song(path.join(root, ...s.at.split("/")), s.files);
    await mkdir(path.join(root, "Save"), { recursive: true });
    await writeFile(path.join(root, "Save", "Preferences.ini"), `[Options]\r\nAdditionalSongFolders=${additionalFolders.join(",")}\r\nVsync=1\r\n`);
    if (cache) {
        await mkdir(path.join(root, "Cache"), { recursive: true });
        const { DatabaseSync } = sqlite ?? (await import("node:sqlite"));
        const db = new DatabaseSync(path.join(root, "Cache", "cache.db"));
        db.exec("CREATE TABLE dbinfo (ID INTEGER PRIMARY KEY, VERSION INTEGER)");
        db.exec("CREATE TABLE songs (ID INTEGER PRIMARY KEY, TITLE TEXT, DIR TEXT)");
        db.exec("CREATE TABLE steps (id INTEGER PRIMARY KEY, CHARTNAME TEXT, STEPSTYPE TEXT, DIFFICULTY INTEGER, METER INTEGER, MSD TEXT, CHARTKEY TEXT, STEPFILENAME TEXT, SONGID INTEGER)");
        db.prepare("INSERT INTO dbinfo VALUES (1, ?)").run(cache.version ?? 248);
        const insert = db.prepare("INSERT INTO steps (CHARTNAME, STEPSTYPE, DIFFICULTY, METER, MSD, CHARTKEY, STEPFILENAME, SONGID) VALUES ('', ?, 4, ?, ?, ?, ?, 1)");
        for (const s of cache.steps ?? []) insert.run(s.type ?? "dance-single", s.meter ?? null, s.msd ?? "", s.key ?? "", s.file);
        db.close();
    }
    return root;
}
