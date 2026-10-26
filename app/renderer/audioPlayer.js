// The create tab's one audio player (mapgen v3): one AudioContext over the song that is already decoded, for the timing
// check, the playfield and listening to the preview point. Times are song milliseconds. The clock is what is heard now:
// the output timestamp moved on to this moment, or the render clock minus the output latency while there is none yet.
// Clicks (hit clicks under the playfield, beat clicks of a check) are scheduled every 50 ms, 200 ms ahead.

export const TICK_MS = 50;
export const LOOKAHEAD_MS = 200;
const START_DELAY_SEC = 0.05; // the song starts this far ahead of the render clock, so its first click is never late
const SONG_GAIN = 0.7;
const CLICK_GAIN = 0.5;

// Context seconds being heard now: { currentTime, outputTimestamp, perfNow, outputLatency, baseLatency } → seconds.
export function audibleContextTime({ currentTime, outputTimestamp, perfNow, outputLatency, baseLatency }) {
    const ts = outputTimestamp;
    if (ts && ts.contextTime > 0 && Number.isFinite(ts.performanceTime) && ts.performanceTime > 0) {
        const moved = ts.contextTime + Math.max(0, (perfNow - ts.performanceTime) / 1000);
        return Math.min(currentTime, Math.round(moved * 1e9) / 1e9);
    }
    return currentTime - (outputLatency || baseLatency || 0);
}

// The anchor ties the two clocks: the song is at anchor.songMs when the context is at anchor.ctxSec.
export const songMsAt = (ctxSec, anchor) => anchor.songMs + (ctxSec - anchor.ctxSec) * 1000;
export const contextTimeFor = (songMs, anchor) => anchor.ctxSec + (songMs - anchor.songMs) / 1000;

const timeOf = (c) => (typeof c === "number" ? c : c.t);
const lowerBound = (list, x) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (timeOf(list[mid]) < x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
};

// Clicks (sorted ms, or { t, accent }) with from ≤ t < to.
export const dueClicks = (clicks, fromMs, toMs) => (toMs > fromMs ? clicks.slice(lowerBound(clicks, fromMs), lowerBound(clicks, toMs)) : []);

// A short decaying tone, the click sound.
function toneBuffer(ctx, freq, ms) {
    const length = Math.max(1, Math.round((ctx.sampleRate * ms) / 1000));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.sin((2 * Math.PI * freq * i) / ctx.sampleRate) * Math.exp(-i / (length / 5));
    return buffer;
}

