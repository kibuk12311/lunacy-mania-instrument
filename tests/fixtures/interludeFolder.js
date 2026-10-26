// A fake portable Interlude folder in a temp directory for tests: Interlude.exe (an empty file), Songs\charts.db with
// the charts table of prelude/src/Data/ChartDatabase/DbCharts.fs, Songs\.assets (audio and background by hash),
// Songs\.origins (an imported .osu), Data\scores.db (the scores table of DbScores.fs) and, if asked, collections.json.
// The databases are made in WAL mode like Interlude's own. Only synthetic charts (tests/fixtures/makeChart.js).
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { osuToChart, chartHash, encodeChart, osuMd5 } from "../../src/interlude/chart.js";

const sha = (b) => createHash("sha256").update(b).digest("hex").toUpperCase();

// charts: [{ hash (instead of the one the chart gets), osuText (its Title/Artist/Version/Creator lines are set to the ones given), title, artist, version, creator, beatmapId, beatmapsetId, keepOriginal, audio: Buffer,
// background: Buffer, origins }]; plays: [{ index (of charts), at, rate }]; collections: text of collections.json.
export async function makeInterludeFolder({ charts = [], plays = [], collections = null } = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "interlude-"));
    await mkdir(path.join(root, "Songs", ".assets"), { recursive: true });
    await mkdir(path.join(root, "Data"), { recursive: true });
    await writeFile(path.join(root, "Interlude.exe"), "");
    const db = new DatabaseSync(path.join(root, "Songs", "charts.db"));
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec(`CREATE TABLE charts (
        Id TEXT PRIMARY KEY NOT NULL, Title TEXT NOT NULL, TitleNative TEXT, Artist TEXT NOT NULL, ArtistNative TEXT,
        DifficultyName TEXT NOT NULL, Subtitle TEXT, Source TEXT, Creator TEXT NOT NULL, Tags TEXT NOT NULL,
        Background TEXT NOT NULL, Audio TEXT NOT NULL, PreviewTime REAL NOT NULL, Packs TEXT NOT NULL, Origin TEXT NOT NULL,
        Keys INTEGER NOT NULL, Length REAL NOT NULL, BPM INTEGER NOT NULL, DateAdded INTEGER NOT NULL,
        CalcVersion INTEGER NOT NULL, Rating REAL NOT NULL, Patterns TEXT NOT NULL, Chart BLOB NOT NULL)`);
    const insert = db.prepare(`INSERT INTO charts VALUES (?, ?, NULL, ?, NULL, ?, NULL, NULL, ?, '[]', json(?), json(?), ?,
        '["osu!"]', json(?), ?, ?, ?, ?, 5, ?, '{}', ?)`);
    const out = [];
    for (const [i, raw] of charts.entries()) {
        // the .osu carries the same metadata Interlude shows (it took it from there)
        const meta = { Title: raw.title ?? `Song ${i}`, Artist: raw.artist ?? "Artist", Version: raw.version ?? "4K Hard", Creator: raw.creator ?? "Mapper" };
        const osuText = Object.entries(meta).reduce((text, [k, v]) => text.replace(new RegExp(`^${k}:.*$`, "m"), `${k}:${v}`), raw.osuText);
        const c = { ...raw, osuText, ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [k.toLowerCase(), v])) };
        const chart = osuToChart(c.osuText);
        const hash = c.hash ?? chartHash(chart); // a given id: to match a recorded reader line ("hashA" of the fake Interlude)
        const asset = async (bytes) => {
            if (!bytes) return '"Missing"';
            const h = sha(bytes);
            await mkdir(path.join(root, "Songs", ".assets", h.slice(0, 2)), { recursive: true });
            await writeFile(path.join(root, "Songs", ".assets", h.slice(0, 2), h), bytes);
            return JSON.stringify({ Hash: h });
        };
        const origins = c.origins ?? [{ Osu: {
            Md5: osuMd5(Buffer.from(c.osuText, "utf8")), BeatmapSetId: c.beatmapsetId ?? -1, BeatmapId: c.beatmapId ?? 0,
            SourceRate: 1.0, SourceOD: 8.0, FirstNoteOffset: chart.notes[0].time,
        } }];
        if (c.keepOriginal) {
            await mkdir(path.join(root, "Songs", ".origins", hash.slice(0, 2)), { recursive: true });
            await writeFile(path.join(root, "Songs", ".origins", hash.slice(0, 2), `${hash}.osu`), c.osuText, "utf8");
        }
        insert.run(hash, c.title, c.artist, c.version, c.creator,
            await asset(c.background), await asset(c.audio), 1000, JSON.stringify(origins), chart.keys,
            chart.notes.at(-1).time - chart.notes[0].time, 180, 1_700_000_000_000 + i, 20.5, encodeChart(chart));
        out.push({ hash, chart, osuText: c.osuText, md5: osuMd5(Buffer.from(c.osuText, "utf8")) });
    }
    db.close();
    const scores = new DatabaseSync(path.join(root, "Data", "scores.db"));
    scores.exec("PRAGMA journal_mode=WAL;");
    scores.exec(`CREATE TABLE scores (Id INTEGER PRIMARY KEY NOT NULL, ChartId TEXT NOT NULL, Timestamp INTEGER NOT NULL,
        Replay BLOB NOT NULL, Rate REAL NOT NULL, Mods TEXT NOT NULL, IsImported INTEGER NOT NULL, Keys INTEGER NOT NULL,
        IsFailed INTEGER NOT NULL DEFAULT 0)`);
    const score = scores.prepare("INSERT INTO scores (ChartId, Timestamp, Replay, Rate, Mods, IsImported, Keys) VALUES (?, ?, x'00', ?, '{}', 0, 4)");
    for (const p of plays) score.run(out[p.index].hash, p.at, p.rate ?? 1);
    scores.close();
    if (collections !== null) await writeFile(path.join(root, "Data", "collections.json"), collections, "utf8");
    return { root, charts: out };
}
