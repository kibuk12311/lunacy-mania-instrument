// Synthetic Interlude plays for tests: the Replay blob as scores.db keeps it (gzip of an int32 count, then per frame a
// float32 time and a uint16 key mask; prelude Replay.fs), the frames of made-up key presses, and charts in the shape
// decodeChart gives. Nothing here comes from a real play or a real chart.
import { gzipSync } from "node:zlib";
import { NOTE } from "../../src/interlude/chart.js";

// frames [{ time, mask }] (ms of the chart from its first note) → the Replay blob. count: the count to write, to make a
// damaged one.
export function makeIlReplay(frames, { count = frames.length } = {}) {
    const bytes = Buffer.alloc(4 + frames.length * 6);
    bytes.writeInt32LE(count, 0);
    frames.forEach(({ time, mask }, i) => {
        bytes.writeFloatLE(time, 4 + i * 6);
        bytes.writeUInt16LE(mask, 8 + i * 6);
    });
    return gzipSync(bytes);
}

// The frames as readIlReplay gives them.
export const framesOf = (frames) => ({ times: Float32Array.from(frames, (f) => f.time), masks: Uint16Array.from(frames, (f) => f.mask) });

// A replay built press by press, as Prelude's own tests build theirs: each call adds a frame with the keys' new state.
export function replayBuilder() {
    const frames = [];
    let mask = 0;
    const r = {
        down(t, k = 0) { mask |= 1 << k; frames.push({ time: Math.fround(t), mask }); return r; },
        up(t, k = 0) { mask &= ~(1 << k); frames.push({ time: Math.fround(t), mask }); return r; },
        downUntil(t, until, k = 0) { return r.down(t, k).up(until, k); },
        downFor(t, length, k = 0) { return r.downUntil(t, t + length, k); },
        frames: () => frames,
        build: () => framesOf(frames),
    };
    return r;
}

// Presses [{ t, col, up }] (ms of the chart from its first note) → the frames: one per change of the keys, in time order.
export function framesOfPresses(presses) {
    const changes = presses.flatMap((p) => [{ time: p.t, col: p.col, down: true }, { time: p.up, col: p.col, down: false }]);
    changes.sort((a, b) => a.time - b.time || Number(a.down) - Number(b.down));
    const frames = [];
    let mask = 0;
    for (const c of changes) {
        mask = c.down ? mask | (1 << c.col) : mask & ~(1 << c.col);
        const time = Math.fround(c.time);
        if (frames.length && frames.at(-1).time === time) frames.at(-1).mask = mask;
        else frames.push({ time, mask });
    }
    return frames;
}

// A chart as Prelude's tests write one: note(t, k), hold(t, until, k), in time order → { keys, notes, bpm, sv }.
export function chartBuilder(keys = 4, { msPerBeat = 500 } = {}) {
    const rows = [];
    const rowAt = (time) => {
        let row = rows.find((r) => r.time === time);
        if (!row) {
            row = { time, data: new Array(keys).fill(NOTE.NOTHING) };
            rows.push(row);
            rows.sort((a, b) => a.time - b.time);
        }
        return row;
    };
    const b = {
        note(t, k = 0) { rowAt(Math.fround(t)).data[k] = NOTE.NORMAL; return b; },
        hold(t, until, k = 0) {
            rowAt(Math.fround(t)).data[k] = NOTE.HOLDHEAD;
            rowAt(Math.fround(until)).data[k] = NOTE.HOLDTAIL;
            return b;
        },
        build() {
            // hold bodies on the rows between a head and its tail, as charts.db keeps them
            const open = new Array(keys).fill(false);
            for (const row of rows) {
                for (let k = 0; k < keys; k += 1) {
                    if (row.data[k] === NOTE.HOLDHEAD) open[k] = true;
                    else if (row.data[k] === NOTE.HOLDTAIL) open[k] = false;
                    else if (open[k] && row.data[k] === NOTE.NOTHING) row.data[k] = NOTE.HOLDBODY;
                }
            }
            return { keys, notes: rows.map((r) => ({ time: r.time, data: [...r.data] })), bpm: [{ time: rows[0]?.time ?? 0, data: { meter: 4, msPerBeat } }], sv: [] };
        },
    };
    return b;
}
