// A tiny fake osu! lazer database: the same rows as plain realm-like objects (lazerRows, for src/lazer/realmDump.js on
// fakes) and as a real client.realm with lazer's class and field names (writeLazerRealm). Run as a script
// (`node tests/fixtures/lazerRealm.js <file>`) it writes that realm and exits: realm keeps a process alive on its own.
// Only made-up data: the player is TestPlayer (1234567), the maps are "Fake …".
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sha = (label) => createHash("sha256").update(`lazer fixture ${label}`).digest("hex");
export const md5 = (label) => createHash("md5").update(`lazer fixture ${label}`).digest("hex");
export const PLAYER = Object.freeze({ Username: "TestPlayer", OnlineID: 1234567 });
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const day = (n) => new Date(Date.UTC(2026, 0, n, 12, 0, 0));

// lazer's classes, as far as the reader and a realistic file need them (osu.Game Beatmap/Score models, schema 52)
export const SCHEMA = [
    { name: "Ruleset", primaryKey: "ShortName", properties: { ShortName: "string", OnlineID: { type: "int", default: -1 }, Name: "string?", Available: { type: "bool", default: true } } },
    { name: "File", primaryKey: "Hash", properties: { Hash: "string" } },
    { name: "RealmNamedFileUsage", embedded: true, properties: { File: "File?", Filename: "string?" } },
    { name: "RealmUser", embedded: true, properties: { OnlineID: { type: "int", default: 1 }, Username: "string?", CountryCode: "string?" } },
    {
        name: "BeatmapMetadata",
        properties: {
            Title: "string?", Artist: "string?", Author: "RealmUser?", Source: "string?", Tags: "string?",
            PreviewTime: { type: "int", default: -1 }, AudioFile: "string?", BackgroundFile: "string?",
        },
    },
    { name: "BeatmapDifficulty", embedded: true, properties: { CircleSize: { type: "float", default: 5 }, OverallDifficulty: { type: "float", default: 8 } } },
    {
        name: "BeatmapSet",
        primaryKey: "ID",
        properties: {
            ID: "uuid", OnlineID: { type: "int", default: -1 }, DateAdded: "date?", Beatmaps: "Beatmap[]",
            Files: "RealmNamedFileUsage[]", DeletePending: { type: "bool", default: false }, Hash: "string?",
            Protected: { type: "bool", default: false },
        },
    },
    {
        name: "Beatmap",
        primaryKey: "ID",
        properties: {
            ID: "uuid", DifficultyName: "string?", Ruleset: "Ruleset?", Difficulty: "BeatmapDifficulty?", Metadata: "BeatmapMetadata?",
            BeatmapSet: "BeatmapSet?", OnlineID: { type: "int", default: -1 }, Length: { type: "double", default: 0 },
            BPM: { type: "double", default: 0 }, Hash: "string?", StarRating: { type: "double", default: -1 }, MD5Hash: "string?",
            Hidden: { type: "bool", default: false },
        },
    },
    {
        name: "Score",
        primaryKey: "ID",
        properties: {
            ID: "uuid", BeatmapInfo: "Beatmap?", BeatmapHash: "string?", Ruleset: "Ruleset?", Files: "RealmNamedFileUsage[]",
            Hash: "string?", DeletePending: { type: "bool", default: false }, TotalScore: { type: "int", default: 0 },
            MaxCombo: { type: "int", default: 0 }, Accuracy: { type: "double", default: 0 }, Date: "date",
            OnlineID: { type: "int", default: -1 }, User: "RealmUser?", Mods: "string?", Statistics: "string?", Rank: { type: "int", default: 0 },
        },
    },
];

