// Sub-patterns ("flavours") of the six pattern families: what each one is, which family it belongs to (so the learned
// model, the playability guard and the dan search keep working on the family), the LeoBlack finder's name for it when
// the finder has one, the guard limits that differ from the family's, and the motif weights that bend row choice
// towards it. A row is a 4-bit mask (bit c = column c; hands are columns {0,1} and {2,3}).
// motifWeights(id, recent, phrase) → Float64Array(16): a weight per mask 1..15 for the next row, given the rows
// before it (newest first). The motif's state (roll direction, trill length, held column …) is read off those rows;
// `phrase` (an integer the plan gives each phrase) picks the anchor column, the trill pair or the slide direction,
// so phrases differ and every column gets its turn.
import { t } from "../i18n/i18n.js";

export const FAMILY_FLAVOURS = {
    Stream: ["Rolls", "Trills", "Minitrills", "RunningMan"],
    Jumpstream: ["Jumptrill", "SplitTrill", "Anchor", "Dumpstream"],
    Handstream: ["ChordTrills", "DenseHandstream", "JumpyHandstream"],
    Chordjack: ["Handjack", "Jumpjack", "Quadhand", "Quadstream"],
    Jack: ["Minijacks", "Longjacks", "Gluts", "Speedjacks"],
    Tech: ["Coordination", "JackyStream"],
};

// The finder's 4K sub-type names (vendor/leoblack/js/patterns/patternsDef.js SPECIFIC_4K) of the flavours it knows.
export const FINDER_NAME = {
    Rolls: "Rolls", Trills: "Trills", Minitrills: "Minitrills",
    Jumptrill: "Jumptrill", SplitTrill: "Split Trill",
    Quadstream: "Quadstream",
    Minijacks: "Minijacks", Longjacks: "Longjacks", Gluts: "Gluts",
};

export const FLAVOUR_IDS = Object.values(FAMILY_FLAVOURS).flat();
export const FLAVOUR_FAMILY = Object.fromEntries(Object.entries(FAMILY_FLAVOURS).flatMap(([family, ids]) => ids.map((id) => [id, family])));
export const familyOfFlavour = (id) => FLAVOUR_FAMILY[id] ?? null;
export const flavoursOf = (family) => FAMILY_FLAVOURS[family] ?? [];
export const isFlavour = (id) => Object.hasOwn(FLAVOUR_FAMILY, id);

// Names and one-line hints in the current language (src/i18n/messages/gen.js).
export const flavourName = (id) => t(`gen.flavour.${id}`);
export const flavourHint = (id) => t(`gen.flavour.${id}.hint`);

// Guard limits that differ from the family's (playability.js LIMITS): only what the flavour needs to exist at all.
// - RunningMan, Anchor: one column on every other row is the pattern, so the 16-row anchor cap goes up, one hand may
//   carry up to 75% of the notes, and the pull towards even columns is weaker. They still never jack that column
//   (the family's jack limit stays), so nothing gets faster for the finger than in the family itself.
// - Longjacks: a column held for 6–12 rows by definition; the Jack family already allows that length, only the pull
//   towards even columns (which fights the held column) is weaker.
// Trills and minitrills need no exception: a 4-note trill keeps each of its columns at 50% of 16 rows, within the
// Stream cap; what kept trills out of plain streams was the rule generator's own choice, not the guard.
export const FLAVOUR_LIMITS = {
    RunningMan: { anchor: 0.62, hand: [0.25, 0.75], columnPull: 1 },
    Anchor: { anchor: 0.72, hand: [0.25, 0.75], columnPull: 1 },
    Longjacks: { columnPull: 1 },
};

// ---- masks ----
const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
const lowCol = (m) => 31 - Math.clz32(m & -m);
const highCol = (m) => 31 - Math.clz32(m);
const bit = (c) => 1 << c;
const comp = (m) => 15 & ~m;
const RING = [3, 6, 12, 9]; // [01] [12] [23] [03]: neighbours share one column
// The finder's direction of a row against the row before it: 1 right, -1 left, 0 anything else.
export function direction(prev, cur) {
    if (!prev || !cur) return 0;
    const lo = lowCol(cur) - lowCol(prev);
    const hi = highCol(cur) - highCol(prev);
    if (lo > 0 && hi > 0) return 1;
    if (lo < 0 && hi < 0) return -1;
    return 0;
}
// how many rows in a row (newest first) hold column c
const runOf = (recent, c) => {
    let k = 0;
    while (k < recent.length && recent[k] & bit(c)) k += 1;
    return k;
};
// ABAB… alternation of single rows ending at recent[0]: its length (2 = just two different singles), or 0
function altLength(recent) {
    const [p, q] = recent;
    if (!p || !q || popcount(p) !== 1 || popcount(q) !== 1 || p === q) return 0;
    let k = 0;
    while (k + 2 < recent.length && recent[k] === recent[k + 2]) k += 1;
    return k + 2;
}

