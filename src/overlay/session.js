// One play as the overlay sees it: tosu frames in, a snapshot for the widget windows out.
// A new play starts on entering gameplay, on another map, and on a retry (the counts drop or the clock jumps back);
// everything (KPS, its max, the lanes) starts over then. Times inside are map milliseconds; KPS and NPS run in real time.
// A play ends on the results screen at once, but on any other state only once that state has lasted LEAVE_MS: a single
// odd frame in the middle of a play (tosu reading the screen between two states) must not start the play over.
import { createKpsMeter } from "./kps.js";
import { createLaneTracker } from "./lanes.js";
import { createNpsTrack } from "./nps.js";
import { formatRatio, maniaAccuracy, unstableRate } from "./format.js";
import { totalHits } from "./tosuData.js";

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
    let hits = { ...ZERO };
    let accuracy = null;
    let ur = null;
    let hitErrors = [];
    let live = null; // map ms at clockAt
    let clockAt = 0; // real ms (the caller's clock) of the last time reading
    let running = false;
    let leftAt = null; // real ms of the first non-play frame while playing, until the play comes back or ends

    function startPlay(frame) {
        kps.reset();
        lanes.reset();
        hits = { ...ZERO };
        accuracy = null;
        ur = null;
        hitErrors = [];
        // another map: the old one's notes go until the new ones come
        if (frame.checksum !== mapChecksum) {
            lanes.setMap({ keys: lanes.lanes(), notes: [] });
            nps.reset();
            mapChecksum = null;
        }
        checksum = frame.checksum;
        rate = frame.rate > 0 ? frame.rate : 1;
        nps.setRate(rate);
    }

    const clock = (now) => {
        if (live === null) return 0;
        return running ? live + Math.min(Math.max(0, now - clockAt), EXTRAPOLATE_MS) * rate : live;
    };

    // a readPlayFrame() result at the caller's time now (ms); → { mapWanted: checksum | null }
    function onFrame(frame, now) {
        if (frame.state !== "playing" && frame.state !== "results" && phase === "playing") {
            leftAt ??= now;
            running = false;
            if (now - leftAt < LEAVE_MS) return { mapWanted: null };
        }
        leftAt = null;
        mode = frame.mode;
        if (frame.state === "playing") {
            const retry = phase === "playing" && frame.checksum === checksum
                && (totalHits(frame.hits) < totalHits(hits) || (Number.isFinite(frame.liveMs) && live !== null && frame.liveMs < live - 1000));
            if (phase !== "playing" || frame.checksum !== checksum || retry) {
                startPlay(frame);
                live = null;
            }
            phase = "playing";
            rate = frame.rate > 0 ? frame.rate : rate;
            nps.setRate(rate);
            if (Number.isFinite(frame.liveMs)) {
                running = live !== null && frame.liveMs !== live;
                live = frame.liveMs;
                clockAt = now;
            }
            const d = (key) => Math.max(0, frame.hits[key] - hits[key]);
            const miss = d("miss");
            const hit = d("max") + d("n300") + d("n200") + d("n100") + d("n50");
            if (hit + miss > 0 && live !== null) {
                if (lanes.source() === "none") kps.press(live / rate, hit); // no map, no keys: one press per judgement
                else for (const p of lanes.judge({ hit, miss }, live)) kps.press(p.t / rate);
            }
            hits = { ...frame.hits };
            accuracy = frame.accuracy;
            ur = frame.ur;
            hitErrors = frame.hitErrors;
        } else if (frame.state === "results") {
            if (phase === "playing" || phase === "results") {
                if (totalHits(frame.hits) > 0) hits = { ...frame.hits };
                if (frame.accuracy !== null && totalHits(frame.hits) > 0) accuracy = frame.accuracy;
                phase = "results";
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
        lanes.setMap(parsed);
        lanes.reset();
        nps.setMap(parsed.notes);
    }

    function snapshot(now) {
        const t = clock(now);
        const real = t / rate;
        return {
            phase,
            running,
            rate,
            clock: t,
            hits: { ...hits },
            ratio: formatRatio(hits.max, hits.n300),
            accuracy: accuracy ?? maniaAccuracy(hits),
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
        // a play that is really going on: its clock moved on the last reading, or it has judgements
        advancing: () => phase === "playing" && (running || totalHits(hits) > 0),
    };
}
