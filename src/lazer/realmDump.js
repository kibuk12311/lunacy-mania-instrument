// osu! lazer's database (client.realm, read in app/lazerRealmWorker.js) → the plain maps and scores the app works with.
// Pure: it takes realm-like objects (a Realm's Results, or plain JS objects in tests), reads every property and linked
// object defensively and skips a broken row instead of throwing. Only osu!mania is kept; hidden maps and whatever lazer
// is deleting (DeletePending) are dropped.

// The speed mods' default speeds (as app/tosuClient.js SPEED_RATES); lazer keeps a custom one in settings.speed_change.
const SPEED_DEFAULTS = new Map([["DT", 1.5], ["NC", 1.5], ["HT", 0.75], ["DC", 0.75]]);
// Wind Up, Wind Down and Adaptive Speed change the speed during the play: there is no one rate to analyse it at.
const VARIABLE_SPEED = new Set(["WU", "WD", "AS"]);
// lazer's judgement names in Statistics → the app's hits (as tosu's and the local profile's)
const HIT_KEYS = Object.freeze({ max: "perfect", n300: "great", n200: "good", n100: "ok", n50: "meh", miss: "miss" });
const RANK_FAILED = -1; // ScoreRank.F
const SHA256 = /^[0-9a-f]{64}$/;
const MD5 = /^[0-9a-f]{32}$/;
const MAX_KEYS = 18; // lazer's mania goes up to 10K single stage and 18K dual stage

// A property of a realm object; a row whose link is broken can throw on access, which reads as missing here.
function read(object, key) {
    if (object == null) return undefined;
    try {
        return object[key];
    } catch {
        return undefined;
    }
}

const text = (value) => (value == null ? "" : String(value));
const hashOf = (value, pattern) => {
    const h = typeof value === "string" ? value.trim().toLowerCase() : "";
    return pattern.test(h) ? h : null;
};
const positiveId = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};
const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const isMania = (ruleset) => read(ruleset, "ShortName") === "mania";

// The key count of a mania map: its CircleSize; null when it isn't one.
function keysOf(difficulty) {
    const cs = Number(read(difficulty, "CircleSize"));
    const keys = Math.round(cs);
    return Number.isFinite(cs) && keys >= 1 && keys <= MAX_KEYS ? keys : null;
}

// A realm uuid (BSON UUID, its String() is the dashed hex) or a plain string → lower case; null when empty.
const idOf = (value) => text(value).trim().toLowerCase() || null;

// A Date (or anything Date can read) → ms; null when it isn't a time.
function timeOf(value) {
    const ms = value instanceof Date ? value.getTime() : new Date(value ?? NaN).getTime();
    return Number.isFinite(ms) ? ms : null;
}

// A file name as lazer looks it up in a set (case-insensitive, either slash) → its key; null for none.
function fileKey(name) {
    const s = typeof name === "string" ? name.trim() : "";
    return s ? s.replace(/\\/g, "/").toLowerCase() : null;
}

// rows of a collection; a collection that breaks halfway keeps the rows read before
function* rows(list) {
    if (list == null) return;
    try {
        for (const row of list) yield row;
    } catch {
        // the rest is unreadable
    }
}

// The Mods column: a JSON list [{ acronym, settings? }] ("" for no mods), or that list already parsed →
// [{ acronym (upper case), settings }]; null when it isn't such a list (the row is broken).
export function parseMods(json) {
    let list = json;
    if (list == null || (typeof list === "string" && !list.trim())) return [];
    if (typeof list === "string") {
        try {
            list = JSON.parse(list);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const mod of list) {
        const acronym = typeof mod === "string" ? mod : mod?.acronym;
        if (typeof acronym !== "string" || !acronym.trim()) return null;
        const settings = mod && typeof mod === "object" && mod.settings && typeof mod.settings === "object" ? mod.settings : {};
        out.push({ acronym: acronym.trim().toUpperCase(), settings });
    }
    return out;
}

// The Mods column → the acronyms in upper case (["DT", "CL"]); null when the column is broken.
export function modsOf(json) {
    return parseMods(json)?.map((m) => m.acronym) ?? null;
}

// The play's rate from its mods (the JSON column, or parseMods' list): DT/NC at settings.speed_change ?? 1.5, HT/DC at
// ?? 0.75, to 0.01; 1 without a speed mod; null for a variable speed (WU, WD, AS) or a broken column.
export function lazerRate(mods) {
    const list = parseMods(mods);
    if (!list || list.some((m) => VARIABLE_SPEED.has(m.acronym))) return null;
    const speed = list.find((m) => SPEED_DEFAULTS.has(m.acronym));
    if (!speed) return 1;
    const custom = Number(speed.settings.speed_change);
    const rate = Number.isFinite(custom) && custom > 0 ? custom : SPEED_DEFAULTS.get(speed.acronym);
    return Math.round(rate * 100) / 100;
}

// The Statistics column (JSON or already parsed) → { max, n300, n200, n100, n50, miss }; other judgements are left out.
// null when it isn't a JSON object (the row is broken).
export function hitsOf(statistics) {
    let stats = statistics;
    if (typeof stats === "string") {
        try {
            stats = JSON.parse(stats);
        } catch {
            return null;
        }
    }
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) return null;
    return Object.fromEntries(Object.entries(HIT_KEYS).map(([ours, theirs]) => [ours, count(stats[theirs])]));
}