const HIT = 1;
const OFF = 0.01; // off the motif: 14 such rows together stay a few percent of one motif row
const RARE = 0.0004; // a row of the wrong size for the motif (a dozen such rows together stay well under 1%)
const NONE = 0.0005; // practically never, but the guard may leave nothing else

function table(fn) {
    const w = new Float64Array(16);
    for (let m = 1; m < 16; m += 1) w[m] = fn(m);
    return w;
}

// ---- Stream ----
// the last four rows (newest first) are a whole sweep: four singles moving one way
const sweptFour = (recent) => recent.length >= 4 && recent.slice(0, 4).every((m) => popcount(m) === 1)
    && direction(recent[3], recent[2]) !== 0 && direction(recent[3], recent[2]) === direction(recent[2], recent[1])
    && direction(recent[2], recent[1]) === direction(recent[1], recent[0]);

function rolls(recent) {
    const [p = 0, q = 0, , r3 = 0] = recent;
    const swept = sweptFour(recent);
    const sweeping = popcount(p) === 1 && popcount(q) === 1 ? Math.sign(lowCol(p) - lowCol(q)) : 0;
    // the column the sweep goes to next: on in its direction, or in from the edge it starts at
    let next = -1;
    if (popcount(p) === 1) {
        const c = lowCol(p);
        if (sweeping && c + sweeping >= 0 && c + sweeping <= 3) next = c + sweeping;
        else if (c === 0 || c === 3) next = c === 0 ? 1 : 2;
        if (next >= 0 && bit(next) === q) next = -1; // that would bounce (A B A reads as a minitrill)
    }
    return table((m) => {
        if (popcount(m) !== 1) return RARE;
        if (m & p) return NONE;
        if (m === q) return OFF;
        // right after a whole sweep only one column is left: not the last (a jack), not the one before (a bounce,
        // A B A reads as a minitrill), not the sweep's first (the finder's stream needs a roll's 1st and 5th note to
        // differ); it links to the edge the next sweep starts from
        if (swept) return m === r3 ? OFF * 0.1 : HIT;
        const c = lowCol(m);
        if (next >= 0) return c === next ? HIT : OFF;
        return c === 0 || c === 3 ? 0.6 : 0.05; // a link to the edge the next sweep starts from
    });
}

// Two-column trills of `length` notes, then the next pair. A trill longer than 4 notes is no stream to the finder
// (its 1st and 5th notes are the same), so trills are 4 notes and minitrills 3. The next trill keeps the last note of
// the one before every other time (A B A B C B C B D A D A …): the finder then sees trills only, and no column stays
// on every other row (a running man). A minitrill's next pair is always a fresh one (A B A C D C …).
function trills(recent, length) {
    const [p = 0, q = 0, r2 = 0, r3 = 0, r4 = 0, r5 = 0, r6 = 0] = recent;
    const alt = altLength(recent);
    // p is the first note after a finished trill (q r2 q r2 before it)
    const after = alt === 2 && popcount(q) === 1 && q === r3 && (length === 3 ? r2 !== 0 : r2 === r4);
    let fresh = false;
    if (after && length === 3) fresh = true;
    // the finished trill kept a note of the trill before it: this one starts fresh
    if (after && length === 4 && r5 && r6) fresh = Boolean((q | r2) & (r5 | r6));
    return table((m) => {
        if (popcount(m) !== 1) return RARE;
        if (m & p) return NONE;
        if (alt >= length) return m === q ? OFF : HIT;
        if (fresh) return m === q || m === r2 ? OFF : HIT;
        if (alt >= 2) return m === q ? HIT : OFF;
        return 0.5;
    });
}

