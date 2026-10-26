// The Skin tab's preview plays a short built-in 4K pattern on a loop: a stream, jumps, a chord, a few holds, at
// 170 BPM. Notes { t, col, end? } (ms, end only for holds); the autoplay hits every note on time.
export const BPM = 170;
const BEAT = 60000 / BPM;
const Q = BEAT / 4;

function make() {
    const notes = [];
    const add = (beat16, col, holdBeats16 = 0) => {
        const t = Math.round(beat16 * Q);
        notes.push(holdBeats16 ? { t, col, end: Math.round((beat16 + holdBeats16) * Q) } : { t, col });
    };
    let b = 0;
    // a stream: two bars of 1/4
    const stream = [0, 1, 2, 3, 1, 2, 0, 3, 2, 1, 3, 0, 1, 3, 2, 0];
    for (let i = 0; i < 32; i += 1) add(b + i, stream[i % stream.length]);
    b += 32;
    // jumps and a chord
    const jumps = [[0, 2], [1, 3], [0, 3], [1, 2], [0, 1, 3], [2], [1, 2, 3], [0]];
    jumps.forEach((cols, i) => cols.forEach((c) => add(b + i * 2, c)));
    b += 16;
    // holds with notes around them
    add(b, 0, 8);
    add(b + 2, 2);
    add(b + 4, 3);
    add(b + 6, 2);
    add(b + 8, 1, 6);
    add(b + 8, 3, 6);
    add(b + 10, 0);
    add(b + 12, 2);
    add(b + 16, 2, 12);
    add(b + 18, 0);
    add(b + 20, 1);
    add(b + 22, 0);
    add(b + 24, 3, 4);
    b += 32;
    return { notes: notes.sort((x, y) => x.t - y.t || x.col - y.col), length: Math.round(b * Q) };
}

export const PATTERN = Object.freeze(make());

// What the autoplay shows at a time in the loop: the judgement each note gets (mostly the best, a few others so all
// show), cycling through the notes.
const JUDGE_CYCLE = ["Hit300g", "Hit300g", "Hit300g", "Hit300", "Hit300g", "Hit300g", "Hit200", "Hit300g", "Hit300", "Hit100", "Hit300g", "Hit50", "Hit300g", "Hit0"];
export const judgementOf = (index) => JUDGE_CYCLE[index % JUDGE_CYCLE.length];

// The state at loop time `now` (0 ≤ now < length): which columns are held, the last hit of each column and the
// latest judgement. → { pressed: [bool×4], hold: [bool×4], lastHit: [ms since | null ×4], judgement: { key, since } | null }
export function autoplayAt(now, pattern = PATTERN) {
    const pressed = [false, false, false, false];
    const hold = [false, false, false, false];
    const lastHit = [null, null, null, null];
    let judgement = null;
    pattern.notes.forEach((n, i) => {
        // a note of the previous loop still counts just after the wrap
        const times = [n.t, n.t - pattern.length];
        for (const t of times) {
            const end = n.end !== undefined ? n.end - (t === n.t ? 0 : pattern.length) : t + 70;
            if (t <= now && now <= end) {
                pressed[n.col] = true;
                if (n.end !== undefined) hold[n.col] = true;
            }
            if (t <= now && (lastHit[n.col] === null || now - t < lastHit[n.col])) lastHit[n.col] = now - t;
            if (t <= now && (!judgement || now - t < judgement.since)) judgement = { key: judgementOf(i), since: now - t };
        }
    });
    return { pressed, hold, lastHit, judgement };
}
