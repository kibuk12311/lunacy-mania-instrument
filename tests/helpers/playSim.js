// A made-up osu! stable mania play run through the overlay's session (src/overlay/session.js), deterministic (seeded):
// the presses a player really makes, the judgements tosu counts from them, tosu's frames as they reach the app (late
// by a varying delay, or not at all for a while when tosu's reading stalls and then a frame with everything at once),
// and, for the keyboard source, the same presses from the key reader (each at its own time, delivered in batches).
// Snapshots are taken every 33 ms like the app's; the KPS, the lane counts and the key-line bars in them are compared
// with the presses that really happened. Used by tests/overlayKbd.test.js and tools/measure-key-lines.mjs.
import { createOverlaySession } from "../../src/overlay/session.js";
import { smoothRate } from "../../src/overlay/kps.js";

export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 4K, 22 s: a 12-a-second stream, a 20-a-second burst from 8 to 11 s, a hold every 11th note
export function makeMap() {
    const notes = [];
    const cols = [0, 2, 1, 3, 1, 0, 3, 2];
    let t = 1000;
    let i = 0;
    while (t < 23000) {
        const fast = t >= 8000 && t < 11000;
        const col = cols[i % cols.length];
        const hold = i % 11 === 5 && !fast ? 160 : 0;
        notes.push({ t, col, end: hold ? t + hold : null });
        t += fast ? 50 : 83;
        i += 1;
    }
    return { keys: 4, notes };
}

// What the player does: each note pressed near its time (a few missed), released after a while or at the hold's end,
// and now and then a press on no note (mashing). → { presses: [{ col, down, up, note }], judgements: [{ at, kind }] }
export function makePlayer(map, rand) {
    const presses = [];
    const judgements = [];
    const busy = [[], [], [], []]; // per lane: [down, up]
    const free = (col, a, b) => busy[col].every(([x, y]) => b < x - 5 || a > y + 5);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    for (const note of map.notes) {
        if (rand() < 0.01) {
            judgements.push({ at: note.t + 150, kind: "miss" });
            if (note.end !== null) judgements.push({ at: note.end + 150, kind: "miss" });
            continue;
        }
        const down = note.t + Math.max(-45, Math.min(45, gauss() * 16));
        const up = note.end !== null ? note.end + Math.max(-30, Math.min(30, gauss() * 12)) : down + 30 + rand() * 25;
        if (!free(note.col, down, up)) continue;
        busy[note.col].push([down, up]);
        presses.push({ col: note.col, down, up, note: true });
        judgements.push({ at: down, kind: rand() < 0.8 ? "max" : "n300" });
        if (note.end !== null) judgements.push({ at: up, kind: "max" });
    }
    // mashing: presses with no note (no judgement)
    for (let t = 1500; t < 23000; t += 120 + rand() * 900) {
        const col = Math.floor(rand() * 4);
        const down = t;
        const up = t + 20;
        if (!free(col, down, up)) continue;
        busy[col].push([down, up]);
        presses.push({ col, down, up, note: false });
    }
    presses.sort((a, b) => a.down - b.down);
    judgements.sort((a, b) => a.at - b.at);
    return { presses, judgements };
}

// How tosu's frames reach the app. delay(): ms a frame is late; stall(readAt): true while tosu's reading is stuck
export const NETWORKS = {
    steady: { label: "steady (frames 0.5–3 ms late)", delay: (r) => 0.5 + r() * 2.5, stall: () => false },
    jitter: { label: "jitter (most frames 0–70 ms late)", delay: (r) => (r() < 0.35 ? 0.5 + r() * 1.5 : r() * 70), stall: () => false },
    bursts: {
        label: "jitter + tosu stalls (1.2 s every 4 s, then all at once)",
        delay: (r) => (r() < 0.35 ? 0.5 + r() * 1.5 : r() * 70),
        stall: (t) => t % 4000 > 2800, // 2800..4000 of every 4 s: no frame read
    },
};

