// WebAudio for the demo player: one AudioContext, decoding (Ogg Vorbis / MP3 / WAV — whatever the browser decodes),
// a source at playbackRate = rate (the pitch follows the rate, like Nightcore), volume, pause by suspend/resume.

export function createAudio({ AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext, volume = 0.6 } = {}) {
    if (typeof AudioContextCtor !== "function") return null;
    const ctx = new AudioContextCtor({ latencyHint: "interactive" });
    const gain = ctx.createGain();
    gain.gain.value = clampVolume(volume);
    gain.connect(ctx.destination);
    let source = null;

    function stop() {
        if (!source) return;
        const s = source;
        source = null;
        s.onended = null;
        try { s.stop(); } catch { /* not started or already stopped */ }
        try { s.disconnect(); } catch { /* already disconnected */ }
    }

    return {
        ctx,
        // bytes: Uint8Array or ArrayBuffer → AudioBuffer (rejects when the browser cannot decode it)
        async decode(bytes) {
            const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            const copy = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength); // decode detaches it
            return await new Promise((resolve, reject) => {
                const p = ctx.decodeAudioData(copy, resolve, reject);
                if (p && typeof p.then === "function") p.then(resolve, reject);
            });
        },
        // must run inside a user gesture the first time (autoplay rules)
        async unlock() {
            if (ctx.state !== "running") await ctx.resume();
        },
        play(buffer, { when, bufferOffset = 0, rate = 1, onEnded = null }) {
            stop();
            const s = ctx.createBufferSource();
            s.buffer = buffer;
            s.playbackRate.value = rate;
            s.connect(gain);
            s.onended = () => {
                if (source === s) {
                    source = null;
                    onEnded?.();
                }
            };
            if (bufferOffset < buffer.duration) s.start(Math.max(when, ctx.currentTime), Math.max(0, bufferOffset));
            source = s;
            return s;
        },
        stop,
        async pause() {
            if (ctx.state === "running") await ctx.suspend();
        },
        async resume() {
            if (ctx.state !== "running") await ctx.resume();
        },
        setVolume(v) {
            gain.gain.value = clampVolume(v);
        },
        async close() {
            stop();
            try { await ctx.close(); } catch { /* already closed */ }
        },
    };
}

export function clampVolume(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.6;
}