// The rows: plain objects linked like realm's. Expected by the tests:
// maps "4k" (all fields), "7k" (no online ids, no background) and "solo" (a set without an online id) are kept;
// "std" (other ruleset), "hidden" and "deleting" (its set is DeletePending) are not.
// scores "dt13" (DT at 1.3 + CL), "gone" (its map deleted, NC, failed), "wind" (WU: no rate), "ht" (HT default),
// "convert" (a mania play on an osu! map: keys unknown), "updated" (played on a version of the map lazer has replaced
// since: md5 and keys unknown) are kept; "std" and "pending" are not.
export function lazerRows() {
    const mania = { ShortName: "mania", OnlineID: 3, Name: "osu!mania" };
    const osu = { ShortName: "osu", OnlineID: 0, Name: "osu!" };
    const file = (label) => ({ Hash: sha(label) });
    const use = (f, Filename) => ({ File: f, Filename });
    const author = { OnlineID: 7654321, Username: "TestMapper" };
    const meta = (title, extra = {}) => ({ Title: title, Artist: "Fake Artist", Author: author, Tags: "fake test", AudioFile: "audio.mp3", ...extra });
    const files = {
        audio: file("audio"), bg: file("bg"), osu4k: file("osu 4k"), osu7k: file("osu 7k"), osuStd: file("osu std"),
        osuHidden: file("osu hidden"), audio2: file("audio 2"), osuDeleting: file("osu deleting"), audio3: file("audio 3"), osuSolo: file("osu solo"),
    };
    const setMain = {
        ID: uuid(1), OnlineID: 100, DeletePending: false,
        Files: [use(files.audio, "audio.mp3"), use(files.bg, "bg/BG.jpg"), use(files.osu4k, "a [4K].osu"), use(files.osu7k, "a [7K].osu"),
            use(files.osuStd, "a [std].osu"), use(files.osuHidden, "a [hidden].osu")],
    };
    const setDeleting = { ID: uuid(2), OnlineID: 200, DeletePending: true, Files: [use(files.audio2, "audio.mp3"), use(files.osuDeleting, "b.osu")] };
    const setSolo = { ID: uuid(3), OnlineID: -1, DeletePending: false, Files: [use(files.audio3, "song.ogg"), use(files.osuSolo, "c.osu")] };
    const metaMain = meta("Fake Song", { BackgroundFile: "bg\\bg.jpg" });
    const beatmap = (n, label, extra) => ({
        ID: uuid(100 + n), DifficultyName: label, Ruleset: mania, Difficulty: { CircleSize: 4, OverallDifficulty: 8 }, Metadata: metaMain,
        BeatmapSet: setMain, OnlineID: 1000 + n, Hash: sha(`osu ${label}`), MD5Hash: md5(`osu ${label}`), Hidden: false, Length: 90_000, BPM: 180,
        ...extra,
    });
    const beatmaps = {
        "4k": beatmap(1, "4k"),
        "7k": beatmap(2, "7k", { Difficulty: { CircleSize: 7, OverallDifficulty: 8 }, OnlineID: 0, Metadata: meta("Fake Song") }),
        std: beatmap(3, "std", { Ruleset: osu, Difficulty: { CircleSize: 4, OverallDifficulty: 8 } }),
        hidden: beatmap(4, "hidden", { Hidden: true }),
        deleting: beatmap(5, "deleting", { BeatmapSet: setDeleting, Metadata: meta("Fake Gone") }),
        solo: beatmap(6, "solo", { BeatmapSet: setSolo, OnlineID: -1, Metadata: meta("Fake Solo", { AudioFile: "SONG.ogg" }) }),
    };
    const stats = (perfect, great, good, ok, meh, miss) => JSON.stringify({ perfect, great, good, ok, meh, miss, ignore_hit: 9, combo_break: 1 });
    const score = (n, map, extra) => ({
        ID: uuid(200 + n), BeatmapInfo: map, BeatmapHash: map?.Hash ?? null, Ruleset: mania, DeletePending: false, TotalScore: 900_000,
        MaxCombo: 1234, Accuracy: 0.9876, Date: day(n), Rank: 5, User: PLAYER, Mods: "", Statistics: stats(800, 300, 20, 5, 2, 3), ...extra,
    });
    const scores = {
        dt13: score(1, beatmaps["4k"], { Mods: JSON.stringify([{ acronym: "DT", settings: { speed_change: 1.3 } }, { acronym: "CL" }]) }),
        gone: score(2, null, { BeatmapHash: sha("osu removed"), Mods: "[{\"acronym\":\"NC\"}]", Rank: -1, Accuracy: 0.71 }),
        wind: score(3, beatmaps["4k"], { Mods: "[{\"acronym\":\"WU\",\"settings\":{\"initial_rate\":1,\"final_rate\":1.5}}]" }),
        ht: score(4, beatmaps["7k"], { Mods: "[{\"acronym\":\"HT\"}]", Rank: 7, Accuracy: 1 }),
        convert: score(5, beatmaps.std),
        std: score(6, beatmaps["4k"], { Ruleset: osu }),
        pending: score(7, beatmaps["4k"], { DeletePending: true }),
        updated: score(8, beatmaps["4k"], { BeatmapHash: sha("osu 4k before its update") }),
    };
    return { rulesets: [mania, osu], files: Object.values(files), sets: [setMain, setDeleting, setSolo], beatmaps, scores };
}

// Writes lazerRows() as a realm file with lazer's class names. Realm: the realm package's default export.
export function writeLazerRealm(Realm, file) {
    const { UUID } = Realm.BSON;
    const rows = lazerRows();
    const made = new Map(); // fake row → its realm object
    const realm = new Realm({ path: file, schema: SCHEMA, schemaVersion: 52 });
    const link = (row) => made.get(row) ?? null;
    realm.write(() => {
        for (const r of rows.rulesets) made.set(r, realm.create("Ruleset", r));
        for (const f of rows.files) made.set(f, realm.create("File", f));
        const usages = (list) => list.map((u) => ({ File: link(u.File), Filename: u.Filename }));
        for (const s of rows.sets) made.set(s, realm.create("BeatmapSet", { ...s, ID: new UUID(s.ID), Files: usages(s.Files) }));
        const metas = new Map();
        for (const b of Object.values(rows.beatmaps)) {
            if (!metas.has(b.Metadata)) metas.set(b.Metadata, realm.create("BeatmapMetadata", b.Metadata));
            const object = realm.create("Beatmap", {
                ...b, ID: new UUID(b.ID), Ruleset: link(b.Ruleset), BeatmapSet: link(b.BeatmapSet), Metadata: metas.get(b.Metadata),
            });
            made.set(b, object);
            link(b.BeatmapSet).Beatmaps.push(object);
        }
        for (const s of Object.values(rows.scores)) {
            realm.create("Score", { ...s, ID: new UUID(s.ID), BeatmapInfo: link(s.BeatmapInfo), Ruleset: link(s.Ruleset) });
        }
    });
    realm.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) {
    const { default: Realm } = await import("realm");
    let code = 0;
    try {
        writeLazerRealm(Realm, path.resolve(process.argv[2]));
    } catch (error) {
        console.error(error?.stack ?? error);
        code = 1;
    }
    process.exit(code);
}
