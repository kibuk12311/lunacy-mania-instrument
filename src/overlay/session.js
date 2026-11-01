// One play as the overlay sees it: tosu frames (or Interlude's, src/overlay/interludeData.js) in, a snapshot for the
// widget windows out. Interlude's frames carry the play's own per-note events and held columns: those are the presses
// (KPS, key lines) and the hit deltas (UR) then, instead of guesses from the judgement counts; its play id tells a retry.
// A new play starts on entering gameplay, on another map, and on a retry (the counts drop or the clock jumps back);
// everything (KPS, its max, the lanes) starts over then. Times inside are map milliseconds; KPS and NPS run in real time.
// A play ends on the results screen at once, but on any other state only once that state has lasted LEAVE_MS: a single
// odd frame in the middle of a play (tosu reading the screen between two states) must not start the play over.
// osu! stable's real keys (onKey, from the keyboard reader app/keyReader.js): each press and release at its own real
// time, put on the map's clock by the play clock (src/overlay/playClock.js, steady against tosu's frame jitter); the
// first one takes the lanes and the KPS over from the judgements for the rest of the play. While the keyboard has the
// lanes, the snapshot's clock is the play clock too, so the bars sit where the keys really went down.
import { createKpsMeter } from "./kps.js";
import { createLaneTracker } from "./lanes.js";
import { createPlayClock } from "./playClock.js";
import { createNpsTrack } from "./nps.js";
import { formatRatio, maniaAccuracy, unstableRate } from "./format.js";
import { totalHits } from "./tosuData.js";
import { PRESS_KINDS, RELEASE_KINDS, pressTime } from "./interludeData.js";

const ZERO = { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 };
const EXTRAPOLATE_MS = 300; // the clock runs on by itself this long after the last frame, no further
// osu! stable says nothing of a pause: a clock standing still is one. For the keyboard only once it has stood this
// long (real ms): tosu's reading can stall for a second while it sends its last frame again and again, and the keys
// going on then are the play's
export const STALL_MS = 1500;
export const LANE_SPAN_MS = 1500; // real-time ms of presses the key-lines widget shows (at its speed 1)
export const LEAVE_MS = 500; // a non-play state lasting this long (real ms) ends the play
// a clock moving again this many map ms short of the real time it stood (or more) picked up from where it stood: a pause
export const RESUME_SLACK_MS = 250;
// a play whose clock has stood this long (real ms) after moving is paused, as far as showing the widgets goes (osu!
// stable and lazer say nothing of a pause; Interlude's frames do, at once)
export const PAUSE_MS = STALL_MS;

