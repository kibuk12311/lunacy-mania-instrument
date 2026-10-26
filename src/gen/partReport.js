// Blocks (the generator's own units inside song parts: one pattern family, at least 32 slots) and the report of
// every part: its families, how well its notes read as them, and its dan "as if played on its own".
import { patternScore, flavourAwareScore, planShares } from "./search.js";
import { detectedFlavours } from "./flavourMetrics.js";
import { excerptOsu } from "./excerpt.js";
import { numericToLabel } from "../core/labels.js";

const MIN_BLOCK_SLOTS = 32;
const MIXED_BLOCK_SLOTS = 32;
const MIN_SCORED_ROWS = 24;
// what the pattern finder can tell apart; Tech (uneven rhythm) is not one of its clusters
const JUDGED = new Set(["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack"]);

// Blocks: runs of slots inside one part with one family ("sections") or 32-slot chunks ("mixed"). A block under
// 32 slots joins the block before it in its part (or the one after). Empty parts (family null) have none.
// → [{ index, part, inPart, i0, i1, startMs, endMs, families }], i1 exclusive.
export function planBlocks(assign, slots, partOf, mix) {
    const runs = [];
    for (let i = 0; i < slots.length; i += 1) {
        if (assign[i] === null || assign[i] === undefined) continue;
        const last = runs.at(-1);
        const sameRun = last && last.i1 === i && last.part === partOf[i]
            && (mix === "mixed" ? i - last.i0 < MIXED_BLOCK_SLOTS : assign[i] === assign[i - 1]);
        if (sameRun) last.i1 = i + 1;
        else runs.push({ part: partOf[i], i0: i, i1: i + 1 });
    }
    const merged = [];
    for (const r of runs) {
        const last = merged.at(-1);
        if (last && last.part === r.part && (r.i1 - r.i0 < MIN_BLOCK_SLOTS || last.i1 - last.i0 < MIN_BLOCK_SLOTS)) last.i1 = r.i1;
        else merged.push({ ...r });
    }
    const inPart = new Map();
    return merged.map((b, index) => {
        const families = [...new Set(assign.slice(b.i0, b.i1).filter(Boolean))];
        const n = inPart.get(b.part) ?? 0;
        inPart.set(b.part, n + 1);
        const last = slots[b.i1 - 1];
        const endMs = b.i1 < slots.length ? slots[b.i1].t : last.t + (last.beatMs ?? 60000 / last.bpm) / (last.div ?? 4);
        return { index, part: b.part, inPart: n, i0: b.i0, i1: b.i1, startMs: slots[b.i0].t, endMs, families };
    });
}

const rowsOf = (rows, startMs, endMs) => rows.filter((r) => r.t >= startMs && r.t < endMs);

// The finder's family score of `families` with what it cannot judge (Tech) left out; 0 when it judges none of them.
const judgedScore = (top3, families) => {
    const judged = families.filter((f) => JUDGED.has(f));
    return judged.length ? patternScore(top3, judged) : 0;
};

// How much of a block reads as its families to the pattern finder (0..1), or null: under 24 rows, or a block with a
// family the finder can't judge (Tech, with or without a flavour: its score would sit below the redo bar by
// construction, so it is never redone for its score, as before flavours).
// A block with flavoured rows (row.flavour) gets the map search's score (search.js flavourAwareScore: the chosen
// flavours' coverage first, the families second), with the shares of its own slots when `assign` is given.
// patternsOf(osuText) → [{ name, share }]; render(rows) → osuText.
export function scoreBlock(rows, block, { patternsOf, render, assign = null }) {
    const mine = rowsOf(rows, block.startMs, block.endMs);
    if (mine.length < MIN_SCORED_ROWS) return null;
    const judged = block.families.filter((f) => JUDGED.has(f));
    if (!judged.length || judged.length < block.families.length) return null;
    const top3 = patternsOf(render(mine));
    if (!mine.some((r) => r.flavour)) return patternScore(top3, judged);
    return flavourAwareScore({
        rows: mine, top3, families: block.families, familyScoreOf: (fams) => patternScore(top3, fams),
        shares: assign ? planShares(assign, block.i0, block.i1) : null,
    }).score;
}

// PartReport[] for the parts: families (from the blocks), the rows' count, the issues in it, how many blocks were
// redone, and for a part with 24 rows or more its dan measured on an excerpt (excerpt.js) with the pattern score;
// the flavours planned in it with how well they came out (flavourScore), and the flavours our detector finds there.
// options: { analyze(osuText, rate), timing, issues, retried: Map(part → blocks redone), locked: Set(part),
// onProgress({ i, n }), assign (the family per slot: the flavour score's shares) }.
export async function describeParts(rows, parts, blocks, { analyze, timing, issues = [], retried = new Map(), locked = new Set(), onProgress = null, assign = null }) {
    const out = [];
    for (let p = 0; p < parts.length; p += 1) {
        const part = parts[p];
        onProgress?.({ i: p, n: parts.length });
        const mine = rowsOf(rows, part.startMs, part.endMs);
        const families = [...new Set(blocks.filter((b) => b.part === p).flatMap((b) => b.families))];
        const report = {
            index: p, startMs: part.startMs, endMs: part.endMs, kind: part.kind, families,
            wanted: part.range ?? null, empty: !!part.empty, locked: locked.has(p),
            noteCount: mine.reduce((s, r) => s + (r.cols?.length ?? popcount(r.mask)), 0),
            patternScore: null, dan: null, inRange: null,
            issues: issues.filter((x) => x.t >= part.startMs && x.t < part.endMs).length,
            retried: retried.get(p) ?? 0,
            flavours: [...new Set(mine.map((r) => r.flavour).filter(Boolean))],
            flavourScore: null,
            detected: mine.length >= MIN_SCORED_ROWS ? detectedFlavours(mine, 3) : [],
        };
        let top3 = null;
        if (!part.empty && mine.length >= MIN_SCORED_ROWS) {
            const result = await analyze(excerptOsu(mine, part, timing), 1);
            if (result?.kind === "ok") {
                top3 = result.top3 ?? [];
                report.dan = { numeric: result.numeric, label: numericToLabel(result.numeric).text, top3 };
                const judged = families.filter((f) => JUDGED.has(f));
                report.patternScore = judged.length ? patternScore(result.top3, judged) : null;
            }
        }
        // the flavours by the searches' own score (the finder's part only when the excerpt was analysed)
        if (report.flavours.length && mine.length >= MIN_SCORED_ROWS) {
            const own = blocks.filter((b) => b.part === p);
            const shares = assign && own.length ? planShares(assign, own[0].i0, own.at(-1).i1) : null;
            const { flavourScore } = flavourAwareScore({ rows: mine, top3, families, familyScoreOf: (fams) => judgedScore(top3, fams), shares });
            report.flavourScore = Math.round(flavourScore * 1000) / 1000;
        }
        if (report.wanted && report.dan) report.inRange = report.dan.numeric >= report.wanted.lo && report.dan.numeric < report.wanted.hi;
        out.push(report);
    }
    return out;
}

const popcount = (m) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));
