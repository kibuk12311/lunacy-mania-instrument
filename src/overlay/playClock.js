// The play's map time at any real moment, from tosu's frames, steady against their arrival jitter.
// A frame says the map time `live` at the moment tosu read it; it reaches us some delay later (tosu's poll, the
// websocket, our own event loop), and that delay varies by tens of ms, sometimes by hundreds when frames bunch up.
// Each frame gives the line  map(t) = live + rate·(t − at)  whose offset  live − rate·at  is the true one less
// rate·delay: the largest offset seen lately (the frame that came quickest) is the truest. A frame far off that
// line — a seek (osu!'s skip), the clock picking up after a pause, a retry, a rate change — starts it over.
// Real times are the caller's ms (performance.now in the app); map times are map ms.

export const WINDOW_MS = 4000; // frames this recent are weighed (a slow drift of the game's clock is followed)
export const JUMP_MS = 250; // map ms off the line that are no jitter but a jump

export function createPlayClock({ windowMs = WINDOW_MS, jumpMs = JUMP_MS } = {}) {
    let samples = []; // { at, off } oldest first
    let rate = 1;
    let best = null;

    const recompute = () => {
        best = samples.length ? Math.max(...samples.map((s) => s.off)) : null;
    };

    return {
        // a frame of a running play: map time `live` reached us at real time `at`
        sample(live, at, r = rate) {
            if (!Number.isFinite(live) || !Number.isFinite(at) || !(r > 0)) return;
            if (r !== rate) {
                rate = r;
                samples = [];
            }
            const off = live - rate * at;
            if (best !== null && (off > best + jumpMs || off < best - jumpMs)) samples = [];
            samples.push({ at, off });
            while (samples.length > 1 && samples[0].at < at - windowMs) samples.shift();
            recompute();
        },
        // the map time at real time t, or null before the first frame
        at: (t) => (best === null ? null : best + rate * t),
        reset() {
            samples = [];
            best = null;
        },
        samples: () => samples.length,
    };
}
