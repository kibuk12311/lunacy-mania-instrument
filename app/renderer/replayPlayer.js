// The Replay tab's clock and sound: one AudioContext over the song, on the map's clock (ms of the map). speed is how many
// map ms pass per real ms: the replay's rate times the speed picked, so the song plays as it was played and goes up in
// pitch like osu!'s DT. Without a song, or past its end, the clock keeps running by itself.
const START_DELAY_SEC = 0.05;

export function createReplayPlayer({
    createContext = () => new AudioContext(), perfNow = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
    let ctx = null;
    let gain = null;
    let buffer = null;
    let source = null;
    let volume = 0.6;
    let speed = 1;
    let position = 0; // where the map is while stopped, and where it was when the clock started
    let started = null; // the clock's seconds at `position`
    let range = { from: 0, to: 0 };
    const listeners = new Set();

    const context = () => {
        if (!ctx) {
            ctx = createContext();
            gain = ctx.createGain();
            gain.gain.value = volume;
            gain.connect(ctx.destination);
        }
        return ctx;
    };
    const clock = () => (buffer ? ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) : perfNow() / 1000);
    const notify = () => { for (const fn of [...listeners]) fn(); };

    function now() {
        if (started === null) return position;
        return Math.min(range.to, Math.max(position, position + (clock() - started) * 1000 * speed));
    }

    function stopSource() {
        if (!source) return;
        source.onended = null;
        try {
            source.stop();
        } catch {
            // already stopped
        }
        source = null;
    }

    function start() {
        if (buffer) {
            const c = context();
            if (c.state === "suspended") c.resume?.();
            const at = c.currentTime + START_DELAY_SEC;
            started = at;
            if (position / 1000 < buffer.duration) {
                source = c.createBufferSource();
                source.buffer = buffer;
                source.playbackRate.value = speed;
                source.connect(gain);
                // a map's lead-in comes before the song's first sample
                source.start(at + Math.max(0, -position / 1000) / speed, Math.max(0, position / 1000));
            }
        } else started = perfNow() / 1000;
    }

    return {
        // the stretch of the map that can be played; the clock goes to its start
        setRange(from, to) {
            this.pause();
            range = { from, to };
            position = from;
            notify();
        },
        // the song's bytes → decoded; false when they cannot be
        async loadAudio(bytes) {
            const c = context();
            const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            const decoded = await c.decodeAudioData(copy);
            const was = started !== null;
            this.pause();
            buffer = decoded;
            if (was) this.play();
            return true;
        },
        unload() {
            this.pause();
            buffer = null;
        },
        get hasAudio() { return Boolean(buffer); },
        get playing() { return started !== null; },
        get speed() { return speed; },
        get range() { return range; },
        now,
        play() {
            if (started !== null) return;
            if (position >= range.to) position = range.from;
            start();
            notify();
        },
        pause() {
            if (started === null) return;
            position = now();
            started = null;
            stopSource();
            notify();
        },
        toggle() {
            if (started !== null) this.pause();
            else this.play();
        },
        seek(ms) {
            const running = started !== null;
            this.pause();
            position = Math.min(range.to, Math.max(range.from, Number(ms) || 0));
            if (running) this.play();
            else notify();
        },
        setSpeed(next) {
            if (!(next > 0)) return;
            const running = started !== null;
            this.pause();
            speed = next;
            if (running) this.play();
        },
        setVolume(next) {
            volume = Math.min(1, Math.max(0, next));
            if (gain) gain.gain.value = volume;
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
