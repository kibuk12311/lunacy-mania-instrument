// Result view of the create tab (mapgen v3): one section per difficulty holding its variant cards, at most 6
// (the oldest card that is not the best goes). A card shows its name, the dan with ✓ / ≈, the pattern match, the
// row stats, the grid and model lines, retries, the problem spots (5, then «ещё n») and its parts with lock toggles,
// «лучший» on the best card, «Взять этот», and «Перегенерировать незакреплённое» once a part is locked.
import { t } from "../../src/i18n/i18n.js";
import { confidenceWord } from "../../src/core/labels.js";
import { clockText } from "./snapColors.js";
import { rangeText } from "./timeline.js";
import { isDetailed, patternsInMode } from "./patternMode.js";
import { flavourName } from "../../src/gen/flavours.js";

export const MAX_CARDS = 6;
const SHOWN_ISSUES = 5;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ISSUE_KEYS = {
    jack: "create.issue.jack", anchor: "create.issue.anchor", hand: "create.issue.hand",
    spike: "create.issue.spike", fastJack: "create.issue.fastJack", columns: "create.issue.columns",
};
const MODEL_KEYS = { "nn-v1": "create.model.neural", "xgb-v1": "create.model.trees", "xgb-v2": "create.model.trees", rules: "create.model.rules" };

const middle = (r) => (r.lo + r.hi) / 2;
const inRange = (v, r) => Number.isFinite(v.result?.numeric) && v.result.numeric >= r.lo && v.result.numeric < r.hi;

// The ranking rankVariants (src/gen/variants.js) does, for when that module is not there: in range first, then the
// pattern score rounded to 0.05 (higher first), then fewer problem spots, then nearer the middle of the range.
export function rankFallback(list, range) {
    const score = (v) => Math.round((Number(v.patternScore) || 0) / 0.05);
    return [...list].sort((a, b) =>
        Number(inRange(b, range)) - Number(inRange(a, range))
        || score(b) - score(a)
        || (a.issues?.length ?? 0) - (b.issues?.length ?? 0)
        || Math.abs((a.result?.numeric ?? Infinity) - middle(range)) - Math.abs((b.result?.numeric ?? Infinity) - middle(range)));
}

// A difficulty: its range and its cards ({ id, answer, letter, locks, ...extra }), the best and the chosen card.
export const newDiff = (range) => ({ range, cards: [], bestId: null, selectedId: null, made: 0 });

// Ranks the cards with rank(answers, range) → answers best first (copies are fine) and picks the best.
export function rerank(diff, rank = rankFallback) {
    if (!diff.cards.length) {
        diff.bestId = null;
        return diff;
    }
    const sorted = rank(diff.cards.map((c) => c.answer), diff.range) ?? [];
    const first = sorted[0];
    const best = diff.cards.find((c) => c.answer === first) ?? diff.cards.find((c) => c.id === first?.id) ?? diff.cards[0];
    diff.bestId = best.id;
    return diff;
}

// A new variant (a generate-map answer) for this difficulty; after ranking the best card is the chosen one.
export function addVariant(diff, answer, { rank = rankFallback, extra = {} } = {}) {
    diff.cards.push({ id: answer.id, answer, letter: LETTERS[diff.made % LETTERS.length], locks: new Set(), ...extra });
    diff.made += 1;
    rerank(diff, rank);
    while (diff.cards.length > MAX_CARDS) {
        const drop = diff.cards.findIndex((c) => c.id !== diff.bestId && c.id !== diff.selectedId);
        diff.cards.splice(drop >= 0 ? drop : 0, 1);
    }
    diff.selectedId = diff.bestId;
    return diff;
}

const pct = (share) => Math.round((Number(share) || 0) * 100);
const percentOf = (x) => Math.round(Number(x) > 1 ? Number(x) : Number(x) * 100);

