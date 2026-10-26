// tosu v4 (websocket API v2) → what the overlay needs. Two feeds:
// /websocket/v2 (about every 100 ms): state, map, mods, live time, judgement counts, accuracy, unstable rate;
// /websocket/v2/precise (about every 10 ms): the clock and the key overlay counters.
// In osu!mania the judgements are: geki = MAX (320), 300, katu = 200, 100, 50, 0 = miss.

const STATES = { 0: "menu", 2: "playing", 5: "songselect", 7: "results" };
const SPEED = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };
const num = (x) => {
    if (x === null || x === undefined || x === "" || typeof x === "boolean") return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
};
const count = (x) => Math.max(0, Math.trunc(num(x) ?? 0));

function rateOf(mods) {
    const reported = num(mods?.rate);
    const codes = Array.isArray(mods?.array) && mods.array.length
        ? mods.array.map((m) => String(m?.acronym ?? m).toUpperCase())
        : (String(mods?.name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").match(/.{1,2}/g) ?? []);
    const speed = codes.find((c) => c in SPEED);
    if (reported && reported > 0 && (reported !== 1 || !speed)) return reported;
    return speed ? SPEED[speed] : 1;
}

export function readHits(hits) {
    return {
        max: count(hits?.geki), n300: count(hits?.["300"]), n200: count(hits?.katu),
        n100: count(hits?.["100"]), n50: count(hits?.["50"]), miss: count(hits?.["0"]),
    };
}

export const totalHits = (h) => h.max + h.n300 + h.n200 + h.n100 + h.n50 + h.miss;

// A /websocket/v2 frame. On the results screen the counts come from resultsScreen when play has none.
export function readPlayFrame(json) {
    const state = STATES[json?.state?.number] ?? "other";
    const play = json?.play ?? {};
    let hits = readHits(play.hits);
    if (state === "results" && totalHits(hits) === 0 && json?.resultsScreen?.hits) hits = readHits(json.resultsScreen.hits);
    const mode = num(play.mode?.number) ?? num(json?.beatmap?.mode?.number) ?? num(json?.menu?.gameMode);
    return {
        state,
        mode, // 3 = mania
        checksum: json?.beatmap?.checksum ? String(json.beatmap.checksum) : null,
        rate: rateOf(play.mods),
        liveMs: num(json?.beatmap?.time?.live),
        hits,
        accuracy: num(play.accuracy),
        ur: num(play.unstableRate),
        hitErrors: Array.isArray(play.hitErrorArray) ? play.hitErrorArray.filter((x) => Number.isFinite(x)) : [],
    };
}

// A /websocket/v2/precise frame: { currentTime, keys: { k1: { isPressed, count }, k2, m1, m2 } }. A future tosu
// with k3/k4 is read as K1–K4; today's one (osu!'s standard key overlay) as K1 K2 M1 M2. null when there are no keys.
export function readPreciseFrame(json) {
    const keys = json?.keys;
    const names = keys && ("k3" in keys || "k4" in keys) ? ["k1", "k2", "k3", "k4"] : ["k1", "k2", "m1", "m2"];
    const list = keys ? names.map((n) => ({ pressed: keys[n]?.isPressed === true, count: count(keys[n]?.count) })) : null;
    return { timeMs: num(json?.currentTime), keys: list && list.some((k, i) => keys[names[i]] !== undefined) ? list : null };
}