// One play through the session. source: "map" (the judgements, as today) or "kbd" (the key reader's presses too).
// rate: map ms per real ms (DT 1.5). → metrics and what the snapshots showed
export function simulatePlay({ source = "kbd", network = "jitter", seed = 1, rate = 1, syncError = 0.3, batchMs = 16 } = {}) {
    const rand = mulberry32(seed);
    const map = makeMap();
    const player = makePlayer(map, rand);
    const net = NETWORKS[network];
    const START = 200; // real ms at which the map's clock is 0
    const real = (mapMs) => START + mapMs / rate; // the real time of a map time
    const END = real(23500);
    const events = []; // { at (delivered, real ms), kind, ... }
    let readAt = START - 100;
    while (readAt < END) {
        const live = (readAt - START) * rate;
        if (!net.stall(live)) {
            const hits = { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 };
            for (const j of player.judgements) {
                if (j.at > live) break;
                hits[j.kind] += 1;
            }
            const frame = {
                state: "playing", client: "stable", mode: 3, checksum: "sim", rate, mods: rate === 1.5 ? ["DT"] : [],
                liveMs: live, hits, accuracy: null, ur: null, hitErrors: [],
            };
            events.push({ at: readAt + net.delay(rand), kind: "frame", frame });
        }
        readAt += 100;
    }
    // frames keep their order: each is delivered no earlier than the one before
    let last = -Infinity;
    for (const e of events) {
        e.at = Math.max(e.at, last + 0.01);
        last = e.at;
    }
    events.push({ at: START + 60, kind: "map" }); // the map's notes are fetched once the play starts
    if (source === "kbd") {
        // the key reader: every press and release at its own real time; written out by the helper in batches
        for (const p of player.presses) {
            for (const [down, t] of [[true, p.down], [false, p.up]]) {
                const at = real(t);
                events.push({ at: Math.ceil(at / batchMs) * batchMs + 0.2, kind: "key", col: p.col, down, time: at + syncError });
            }
        }
    }
    for (let t = START; t < END; t += 33) events.push({ at: t, kind: "snap" });
    events.sort((a, b) => a.at - b.at || (a.kind === "snap") - (b.kind === "snap"));

    const s = createOverlaySession();
    const bars = new Map(); // `${col}:${start}` → { col, start, end }
    const kpsErr = [];
    let kpsMax = 0;
    const truthReal = player.presses.map((p) => p.down / rate).sort((a, b) => a - b); // KPS runs in real time
    for (const e of events) {
        if (e.kind === "frame") s.onFrame(e.frame, e.at);
        else if (e.kind === "map") s.setMap("sim", map);
        else if (e.kind === "key") s.onKey({ col: e.col, down: e.down, at: e.time, keys: 4 });
        else {
            const snap = s.snapshot(e.at);
            if (snap.phase !== "playing") continue;
            for (const b of snap.lanes.bars) bars.set(`${b.col}:${b.start}`, b);
            // the KPS shown against the presses made by now (KPS at the real moment of the snapshot)
            const truth = smoothRate(truthReal, (e.at - START));
            // from 1.5 s in to the last notes (after them the play's clock stands once no frame or key says it runs)
            if (e.at > START + 1500 && e.at < real(22500)) kpsErr.push(Math.abs(snap.kps.now - truth));
            kpsMax = snap.kps.max;
        }
    }
    const final = s.snapshot(END);
    // the true max on the KPS meter's grid
    let trueMax = 0;
    for (let g = 0; g < (END - START); g += 100) trueMax = Math.max(trueMax, smoothRate(truthReal, g));
    // each real press → the bar of its lane that starts closest to it
    const byCol = [[], [], [], []];
    for (const b of bars.values()) byCol[b.col].push(b);
    const startErr = [];
    const endErr = [];
    let unmatched = 0;
    for (const p of player.presses) {
        let best = null;
        for (const b of byCol[p.col]) if (!best || Math.abs(b.start - p.down) < Math.abs(best.start - p.down)) best = b;
        if (!best || Math.abs(best.start - p.down) > 100) {
            unmatched += 1;
            continue;
        }
        startErr.push(Math.abs(best.start - p.down));
        if (best.end !== null) endErr.push(Math.abs(best.end - p.up));
    }
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))] : 0);
    return {
        source: final.lanes.source,
        presses: player.presses.length,
        ghost: player.presses.filter((p) => !p.note).length,
        counted: final.lanes.counts.reduce((a, b) => a + b, 0),
        bars: bars.size,
        unmatched,
        startMean: mean(startErr),
        startP95: pct(startErr, 0.95),
        startMax: Math.max(0, ...startErr),
        endMean: mean(endErr),
        kpsNowMean: mean(kpsErr),
        kpsNowMax: Math.max(0, ...kpsErr),
        kpsMax,
        trueMax,
    };
}