// One problem spot as a line.
export function issueText(issue) {
    const key = ISSUE_KEYS[issue.kind];
    if (!key) return "";
    const ratio = Number(issue.ratio ?? issue.n);
    return t(key, {
        time: clockText(issue.t ?? 0), col: (issue.col ?? 0) + 1, n: issue.n ?? "?",
        pct: percentOf(issue.pct), ms: Math.round(Number(issue.ms) || 0), ratio: Number.isFinite(ratio) ? ratio.toFixed(1) : "?",
    });
}

// The patterns of a card in the General / Detailed mode: General, the analyser's patterns by family; Detailed, the
// flavours our detector found in the map (answer.flavours), else the analyser's names as flavours.
function mixText(answer, detailed) {
    const found = detailed ? (answer.flavours ?? []).slice(0, 3) : [];
    if (found.length) return found.map((f) => `${flavourName(f.id)} ${pct(f.share)}%`).join(" · ");
    return patternsInMode(answer.result?.top3, detailed).map((p) => `${p.name} ${pct(p.share)}%`).join(" · ");
}

// The text lines of a card, top to bottom: [{ text, cls }]; `detailed` is the Detailed mode.
export function cardLines(answer, range, { detailed = isDetailed() } = {}) {
    const lines = [];
    const add = (text, cls = "muted") => lines.push({ text, cls });
    const r = answer.result ?? {};
    const shownRange = answer.range ?? range;
    const found = { label: r.label ?? "—", numeric: Number.isFinite(r.numeric) ? r.numeric.toFixed(1) : "—", range: rangeText(shownRange) };
    if (answer.reachable) add(`✓ ${t("create.result.done", found)}`, "ok");
    else add(`≈ ${t("create.result.closest", found)}`, "warn");
    if (detailed && Number.isFinite(answer.flavourScore)) add(t("create.result.flavourMatch", { pct: Math.round(Math.min(1, answer.flavourScore) * 100) }));
    else if (Number.isFinite(answer.patternScore)) add(t("create.result.patternMatch", { pct: Math.round(Math.min(1, answer.familyScore ?? answer.patternScore) * 100) }));
    const mix = mixText(answer, detailed);
    // a map the analyser could not rate (too short, an error) has no confidence either
    const confidence = r.confidenceLevel ? confidenceWord(r.confidenceLevel) : r.confidence ?? "—";
    add(`${mix}${r.tech ? " · Tech" : ""}${mix ? " · " : ""}${t("create.result.stats", { notes: answer.noteCount, confidence })}`);
    const s = answer.stats;
    if (s?.sizeShares) {
        const [s1, s2, s3, s4] = s.sizeShares.map(pct);
        add(t("create.stats.sizes", { s1, s2, s3, s4 }));
    }
    if (s && Number.isFinite(s.leftShare)) add(t("create.stats.balance", { left: pct(s.leftShare), cols: (s.colShares ?? []).map(pct).join("/") }));
    if (s?.maxJack) add(t("create.stats.jacks", { all: s.maxJack.all, streamy: s.maxJack.streamy, nps: (Number(s.peakNps) || 0).toFixed(1) }));
    const g = answer.grid;
    if (g && (Number(g[3]) || Number(g[6]) || Number(g[8]))) add(t("create.result.grid", { n4: pct(g[4]), n3: pct(g[3]), n6: pct(g[6]), n8: pct(g[8]) }));
    const info = answer.modelInfo;
    if (info?.maps > 0) add(t("create.result.model", { kind: t(MODEL_KEYS[info.kind] ?? "create.model.trees"), maps: info.maps }));
    else if (answer.engine === "rules" || info?.kind === "rules") add(t("create.result.rules"));
    if (answer.retries?.blocks > 0) add(t("create.retry.blocks", { n: answer.retries.blocks }));
    if (answer.retries?.dan === "low") add(t("create.retry.danLow"));
    if (answer.retries?.dan === "high") add(t("create.retry.danHigh"));
    return lines;
}