function runningMan(recent, phrase) {
    const a = bit([0, 3, 1, 2][phrase & 3]);
    const [p = 0, q = 0] = recent;
    return table((m) => {
        if (popcount(m) !== 1) return RARE;
        if (m & p) return NONE;
        if (p === a) return m === q ? 0.3 : HIT; // around the anchor, a different column each time
        return m === a ? HIT : OFF;
    });
}

// ---- Jumpstream ----
function jumptrill(recent) {
    const [p = 0] = recent;
    return table((m) => {
        if (m & p) return NONE;
        if (p === 3) return m === 12 ? HIT : OFF;
        if (p === 12) return m === 3 ? HIT : OFF;
        if (m === 3 || m === 12) return HIT;
        return popcount(m) === 2 ? 0.1 : OFF;
    });
}

function splitTrill(recent, phrase) {
    const [a, b] = phrase & 1 ? [9, 6] : [5, 10];
    const [p = 0] = recent;
    return table((m) => {
        if (m & p) return NONE;
        if (p === a) return m === b ? HIT : OFF;
        if (p === b) return m === a ? HIT : OFF;
        if (m === a || m === b) return HIT;
        if (m === 5 || m === 10 || m === 9 || m === 6) return 0.3; // the other split pair
        return popcount(m) === 2 ? OFF : OFF;
    });
}

function anchor(recent, phrase) {
    const a = bit([0, 3, 1, 2][phrase & 3]);
    const [p = 0] = recent;
    return table((m) => {
        if (m & p) return NONE;
        const n = popcount(m);
        if (n > 2) return RARE;
        if (p & a) return m & a ? NONE : n === 1 ? HIT : 0.8; // never on two rows in a row: an anchor, not a jack
        if (m & a) return n === 2 ? HIT : 0.6;
        return OFF;
    });
}

// Jumps and singles climbing one way (both edges move the same way), turning at the edges; a turn goes to a row that
// leaves room for the next step, so every climb has at least two steps.
function dumpstream(recent) {
    const [p = 0, q = 0] = recent;
    const d = direction(q, p);
    const room = (m, dir) => (dir > 0 ? highCol(m) < 3 : lowCol(m) > 0);
    const blocked = !d || !room(p, d);
    return table((m) => {
        if (m & p) return NONE;
        const n = popcount(m);
        if (n > 2) return OFF;
        const chordy = n === 2 || popcount(p) === 2;
        const dm = direction(p, m);
        let w;
        if (!dm) w = OFF;
        else if (d && dm === d) w = chordy ? HIT : 0.6;
        else if (blocked) w = (room(m, dm) ? HIT : 0.25) * (chordy ? 1 : 0.6);
        else w = 0.1;
        return m === q ? w * 0.3 : w;
    });
}

// ---- Handstream ----
const isHand = (m) => popcount(m) === 3;
// a hand and the single left over, in turns, for up to 6 rows; then a jump moves it to another shape
function chordTrills(recent) {
    const [p = 0, q = 0] = recent;
    let chain = 0;
    while (chain + 1 < recent.length && (recent[chain] | recent[chain + 1]) === 15 && !(recent[chain] & recent[chain + 1])
        && (isHand(recent[chain]) || isHand(recent[chain + 1]))) chain += 1;
    return table((m) => {
        if (m & p) return NONE;
        if (isHand(p)) return m === comp(p) ? HIT : OFF;
        if (popcount(p) === 1) {
            if (chain >= 5) return popcount(m) === 2 ? HIT : m === comp(p) ? OFF : OFF;
            return m === comp(p) ? HIT : OFF;
        }
        if (popcount(p) === 2) return popcount(m) === 1 && m !== q ? HIT : OFF;
        return isHand(m) ? 0.8 : 0.1;
    });
}

// a hand every third row: hand, single, single, hand (the shapes turn by themselves)
function denseHandstream(recent) {
    const [p = 0, q = 0] = recent;
    return table((m) => {
        if (m & p) return NONE;
        const n = popcount(m);
        if (isHand(p)) return n === 1 ? HIT : OFF;
        if (n > 3) return RARE;
        if (popcount(p) === 1 && isHand(q)) return n === 1 ? HIT : OFF;
        if (popcount(p) === 1) return isHand(m) ? HIT : OFF;
        return isHand(m) ? 0.8 : 0.2;
    });
}

