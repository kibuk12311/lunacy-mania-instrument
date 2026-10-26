// One play as the overlay sees it: tosu frames (or Interlude's, src/overlay/interludeData.js) in, a snapshot for the
// widget windows out. Interlude's frames carry the play's own per-note events and held columns: those are the presses
// (KPS, key lines) and the hit deltas (UR) then, instead of guesses from the judgement counts; its play id tells a retry.
// A new play starts on entering gameplay, on another map, and on a retry (the counts drop or the clock jumps back);
// everything (KPS, its max, the lanes) starts over then. Times inside are map milliseconds; KPS and NPS run in real time.
// A play ends on the results screen at once, but on any other state only once that state has lasted LEAVE_MS: a single
// odd frame in the middle of a play (tosu reading the screen between two states) must not start the play over.
import { createKpsMeter } from "./kps.js";
import { createLaneTracker } from "./lanes.js";
import { createNpsTrack } from "./nps.js";
import { formatRatio, maniaAccuracy, unstableRate } from "./format.js";
import { totalHits } from "./tosuData.js";
import { PRESS_KINDS, RELEASE_KINDS, pressTime } from "./interludeData.js";

const ZERO = { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 };
const EXTRAPOLATE_MS = 300; // the clock runs on by itself this long after the last frame, no further
export const LANE_SPAN_MS = 1500; // real-time ms of presses the key-lines widget shows
export const LEAVE_MS = 500; // a non-play state lasting this long (real ms) ends the play

export function createOverlaySession() {
    const kps = createKpsMeter();
    const lanes = createLaneTracker({ keys: 4 });
    const nps = createNpsTrack();
    let phase = "idle";
    let checksum = null;
    let mapChecksum = null;
    let mode = null;
    let rate = 1;
    let mods = [];
    let hits = { ...ZERO };
    let accuracy = null;
    let ur = null;
    let hitErrors = [];
    let live = null; // map ms at clockAt
    let clockAt = 0; // real ms (the caller's clock) of the last time reading
    let running = false;
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
        // another map: the old one's notes go until the new ones come
        if (frame.checksum !== mapChecksum) {
            lanes.setMap({ keys: frame.keys > 0 ? frame.keys : lanes.lanes(), notes: [] });
            nps.reset();
            mapChecksum = null;
        }
        checksum = frame.checksum;
        rate = frame.rate > 0 ? frame.rate : 1;
        mods = Array.isArray(frame.mods) ? frame.mods : [];
        nps.setRate(rate);
    }

    const clock = (now) => {
        if (live === null) return 0;
        return running ? live + Math.min(Math.max(0, now - clockAt), EXTRAPOLATE_MS) * rate : live;
    };

    // Interlude's events of one frame: presses into the key lines and KPS, deltas into the UR; then the held columns
    // close the holds whose key came up between two events
    function onEvents(events, keysDown, at) {
        for (const e of events) {
            const t = pressTime(e, rate);
            if (PRESS_KINDS.has(e.kind) && !e.missed) {
                const p = lanes.press(e.col, t, { hold: e.kind === "hold" || e.kind === "regrabhold" });
                kps.press((p?.t ?? t) / rate);
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

    // a readPlayFrame() (or readInterludeFrame()) result at the caller's time now (ms); → { mapWanted: checksum | null }
    function onFrame(frame, now) {
        if (frame.state !== "playing" && frame.state !== "results" && phase === "playing") {
            leftAt ??= now;
            running = false;
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
            if (Number.isFinite(frame.liveMs)) {
                running = live !== null && frame.liveMs !== live && !frame.paused;
                live = frame.liveMs;
                clockAt = now;
            }
            const d = (key) => Math.max(0, frame.hits[key] - hits[key]);
            const miss = d("miss");
            const hit = d("max") + d("n300") + d("n200") + d("n100") + d("n50");
            if (Array.isArray(frame.events)) {
                onEvents(frame.events, frame.keysDown, live);
            } else if (hit + miss > 0 && live !== null) {
                if (lanes.source() === "none") kps.press(live / rate, hit); // no map, no keys: one press per judgement
                else for (const p of lanes.judge({ hit, miss }, live)) kps.press(p.t / rate);
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
        } else {
            phase = "idle";
            running = false;
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
            running = live !== null && p.timeMs !== live ? true : running;
            live = p.timeMs;
            clockAt = now;
            at = p.timeMs;
        } else {
            if (live === null) return;
            at = clock(now);
        }
        if (p.keys) for (const press of lanes.keysFrame(p.keys, at)) kps.press(press.t / rate);
    }

    // the notes of the map being played (parseManiaNotes()), once fetched
    function setMap(forChecksum, parsed) {
        mapChecksum = forChecksum;
        if (forChecksum !== checksum || !parsed?.notes?.length) return;
        const real = lanes.source() === "keys"; // real presses already counted stay
        lanes.setMap(parsed);
        if (!real) lanes.reset();
        nps.setMap(parsed.notes);
    }

    function snapshot(now) {
        const t = clock(now);
        const real = t / rate;
        return {
            phase,
            running,
            rate,
            // the map and its mode (3 = mania, null: not told), the mods' acronyms: the Dan widget's
            checksum,
            mode,
            mods: [...mods],
            clock: t,
            hits: { ...hits },
            ratio: formatRatio(hits.max, hits.n300),
            accuracy: accuracy ?? maniaAccuracy(hits),
            // Interlude: the ruleset's names of the judgements ({ ruleset, names, counts, mapped, labels }), else null
            judgeNames,
            // tosu reads 0 until it has a number; then the hit errors are used
            ur: ur > 0 ? ur : unstableRate(hitErrors),
            kps: { now: kps.now(real), max: kps.max(), history: kps.history(real) },
            nps: nps.at(t),
            lanes: {
                keys: lanes.lanes(),
                source: lanes.source(),
                counts: lanes.counts(),
                pressed: lanes.pressed(t),
                spanMs: LANE_SPAN_MS * rate,
                bars: lanes.bars(t, LANE_SPAN_MS * rate),
            },
        };
    }

    return {
        onFrame, onPrecise, setMap, snapshot,
        phase: () => phase,
        // the map of the play (or its results) and its rate and mode, for the Dan widget
        map: () => ({ checksum: phase === "idle" ? null : checksum, rate, mode }),
        // a play that is really going on: its clock moved on the last reading, or it has judgements
        advancing: () => phase === "playing" && (running || totalHits(hits) > 0),
    };
}