export function createAudioPlayer({
    createContext = () => new AudioContext(),
    setTimer = (fn, ms) => setInterval(fn, ms),
    clearTimer = (id) => clearInterval(id),
    perfNow = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
    let ctx = null;
    let sounds = null; // { master gain, song gain, click gain, tick, beat, accent buffers }
    let volume = 1; // 0–1 over everything (the volume slider)
    let buffer = null;
    let positionMs = 0; // where the song is while paused
    let run = null; // { source, anchor, clicks, scheduledUntil, endMs, returnTo, timer }
    let hitClicks = null;
    const scheduled = new Set();
    const listeners = new Set();

    const durationMs = () => (buffer ? buffer.duration * 1000 : 0);
    const clamp = (ms) => Math.min(durationMs(), Math.max(0, ms));
    const notify = () => { for (const fn of [...listeners]) fn({ playing: Boolean(run), positionMs: now() }); };

    function context() {
        if (!ctx) {
            ctx = createContext();
            const master = ctx.createGain();
            master.gain.value = volume;
            master.connect(ctx.destination);
            const song = ctx.createGain();
            song.gain.value = SONG_GAIN;
            song.connect(master);
            const click = ctx.createGain();
            click.gain.value = CLICK_GAIN;
            click.connect(master);
            sounds = { master, song, click, tick: toneBuffer(ctx, 1800, 25), beat: toneBuffer(ctx, 1000, 40), accent: toneBuffer(ctx, 1500, 40) };
        }
        if (ctx.state === "suspended") ctx.resume?.();
        return ctx;
    }

    function now() {
        if (!run || !ctx) return positionMs;
        const heard = audibleContextTime({
            currentTime: ctx.currentTime, outputTimestamp: ctx.getOutputTimestamp?.(), perfNow: perfNow(),
            outputLatency: ctx.outputLatency, baseLatency: ctx.baseLatency,
        });
        return Math.min(run.endMs, Math.max(run.anchor.songMs, songMsAt(heard, run.anchor)));
    }

    function schedule() {
        if (!run) return;
        const until = Math.min(run.endMs, songMsAt(ctx.currentTime, run.anchor) + LOOKAHEAD_MS);
        for (const c of dueClicks(run.clicks, run.scheduledUntil, until)) {
            const at = contextTimeFor(timeOf(c), run.anchor);
            if (at < ctx.currentTime) continue;
            const node = ctx.createBufferSource();
            node.buffer = run.oneShot ? (c.accent ? sounds.accent : sounds.beat) : sounds.tick;
            node.connect(sounds.click);
            node.onended = () => scheduled.delete(node);
            node.start(at);
            scheduled.add(node);
        }
        run.scheduledUntil = Math.max(run.scheduledUntil, until);
    }

    function stopRun() {
        if (!run) return;
        clearTimer(run.timer);
        run.source.onended = null;
        try {
            run.source.stop();
        } catch {
            // already stopped
        }
        for (const node of scheduled) {
            try {
                node.stop();
            } catch {
                // already played
            }
        }
        scheduled.clear();
        run = null;
    }

    // Starts the song at positionMs; a window (seconds) stops by itself and returns to returnTo.
    function start({ seconds = null, clicks = null, returnTo = null } = {}) {
        if (!buffer) return;
        const c = context();
        const source = c.createBufferSource();
        source.buffer = buffer;
        source.connect(sounds.song);
        const anchor = { ctxSec: c.currentTime + START_DELAY_SEC, songMs: positionMs };
        if (seconds === null) source.start(anchor.ctxSec, positionMs / 1000);
        else source.start(anchor.ctxSec, positionMs / 1000, seconds);
        const endMs = seconds === null ? durationMs() : Math.min(durationMs(), positionMs + seconds * 1000);
        run = { source, anchor, endMs, returnTo, oneShot: Boolean(clicks), clicks: clicks ?? hitClicks ?? [], scheduledUntil: positionMs, timer: null };
        source.onended = () => {
            positionMs = returnTo ?? endMs;
            stopRun();
            notify();
        };
        schedule();
        run.timer = setTimer(schedule, TICK_MS);
    }

    return {
        // an AudioBuffer (anything with duration in seconds): the song to play from now on
        load(next) {
            stopRun();
            buffer = next;
            positionMs = 0;
            notify();
        },
        get durationMs() { return durationMs(); },
        get playing() { return Boolean(run); },
        get loaded() { return Boolean(buffer); },
        now,
        play() {
            if (run || !buffer) return;
            if (positionMs >= durationMs()) positionMs = 0;
            start();
            notify();
        },
        pause() {
            if (!run) return;
            const at = run.returnTo ?? now();
            stopRun();
            positionMs = clamp(at);
            notify();
        },
        toggle() {
            if (run) this.pause();
            else this.play();
        },
        seek(ms) {
            const wasPlaying = Boolean(run) && run.returnTo === null;
            stopRun();
            positionMs = clamp(Number(ms) || 0);
            if (wasPlaying) start();
            notify();
        },
        // plays `seconds` from startSec with these clicks only (ms or { t, accent }), then goes back to startSec
        playFrom(startSec, seconds, { clicks = [] } = {}) {
            if (!buffer) return;
            stopRun();
            positionMs = clamp(startSec * 1000);
            start({ seconds, clicks: [...clicks].sort((a, b) => timeOf(a) - timeOf(b)), returnTo: positionMs });
            notify();
        },
        // the note times to click on while playing (sorted ms), or null for none
        setHitClicks(times) {
            hitClicks = times ? [...times] : null;
            if (run && !run.oneShot) {
                for (const node of scheduled) {
                    try {
                        node.stop();
                    } catch {
                        // already played
                    }
                }
                scheduled.clear();
                run.clicks = hitClicks ?? [];
                run.scheduledUntil = Math.max(run.anchor.songMs, songMsAt(ctx.currentTime, run.anchor));
                schedule();
            }
        },
        // the volume of the song and the clicks together, 0–1
        get volume() { return volume; },
        setVolume(v) {
            volume = Math.min(1, Math.max(0, Number(v) || 0));
            if (sounds) sounds.master.gain.value = volume;
        },
        // fn({ playing, positionMs }) on play, pause, seek and the end; returns the unsubscribe
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