// One part of a card as a line: General, its families and how well they read; Detailed, its planned flavours and
// how well they came out (or, without planned ones, the flavours found there).
export function partLine(report, { detailed = isDetailed() } = {}) {
    const span = `${clockText(report.startMs)}–${clockText(report.endMs)}`;
    if (report.empty) return `${span} · ${t("create.parts.empty")}`;
    let family = (report.families ?? []).join("+") || "—";
    let score = report.patternScore;
    if (detailed && report.flavours?.length) {
        family = report.flavours.map(flavourName).join("+");
        score = report.flavourScore;
    } else if (detailed && report.detected?.length) {
        family = report.detected.slice(0, 2).map((f) => flavourName(f.id)).join("+");
    }
    return t("create.part.row", {
        from: clockText(report.startMs), to: clockText(report.endMs), family,
        pct: Number.isFinite(score) ? pct(score) : "—", dan: report.dan?.label ?? "—",
    });
}

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

// root = #gen-result. The callbacks get the difficulty's index (easiest first) and the card's id:
// onUse(d, id), onMore(d), onRegen(d, id), onToggleLock(d, id, partIndex).
export function createResultView({ root, onUse, onMore, onRegen, onToggleLock }) {
    function card(diff, d, c, busy) {
        const chosen = c.id === diff.selectedId;
        const box = el("div", `cr-card${chosen ? " sel" : ""}`);
        const head = el("div", "cr-card-head");
        head.append(el("b", "", t("create.variant.name", { letter: c.letter })));
        if (c.id === diff.bestId) head.append(el("span", "cr-best", t("create.variant.best")));
        head.append(el("span", "muted", c.answer.version ?? ""));
        box.append(head);
        for (const line of cardLines(c.answer, diff.range)) box.append(el("div", line.cls, line.text));

        const issues = c.answer.issues ?? [];
        if (!issues.length) box.append(el("div", "muted", t("create.stats.clean")));
        else {
            const details = el("details", "cr-issues");
            details.open = chosen;
            details.append(el("summary", "", t("create.stats.issues", { n: issues.length })));
            for (const issue of issues.slice(0, SHOWN_ISSUES)) details.append(el("div", "muted", issueText(issue)));
            if (issues.length > SHOWN_ISSUES) details.append(el("div", "muted", t("create.stats.more", { n: issues.length - SHOWN_ISSUES })));
            box.append(details);
        }

        const reports = c.answer.parts ?? [];
        if (reports.length) {
            const details = el("details", "cr-parts");
            details.open = chosen;
            details.append(el("summary", "", t("html.create.parts")));
            reports.forEach((report, i) => {
                const row = el("div", "cr-part");
                const locked = c.locks.has(i);
                const lock = el("button", locked ? "small cr-locked" : "small", locked ? t("create.part.locked") : t("create.part.lock"));
                lock.disabled = busy;
                lock.addEventListener("click", () => onToggleLock?.(d, c.id, i));
                row.append(el("span", report.inRange === false ? "warn" : "", partLine(report)), lock);
                details.append(row);
            });
            box.append(details);
        }

        const actions = el("div", "links");
        const use = el("button", chosen ? "small cr-chosen" : "small", t("create.variant.use"));
        use.addEventListener("click", () => onUse?.(d, c.id));
        actions.append(use);
        if (c.locks.size) {
            const regen = el("button", "small", t("create.part.regen"));
            regen.disabled = busy;
            regen.addEventListener("click", () => onRegen?.(d, c.id));
            actions.append(regen);
        }
        box.append(actions);
        return box;
    }

    return {
        // diffs: [newDiff…] easiest first; busy: a generate run is going on
        render(diffs, { busy = false } = {}) {
            const sections = diffs.filter((diff) => diff.cards.length).map((diff) => {
                const d = diffs.indexOf(diff);
                const section = el("div", "cr-diffset");
                const head = el("div", "row cr-diffset-head");
                const more = el("button", "small", t("create.variant.more"));
                more.disabled = busy;
                more.addEventListener("click", () => onMore?.(d));
                head.append(el("b", "", rangeText(diff.range)), more);
                section.append(head, ...diff.cards.map((c) => card(diff, d, c, busy)));
                return section;
            });
            root.replaceChildren(...sections);
            root.hidden = !sections.length;
        },
    };
}
