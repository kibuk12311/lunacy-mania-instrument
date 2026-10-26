// Plays as they happen, from tosu's /websocket/v2 frames (osu! stable and lazer alike): one play per pass through
// gameplay, ended by the results screen (a pass), by leaving gameplay (a quit, or a fail when the health bar is
// empty: osu! stable shows its fail screen inside gameplay and then goes back to song select or restarts) or by a
// retry. A results screen opened from song select (a saved score, a replay) is no new play. Watching someone else
// (a replay or spectating: the play's player is not the logged-in one) is never recorded.
// onPlay({ client, md5, beatmapId, beatmapsetId, artist, title, version, rate, mods, hits, accuracy, maxCombo,
//          outcome: "pass" | "fail" | "quit", startedAt, at }).
import { readPlayFrame, totalHits } from "../overlay/tosuData.js";
import { accuracyOf } from "./model.js";

export const LEAVE_MS = 500; // another state must last this long to end a play (one odd frame does not)
export const MIN_HITS = 20; // a play with fewer judgements than this was never really played

const text = (x) => (typeof x === "string" ? x.trim() : "");
const id = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null);
const num = (x) => (x === null || x === undefined || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);

function modsOf(mods) {
    if (Array.isArray(mods?.array) && mods.array.length) return mods.array.map((m) => String(m?.acronym ?? m).toUpperCase());
    return String(mods?.name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").match(/.{1,2}/g) ?? [];
}

// What a frame says beyond the overlay's reading: the map's names and ids, the mods, combo, health, who plays.
export function readRecordFrame(json) {
    const frame = readPlayFrame(json);
    const b = json?.beatmap ?? {};
    const results = json?.resultsScreen ?? {};
    const player = text(json?.play?.playerName) || text(results.playerName);
    const me = text(json?.profile?.name);
    return {
        ...frame,
        beatmapId: id(b.id),
        beatmapsetId: id(b.set),
        artist: text(b.artist),
        title: text(b.title),
        version: text(b.version),
        mods: modsOf(frame.state === "results" && results.mods ? results.mods : json?.play?.mods),
        // on the results screen the score shown there (lazer resets the play)
        maxCombo: frame.state === "results" ? (num(results.maxCombo) ?? num(json?.play?.combo?.max)) : num(json?.play?.combo?.max),
        health: num(json?.play?.healthBar?.normal),
        // someone else's play: a replay of another player, spectating
        foreign: Boolean(player && me && player.toLowerCase() !== me.toLowerCase()),
    };
}

export function createPlayRecorder({ onPlay, leaveMs = LEAVE_MS, minHits = MIN_HITS } = {}) {
    let play = null; // the play going on
    let leftAt = null;

    function finish(outcome, at) {
        const p = play;
        play = null;
        leftAt = null;
        if (!p || p.foreign || totalHits(p.hits) < minHits || !p.md5) return null;
        const acc = accuracyOf(p.hits);
        const out = {
            client: p.client, md5: p.md5, beatmapId: p.beatmapId, beatmapsetId: p.beatmapsetId,
            artist: p.artist, title: p.title, version: p.version, rate: p.rate, mods: p.mods,
            hits: { ...p.hits }, accuracy: acc === null ? null : Math.round(acc * 10000) / 1e6, maxCombo: p.maxCombo,
            outcome, startedAt: p.startedAt, at,
        };
        try {
            onPlay?.(out);
        } catch {
            // a listener's mistake must not stop the recording
        }
        return out;
    }

    function start(f, at) {
        play = {
            client: f.client, md5: f.checksum ? f.checksum.toLowerCase() : null, beatmapId: f.beatmapId, beatmapsetId: f.beatmapsetId,
            artist: f.artist, title: f.title, version: f.version, rate: f.rate, mods: f.mods,
            hits: { ...f.hits }, maxCombo: f.maxCombo, health: f.health, foreign: f.foreign, startedAt: at,
        };
    }

    const leaving = () => (play && play.health !== null && play.health <= 0 ? "fail" : "quit");

    // a tosu /websocket/v2 frame (parsed JSON) at real time now (ms) → the play it ended, or null
    function onJson(json, now) {
        const f = readRecordFrame(json);
        if (play && f.state !== "playing" && f.state !== "results") {
            leftAt ??= now;
            if (now - leftAt < leaveMs) return null;
            return finish(leaving(), now);
        }
        leftAt = null;
        if (f.state === "playing") {
            if (f.mode !== null && f.mode !== 3) return play ? finish(leaving(), now) : null;
            const md5 = f.checksum ? f.checksum.toLowerCase() : null;
            let ended = null;
            const retry = play && md5 === play.md5 && totalHits(f.hits) < totalHits(play.hits);
            if (play && (md5 !== play.md5 || retry)) ended = finish(leaving(), now);
            if (!play) start(f, now);
            play.hits = { ...f.hits };
            play.rate = f.rate > 0 ? f.rate : play.rate;
            if (f.mods.length) play.mods = f.mods;
            play.maxCombo = f.maxCombo ?? play.maxCombo;
            play.health = f.health ?? play.health;
            play.foreign ||= f.foreign;
            if (f.client) play.client = f.client;
            for (const k of ["beatmapId", "beatmapsetId"]) play[k] ??= f[k];
            for (const k of ["artist", "title", "version"]) play[k] ||= f[k];
            return ended;
        }
        if (f.state === "results") {
            if (!play) return null; // a score opened from song select
            if (totalHits(f.hits) > 0) play.hits = { ...f.hits };
            if (f.maxCombo) play.maxCombo = f.maxCombo;
            if (f.mods.length) play.mods = f.mods;
            return finish("pass", now);
        }
        return null;
    }

    return {
        onJson,
        // tosu gone (osu! closed): a play going on ends as a quit
        onDown: (now) => (play ? finish("quit", now) : null),
        playing: () => Boolean(play),
        current: () => (play ? { md5: play.md5, rate: play.rate } : null),
    };
}