// options: the widgets' settings a session works with (src/overlay/settings.js sessionOptions()): the KPS graph's
// length and smoothing, the NPS's smoothing and graph window, the key lines' span; configure() changes them later
export function createOverlaySession(options = {}) {
    const kps = createKpsMeter();
    const lanes = createLaneTracker({ keys: 4 });
    const nps = createNpsTrack();
    const playClock = createPlayClock();
    let laneSpanMs = LANE_SPAN_MS;
    let npsWindowMs = 0;
    let mapKeys = null; // the key count of the map's notes, once they are in
    let keyAt = null; // map ms of the last key from the keyboard in this play
    let phase = "idle";
    let checksum = null;
    let mapChecksum = null;
    let mode = null;
    let rate = 1;
    let mods = [];
    let odSet = null; // the OD the play set itself (lazer's Difficulty Adjust)
    let hits = { ...ZERO };
    let accuracy = null;
    let ur = null;
    let hitErrors = [];
    let live = null; // map ms at clockAt
    let clockAt = 0; // real ms (the caller's clock) of the last time reading
    let running = false;
    let movedAt = null; // real ms of the last reading whose clock moved on (null: none since the play came back)
    let paused = false; // the last frame said the play is paused (Interlude's do; osu! stable's never do)
    let watching = false; // the play is not the player's own (autoplay, spectating, someone's replay)
    let leftAt = null; // real ms of the first non-play frame while playing, until the play comes back or ends
    let playId = null; // Interlude's play id of the play going on
    let judgeNames = null; // Interlude's ruleset names of the judgements (null: osu!'s six)
    let deltas = { n: 0, mean: 0, m2: 0 }; // Interlude's hit deltas so far (Welford), for the UR

    function startPlay(frame) {
        kps.reset();
        lanes.reset();
        hits = { ...ZERO };
        accuracy = null;
        ur = null;
        hitErrors = [];
        deltas = { n: 0, mean: 0, m2: 0 };
        judgeNames = null;
        playId = Number.isFinite(frame.playId) ? frame.playId : null;
        playClock.reset();
        keyAt = null;
        movedAt = null;
        // another map: the old one's notes go until the new ones come
        if (frame.checksum !== mapChecksum) {
            lanes.setMap({ keys: frame.keys > 0 ? frame.keys : lanes.lanes(), notes: [] });
            nps.reset();
            mapChecksum = null;
            mapKeys = null;
        }
        checksum = frame.checksum;
        rate = frame.rate > 0 ? frame.rate : 1;
        mods = Array.isArray(frame.mods) ? frame.mods : [];
        odSet = frame.odSet ?? null;
        nps.setRate(rate);
    }

    // the keyboard's presses go into the play: its clock runs, or it has stood still too short a time to be a pause
    const keysRun = (at) => running || (!paused && movedAt !== null && at - movedAt <= STALL_MS);

    const clock = (now) => {
        if (live === null) return 0;
        if (!running && !(lanes.source() === "kbd" && keysRun(now))) return live;
        const t = live + Math.min(Math.max(0, now - clockAt), EXTRAPOLATE_MS) * rate;
        if (lanes.source() !== "kbd") return t;
        // the keyboard's bars are on the play clock: so is the clock they are drawn at. It runs on no further than
        // 300 ms past the last sign of the play going on: a frame, or a key (tosu's reading can stall for a second
        // while the keys go on coming)
        const steady = playClock.at(now);
        const lastSign = Math.max(live, keyAt ?? live);
        return steady === null ? t : Math.min(Math.max(t, steady), lastSign + EXTRAPOLATE_MS * rate);
    };

    // a real time (the caller's ms) -> map ms of the play going on
    const mapTimeAt = (at) => playClock.at(at) ?? live + (at - clockAt) * rate;

    // Interlude's events of one frame: presses into the key lines and KPS, deltas into the UR; then the held columns
    // close the holds whose key came up between two events
    function onEvents(events, keysDown, at) {
        for (const e of events) {
            const t = pressTime(e, rate);
            if (PRESS_KINDS.has(e.kind) && !e.missed) {
                const p = lanes.press(e.col, t, { hold: e.kind === "hold" || e.kind === "regrabhold" });
                kps.press((p?.t ?? t) / rate, 1, Number.isFinite(at) ? (at - t) / rate : 0);
            } else if (RELEASE_KINDS.has(e.kind)) {
                lanes.release(e.col, t);
            }
            if (e.delta !== null && !e.missed && e.judgement !== null && e.kind !== "ghosttap") {
                deltas.n += 1;
                const d = e.delta - deltas.mean;
                deltas.mean += d / deltas.n;
                deltas.m2 += d * (e.delta - deltas.mean);
            }
        }
        if (Array.isArray(keysDown) && at !== null) lanes.keysDown(keysDown, at);
    }

    // The clock moves again (map ms next) after standing still at live since movedAt. When it picks up from where it
    // stood, well short of the real time gone by, it was a pause and not tosu stalling while the game went on: the
    // keyboard's presses taken in its first STALL_MS (put on the play clock past live) were none, and would come back
    // as bars and KPS once the clock passes them again
    function resumed(next, now) {
        if (lanes.source() !== "kbd" || live === null || movedAt === null) return;
        if (next - live >= (now - movedAt) * rate - RESUME_SLACK_MS) return;
        if (lanes.dropKeysAfter(live) > 0) kps.dropAfter(live / rate);
        if (keyAt !== null) keyAt = Math.min(keyAt, live);
    }

    // a readPlayFrame() (or readInterludeFrame()) result at the caller's time now (ms); → { mapWanted: checksum | null }
    function onFrame(frame, now) {
        if (frame.state !== "playing" && frame.state !== "results" && phase === "playing") {
            leftAt ??= now;
            running = false;
            movedAt = null;
            if (now - leftAt < LEAVE_MS) return { mapWanted: null };
        }
        leftAt = null;
        mode = frame.mode;
        if (frame.state === "playing") {
            const newId = Number.isFinite(frame.playId) && playId !== null && frame.playId !== playId;
            const retry = phase === "playing" && frame.checksum === checksum
                && (newId || totalHits(frame.hits) < totalHits(hits) || (Number.isFinite(frame.liveMs) && live !== null && frame.liveMs < live - 1000));
            if (phase !== "playing" || frame.checksum !== checksum || retry) {
                startPlay(frame);
                live = null;
            }
            phase = "playing";
            rate = frame.rate > 0 ? frame.rate : rate;
            nps.setRate(rate);
            if (Number.isFinite(frame.playId)) playId = frame.playId;
            watching = frame.watching === true;
            if (Number.isFinite(frame.liveMs)) {
                paused = frame.paused === true;
                const was = running;
                running = live !== null && frame.liveMs !== live && !paused;
                if (running && !was) resumed(frame.liveMs, now);
                live = frame.liveMs;
                clockAt = now;
                if (running) {
                    movedAt = now;
                    playClock.sample(live, now, rate);
                }
            }
            const d = (key) => Math.max(0, frame.hits[key] - hits[key]);
            const miss = d("miss");
            const hit = d("max") + d("n300") + d("n200") + d("n100") + d("n50");
            if (Array.isArray(frame.events)) {
                onEvents(frame.events, frame.keysDown, live);
            } else if (hit + miss > 0 && live !== null) {
                if (lanes.source() === "none") kps.press(live / rate, hit); // no map, no keys: one press per judgement
                // a judged note's press is at the note's time, known only now: that lateness sets the KPS's delay
                else for (const p of lanes.judge({ hit, miss }, live)) kps.press(p.t / rate, 1, (live - p.t) / rate);
            }
            hits = { ...frame.hits };
            accuracy = frame.accuracy;
            ur = Array.isArray(frame.events) ? (deltas.n >= 2 ? Math.sqrt(deltas.m2 / deltas.n) * 10 : null) : frame.ur;
            hitErrors = frame.hitErrors;
            if (frame.judgeNames) judgeNames = frame.judgeNames;
        } else if (frame.state === "results") {
            if (phase === "playing" || phase === "results") {
                if (frame.hits && totalHits(frame.hits) > 0) hits = { ...frame.hits };
                if (frame.hits && frame.accuracy !== null && totalHits(frame.hits) > 0) accuracy = frame.accuracy;
                phase = "results";
            } else if (!frame.hits) {
                // a score screen with no numbers of its own (Interlude's, opened from level select): nothing to show
                phase = "idle";
            } else {
                // results opened from song select (a replay or a saved score): only its numbers
                startPlay(frame);
                hits = { ...frame.hits };
                accuracy = frame.accuracy;
                phase = "results";
            }
            running = false;
            movedAt = null;
        } else {
            phase = "idle";
            running = false;
            movedAt = null;
            watching = false;
        }
        const wanted = phase === "playing" && checksum && checksum !== mapChecksum && (mode === 3 || mode === null) ? checksum : null;
        return { mapWanted: wanted };
    }

    // a readPreciseFrame() result
    // tosu v4's precise feed has no clock of its own (keys and hit errors only): its presses are put at the play's
    // clock, which the main frames keep (and which runs on by itself between them)
    function onPrecise(p, now) {
        if (phase !== "playing") return;
        let at;
        if (Number.isFinite(p.timeMs)) {
            if (live !== null && p.timeMs < live - 1000) return; // a retry is told by the main frame
            const moved = live !== null && p.timeMs !== live;
            running = moved ? true : running;
            live = p.timeMs;
            clockAt = now;
            at = p.timeMs;
            if (moved) movedAt = now;
            if (running) playClock.sample(live, now, rate);
        } else {
            if (live === null) return;
            at = clock(now);
        }
        if (p.keys) for (const press of lanes.keysFrame(p.keys, at)) kps.press(press.t / rate);
    }

    // A key of a lane from the keyboard (osu! stable): lane col of `keys` went down (or up) at real time `at` (the
    // caller's ms, the clock of now). Only while a play's clock runs (or has stood still less than STALL_MS: tosu
    // stalling): a key in a pause, before the first frame or in a play that is not the player's own is no press of the
    // play. -> whether it was taken
    function onKey({ col, down, at, keys }) {
        if (phase !== "playing" || live === null || watching || !Number.isInteger(col) || !Number.isFinite(at)) return false;
        const t = mapTimeAt(at);
        const run = keysRun(at);
        if (!down) {
            lanes.keyUp(col, t);
            if (lanes.source() === "kbd" && run) keyAt = Math.max(keyAt ?? t, t);
            return true;
        }
        if (!run) return false;
        const p = lanes.keyDown(col, t, keys > 0 ? keys : lanes.lanes());
        if (!p) return false;
        keyAt = Math.max(keyAt ?? t, t);
        // the keyboard took over: what the judgements made of the KPS so far goes, the real presses count from here
        if (p.took) kps.reset();
        kps.press(t / rate);
        return true;
    }

    // the keyboard is not heard any more (the reader stopped or went away): its held lanes let go at real time at
    function keysGone(at) {
        if (lanes.source() === "kbd" && live !== null) lanes.releaseAll(mapTimeAt(at));
    }

    // the notes of the map being played (parseManiaNotes()), once fetched
    function setMap(forChecksum, parsed) {
        mapChecksum = forChecksum;
        if (forChecksum !== checksum || !parsed?.notes?.length) return;
        const real = lanes.source() === "keys" || lanes.source() === "kbd"; // real presses already counted stay
        lanes.setMap(parsed);
        if (!real) lanes.reset();
        nps.setMap(parsed.notes);
        mapKeys = parsed.keys > 0 ? parsed.keys : null;
    }

    // the key count of the play: osu!'s key mod (1K-9K) if one is on, else the map's once its notes are in; null for
    // co-op (CP) or before the map is known
    function playKeys() {
        if (mods.includes("CP")) return null;
        const mod = mods.find((m) => /^[1-9]K$/.test(m));
        if (mod) return Number(mod[0]);
        return mapChecksum === checksum ? mapKeys : null;
    }

    function snapshot(now) {
        const t = clock(now);
        const real = t / rate;
        return {
            phase,
            // a stall of tosu's while the keyboard has the lanes runs on (keysRun), as the clock does
            running: running || (phase === "playing" && lanes.source() === "kbd" && keysRun(now)),
            rate,
            // the map and its mode (3 = mania, null: not told), the mods' acronyms and the OD they set: the Dan widget's
            checksum,
            mode,
            mods: [...mods],
            odSet,
            clock: t,
            hits: { ...hits },
            ratio: formatRatio(hits.max, hits.n300),
            accuracy: accuracy ?? maniaAccuracy(hits),
            // Interlude: the ruleset's names of the judgements ({ ruleset, names, counts, mapped, labels }), else null
            judgeNames,
            // tosu reads 0 until it has a number; then the hit errors are used
            ur: ur > 0 ? ur : unstableRate(hitErrors),
            kps: { now: kps.now(real), max: kps.max(), history: kps.history(real) },
            nps: nps.at(t, { windowMs: npsWindowMs }),
            lanes: {
                keys: lanes.lanes(),
                source: lanes.source(),
                counts: lanes.counts(),
                pressed: lanes.pressed(t),
                spanMs: laneSpanMs * rate,
                bars: lanes.bars(t, laneSpanMs * rate),
            },
        };
    }

    // the widgets' settings (createOverlaySession's options), at once, the play going on included
    function configure(o = {}) {
        kps.configure({ historyMs: o.kpsHistoryMs, half: o.kpsHalfMs });
        nps.setHalf(o.npsHalfMs);
        if (Number.isFinite(o.npsWindowMs) && o.npsWindowMs >= 0) npsWindowMs = o.npsWindowMs;
        if (Number.isFinite(o.laneSpanMs) && o.laneSpanMs > 0) laneSpanMs = o.laneSpanMs;
    }
    configure(options);

    // a play in a pause at real time now: Interlude says so; osu!'s clock has stood PAUSE_MS after moving
    const pausedNow = (now) => phase === "playing" && live !== null
        && (paused || (!running && movedAt !== null && now - movedAt >= PAUSE_MS));

    return {
        onFrame, onPrecise, setMap, snapshot, onKey, keysGone, playKeys, configure,
        paused: pausedNow,
        // real ms until the play counts as paused with nothing new coming in (null: it will not by itself)
        pauseIn: (now) => (phase === "playing" && live !== null && !paused && !running && movedAt !== null
            && now - movedAt < PAUSE_MS ? PAUSE_MS - (now - movedAt) : null),
        phase: () => phase,
        mode: () => mode,
        // the play going on is not the player's own (autoplay, spectating, someone's replay): no keyboard for it
        watching: () => watching,
        // the map of the play (or its results) and its rate and mode, for the Dan widget
        map: () => ({ checksum: phase === "idle" ? null : checksum, rate, mode }),
        // a play that is really going on: its clock moved on the last reading, or it has judgements
        advancing: () => phase === "playing" && (running || totalHits(hits) > 0),
    };
}