// hand, single, jump, single, hand …
function jumpyHandstream(recent) {
    const [p = 0, q = 0] = recent;
    return table((m) => {
        if (m & p) return NONE;
        const n = popcount(m);
        if (n > 3) return RARE;
        if (isHand(p) || popcount(p) === 2) return n === 1 ? HIT : OFF;
        if (popcount(p) === 1 && isHand(q)) return n === 2 ? HIT : OFF;
        if (popcount(p) === 1 && popcount(q) === 2) return isHand(m) ? HIT : OFF;
        return isHand(m) ? 0.8 : n === 2 ? 0.4 : 0.1;
    });
}

// ---- Chordjack ----
// a hand keeping two columns of the hand before; the column held longest is the one dropped, so no column is held
// for five rows (the finder would call that a longjack)
function rotatingHand(recent, m) {
    const [p = 0] = recent;
    if (!isHand(m) || popcount(m & p) !== 2) return 0;
    const dropped = lowCol(p & ~m);
    const runs = [0, 1, 2, 3].filter((c) => p & bit(c)).map((c) => runOf(recent, c));
    const longest = Math.max(1, ...runs);
    return 0.4 + 0.6 * (runOf(recent, dropped) / longest);
}

function handjack(recent) {
    const [p = 0] = recent;
    return table((m) => {
        const n = popcount(m);
        if (isHand(p)) {
            if (m === p) return 0.1;
            if (n === 3) return rotatingHand(recent, m) || OFF;
            return OFF;
        }
        if (n === 3) return m & p ? 0.8 : 0.5;
        return OFF;
    });
}

function jumpjack(recent) {
    const [p = 0, q = 0] = recent;
    return table((m) => {
        if (popcount(m) !== 2) return RARE;
        if (popcount(p) === 2) {
            if (q !== p) return m === p ? HIT : OFF;
            if (m === p) return 0.1;
            return m & p ? 0.5 : HIT;
        }
        return 0.8;
    });
}

function quadhand(recent) {
    const [p = 0] = recent;
    return table((m) => {
        const n = popcount(m);
        if (n < 3) return RARE;
        if (p === 15) return n === 3 ? HIT : 0.3;
        if (isHand(p)) {
            if (n === 4) return 0.8;
            if (m === p) return 0.2;
            return rotatingHand(recent, m) || 0.1;
        }
        return n === 4 ? 0.6 : 0.8;
    });
}

// quad, two rows of stream, a jump, quad … (the finder's quadstream: a quad jacking a chord, then rows without jacks)
function quadstream(recent) {
    const [p = 0] = recent;
    const since = recent.indexOf(15);
    return table((m) => {
        const n = popcount(m);
        if (since === 0) return n === 1 ? HIT : n === 2 ? 0.5 : OFF;
        if (since === 1) return m & p ? NONE : n === 1 ? HIT : n === 2 ? 0.4 : OFF;
        if (since === 2) return m & p ? NONE : n === 2 ? HIT : OFF;
        if (since === 3 || popcount(p) >= 2) return m === 15 ? HIT : OFF;
        return !(m & p) && n === 2 ? HIT : OFF;
    });
}

// ---- Jack ----
function minijacks(recent) {
    const [p = 0, q = 0, r2 = 0] = recent;
    return table((m) => {
        const n = popcount(m);
        if (n > 2) return RARE;
        if (n === 2 && popcount(p) === 2 && q !== p) return m === p ? HIT : OFF; // the jump is played twice
        if (m & p) return NONE;
        if (popcount(p) === 2 && q === p) return n === 1 ? HIT : 0.3; // … then away without a jack
        if (popcount(q) === 2 && r2 === q) return n === 2 ? HIT : 0.4; // a single between the pairs, then the next pair
        return n === 2 ? 0.8 : 0.3;
    });
}

function longjacks(recent) {
    const [p = 0, q = 0] = recent;
    const held = [0, 1, 2, 3].filter((c) => p & q & bit(c)).sort((a, b) => runOf(recent, b) - runOf(recent, a))[0];
    const run = held === undefined ? 0 : runOf(recent, held);
    return table((m) => {
        const n = popcount(m);
        if (n > 2) return RARE;
        if (held !== undefined && run < 8) {
            if (!(m & bit(held))) return OFF;
            if (m === p) return HIT;
            return n === 2 ? 0.8 : 0.3;
        }
        if (held !== undefined) return m & bit(held) ? NONE : n === 2 ? HIT : 0.5;
        if (popcount(p) === 2) return m === p ? HIT : m & p ? 0.5 : 0.1;
        return n === 2 ? 0.8 : 0.1;
    });
}