// The files of a set by name → their hashes, kept per set id (the difficulties of a set share them).
function setFiles(set, bySet) {
    const id = text(read(set, "ID"));
    if (id && bySet.has(id)) return bySet.get(id);
    const named = new Map();
    for (const usage of rows(read(set, "Files"))) {
        const name = fileKey(read(usage, "Filename"));
        const hash = hashOf(read(read(usage, "File"), "Hash"), SHA256);
        if (name && hash && !named.has(name)) named.set(name, hash);
    }
    if (id) bySet.set(id, named);
    return named;
}

// One Beatmap row → a LazerMap, or null when it isn't a visible mania map of a set that stays (or is broken).
function mapOf(beatmap, bySet) {
    if (!isMania(read(beatmap, "Ruleset")) || read(beatmap, "Hidden") === true) return null;
    const set = read(beatmap, "BeatmapSet");
    if (!set || read(set, "DeletePending") === true) return null;
    const hash = hashOf(read(beatmap, "Hash"), SHA256);
    const md5 = hashOf(read(beatmap, "MD5Hash"), MD5);
    const keys = keysOf(read(beatmap, "Difficulty"));
    if (!hash || !md5 || !keys) return null;
    const meta = read(beatmap, "Metadata");
    const named = setFiles(set, bySet);
    return {
        hash,
        md5,
        keys,
        artist: text(read(meta, "Artist")),
        title: text(read(meta, "Title")),
        version: text(read(beatmap, "DifficultyName")),
        creator: text(read(read(meta, "Author"), "Username")),
        tags: text(read(meta, "Tags")),
        beatmapId: positiveId(read(beatmap, "OnlineID")),
        setId: positiveId(read(set, "OnlineID")),
        audio: named.get(fileKey(read(meta, "AudioFile"))) ?? null,
        background: named.get(fileKey(read(meta, "BackgroundFile"))) ?? null,
    };
}

// One Score row → a LazerScore, or null when it isn't a mania play that stays (or is broken). md5 and keys come from
// its map, null once the map is gone or was updated since (another chart than the one played); keys also null on a
// converted map (its CircleSize isn't a key count).
function scoreOf(score) {
    if (!isMania(read(score, "Ruleset")) || read(score, "DeletePending") === true) return null;
    const linked = read(score, "BeatmapInfo") ?? null;
    const mapHash = hashOf(read(linked, "Hash"), SHA256);
    const hash = hashOf(read(score, "BeatmapHash"), SHA256) ?? mapHash;
    const map = linked && mapHash === hash ? linked : null;
    const id = idOf(read(score, "ID"));
    const at = timeOf(read(score, "Date"));
    const mods = parseMods(read(score, "Mods"));
    const hits = hitsOf(read(score, "Statistics"));
    if (!hash || !id || at == null || !mods || !hits) return null;
    const accuracy = Number(read(score, "Accuracy"));
    return {
        id,
        hash,
        md5: map ? hashOf(read(map, "MD5Hash"), MD5) : null,
        keys: map && isMania(read(map, "Ruleset")) ? keysOf(read(map, "Difficulty")) : null,
        player: text(read(read(score, "User"), "Username")),
        at,
        mods: mods.map((m) => m.acronym),
        rate: lazerRate(mods),
        hits,
        maxCombo: count(read(score, "MaxCombo")),
        accuracy: Number.isFinite(accuracy) ? Math.min(1, Math.max(0, accuracy)) : 0,
        failed: Number(read(score, "Rank")) === RANK_FAILED,
    };
}

// realm.objects("Beatmap") and realm.objects("Score") (or arrays of look-alikes) → { maps: LazerMap[], scores: LazerScore[] }.
// Never throws for a row: a row that can't be read is left out.
export function dumpLazer({ beatmaps = [], scores = [] } = {}) {
    const bySet = new Map();
    const maps = [];
    for (const beatmap of rows(beatmaps)) {
        try {
            const map = mapOf(beatmap, bySet);
            if (map) maps.push(map);
        } catch {
            // a broken row
        }
    }
    const plays = [];
    for (const score of rows(scores)) {
        try {
            const play = scoreOf(score);
            if (play) plays.push(play);
        } catch {
            // a broken row
        }
    }
    return { maps, scores: plays };
}