// jumps sliding round the ring [01] [12] [23] [03], one shared column at a time, every other jump played twice
function gluts(recent, phrase) {
    const dir = phrase & 1 ? -1 : 1;
    const step = (m) => RING[(RING.indexOf(m) + dir + 4) % 4];
    const [p = 0, q = 0, r2 = 0] = recent;
    let want = null;
    if (RING.includes(p)) {
        if (q === p) want = step(p);
        else if (RING.includes(q) && step(q) === p) want = r2 === q ? step(p) : p;
        else want = p;
    }
    return table((m) => {
        if (want !== null) return m === want ? HIT : RING.includes(m) && popcount(m & p) === 1 ? 0.1 : 0.01;
        return RING.includes(m) ? 0.8 : OFF;
    });
}

// short single-column jacks: 2–3 notes on a column, then the next column
function speedjacks(recent) {
    const [p = 0, q = 0] = recent;
    let run = 0;
    while (run < recent.length && recent[run] === p) run += 1;
    const before = recent[run] ?? 0;
    return table((m) => {
        if (popcount(m) !== 1) return RARE;
        if (popcount(p) !== 1) return HIT;
        if (m === p) return run < 2 ? HIT : run === 2 ? 0.5 : run === 3 ? 0.1 : OFF;
        if (run < 2) return 0.1;
        return m === before || m === q ? 0.5 : HIT;
    });
}

// ---- Tech ----
// one hand trills its two columns evenly, every other row; the other hand plays its own line in between
function coordination(recent, phrase) {
    const trillHand = phrase & 1 ? 12 : 3;
    const lineHand = comp(trillHand);
    const [p = 0] = recent;
    const lastTrill = recent.find((m) => m & trillHand) ?? 0;
    const nextTrill = lastTrill & trillHand ? trillHand & ~lastTrill : 0;
    return table((m) => {
        const t = m & trillHand;
        const l = m & lineHand;
        if (popcount(t) > 1 || popcount(l) > 1) return RARE;
        const trillOk = t && (!nextTrill || t === nextTrill) && !(t & p);
        if (p & trillHand && !(p & lineHand)) return !t && l && !(l & p) ? HIT : t && l && trillOk ? 0.15 : OFF;
        if (t && !l) return trillOk ? HIT : OFF;
        if (t && l) return trillOk && !(l & p) ? 0.2 : 0.01;
        return OFF;
    });
}

// a single-note stream with a two-note jack every few notes
function jackyStream(recent) {
    const [p = 0, q = 0] = recent;
    let since = recent.length;
    for (let k = 0; k + 1 < recent.length; k += 1) {
        if (recent[k] === recent[k + 1]) {
            since = k;
            break;
        }
    }
    return table((m) => {
        if (popcount(m) !== 1) return RARE;
        if (!p) return HIT;
        if (p === q) return m & p ? NONE : HIT;
        if (m === p) return since >= 3 ? Math.min(1.5, 0.3 * (since - 2)) : OFF;
        return m === q ? 0.2 : HIT;
    });
}

const MOTIFS = {
    Rolls: rolls,
    Trills: (r) => trills(r, 4),
    Minitrills: (r) => trills(r, 3),
    RunningMan: runningMan,
    Jumptrill: jumptrill,
    SplitTrill: splitTrill,
    Anchor: anchor,
    Dumpstream: dumpstream,
    ChordTrills: chordTrills,
    DenseHandstream: denseHandstream,
    JumpyHandstream: jumpyHandstream,
    Handjack: handjack,
    Jumpjack: jumpjack,
    Quadhand: quadhand,
    Quadstream: quadstream,
    Minijacks: minijacks,
    Longjacks: longjacks,
    Gluts: gluts,
    Speedjacks: speedjacks,
    Coordination: coordination,
    JackyStream: jackyStream,
};

// recent: masks of the rows before, newest first (0 or missing = none yet).
export function motifWeights(id, recent = [], phrase = 0) {
    const fn = MOTIFS[id];
    if (!fn) return null;
    return fn(recent.filter((m) => m > 0), phrase);
}

// How strongly a flavour bends the learned model's rows: P(mask) ∝ motif × (share of the mask among the model's
// continuations + PROPOSAL), so a motif row the human maps never had after this context still comes up.
export const PROPOSAL = 0.25;
