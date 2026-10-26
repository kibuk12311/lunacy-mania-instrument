// The marathon's difficulty curve: time across (each map as long as its cut at its rate, the pauses between them),
// our dan up. The same numbers draw the curve in the tab and on the 1920×1080 background. No language here:
// the caller passes the plan's caption.
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const round2 = (x) => Math.round(x * 100) / 100;
const px = (x) => String(Math.round(x * 10) / 10);
const EPS = 1e-9;
const DROP = 0.05; // a map at least this much easier than the one before is a drop; less is noise
const JUMP = 0.5; // more than this between two maps is a jump

// The colours of the tokens in styles.css :root (the background is its own page and has no stylesheet).
const COLOR = { line: "#7be08f", plan: "#f5c66b", text: "#eeeeee", muted: "#8a8698", band: "#8fd3ff", gap: "#8a8698" };

export function formatTime(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// entries: [{ cutMs, rate, numeric, label }] in list order → { rows: [{ i, x0, x1, numeric, label }], totalMs }.
// x is the marathon's own ms, exactly as buildMarathon places the maps; a cut not known yet has no width.
export function curveRows(entries, gapMs) {
    const gap = Math.max(0, Number(gapMs) || 0);
    const rows = [];
    let cursor = 0;
    (entries ?? []).forEach((e, index) => {
        const rate = Number(e?.rate) > 0 ? Number(e.rate) : 1;
        const cut = finite(e?.cutMs);
        const x0 = index === 0 ? 0 : cursor + gap;
        const x1 = x0 + (cut !== null && cut > 0 ? Math.round(cut / rate) : 0);
        rows.push({ i: index + 1, x0, x1, numeric: finite(e?.numeric), label: String(e?.label ?? "") });
        cursor = x1;
    });
    return { rows, totalMs: cursor };
}

// Neighbours that both have a dan: { kind:"drop", i, delta<0 } and { kind:"jump", a, b, delta>0.5 }; i, a, b count from 1.
export function curveWarnings(rows) {
    const out = [];
    for (let k = 1; k < (rows ?? []).length; k += 1) {
        const prev = rows[k - 1].numeric;
        const cur = rows[k].numeric;
        if (prev === null || cur === null) continue;
        const delta = round2(cur - prev);
        if (prev - cur >= DROP - EPS) out.push({ kind: "drop", i: rows[k].i, delta });
        if (cur - prev > JUMP + EPS) out.push({ kind: "jump", a: rows[k - 1].i, b: rows[k].i, delta });
    }
    return out;
}

// The curve as an SVG string. plan: the template's dan per map (dashed), planLabel its caption;
// showLabels: the points carry the dan names (the background), else the numbers.
export function curveSvg(rows, { width = 300, height = 96, totalMs, plan = null, planLabel = "", showLabels = false, font = 9 } = {}) {
    const total = finite(totalMs) ?? (rows?.length ? rows.at(-1).x1 : 0);
    if (!rows?.length || !(total > 0)) return "";
    const planAt = (k) => (Array.isArray(plan) ? finite(plan[k]) : null);
    const values = [...rows.map((r) => r.numeric), ...rows.map((_, k) => planAt(k))].filter((v) => v !== null);
    let lo = values.length ? Math.min(...values) - 0.25 : 0;
    let hi = values.length ? Math.max(...values) + 0.25 : 1;
    if (hi - lo < 1) {
        const mid = (hi + lo) / 2;
        lo = mid - 0.5;
        hi = mid + 0.5;
    }
    const left = 4;
    const right = width - 4;
    const top = font + 6;
    const bottom = height - font - 6;
    const X = (ms) => left + (ms / total) * (right - left);
    const Y = (dan) => bottom - ((dan - lo) / (hi - lo)) * (bottom - top);

    const parts = [];
    rows.forEach((r, k) => {
        parts.push(`<rect x="${px(X(r.x0))}" y="${px(top)}" width="${px(Math.max(0, X(r.x1) - X(r.x0)))}" height="${px(bottom - top)}" fill="${COLOR.band}" fill-opacity="0.07"/>`);
        if (k > 0 && r.x0 > rows[k - 1].x1) {
            const g0 = X(rows[k - 1].x1);
            parts.push(`<rect x="${px(g0)}" y="${px(top)}" width="${px(Math.max(1, X(r.x0) - g0))}" height="${px(bottom - top)}" fill="${COLOR.gap}" fill-opacity="0.3"/>`);
        }
    });

    // a step line: flat across each map, up or down where the next map starts; broken where a dan is missing
    const steps = (valueAt) => {
        let d = "";
        let prevY = null;
        rows.forEach((r, k) => {
            const v = valueAt(k);
            if (v === null) {
                prevY = null;
                return;
            }
            const y = Y(v);
            d += prevY === null ? `M${px(X(r.x0))} ${px(y)}` : `L${px(X(r.x0))} ${px(prevY)}L${px(X(r.x0))} ${px(y)}`;
            d += `L${px(X(r.x1))} ${px(y)}`;
            prevY = y;
        });
        return d;
    };
    const planPath = steps(planAt);
    if (planPath) parts.push(`<path d="${planPath}" fill="none" stroke="${COLOR.plan}" stroke-width="${px(font / 7)}" stroke-dasharray="${px(font / 2)} ${px(font / 3)}" stroke-opacity="0.85"/>`);
    const line = steps((k) => rows[k].numeric);
    if (line) parts.push(`<path d="${line}" fill="none" stroke="${COLOR.line}" stroke-width="${px(font / 5)}"/>`);

    for (const r of rows) {
        if (r.numeric === null) continue;
        const cx = X((r.x0 + r.x1) / 2);
        const cy = Y(r.numeric);
        const text = showLabels && r.label ? r.label : r.numeric.toFixed(1);
        parts.push(`<g><title>${escape(`${r.i}. ${r.label || r.numeric.toFixed(2)}`)}</title>`
            + `<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(font / 3.5)}" fill="${COLOR.line}"/>`
            + `<text x="${px(cx)}" y="${px(cy - font / 2.5)}" font-size="${font}" fill="${COLOR.text}" text-anchor="middle">${escape(text)}</text></g>`);
    }

    const base = height - 3;
    parts.push(`<text x="${left}" y="${base}" font-size="${font}" fill="${COLOR.muted}">0:00</text>`);
    parts.push(`<text x="${right}" y="${base}" font-size="${font}" fill="${COLOR.muted}" text-anchor="end">${formatTime(total)}</text>`);
    if (planPath && planLabel) {
        const mid = width / 2;
        parts.push(`<path d="M${px(mid - font * 4)} ${px(base - font / 3)}h${px(font * 1.6)}" stroke="${COLOR.plan}" stroke-width="${px(font / 7)}" stroke-dasharray="${px(font / 2)} ${px(font / 3)}"/>`
            + `<text x="${px(mid - font * 2.1)}" y="${base}" font-size="${font}" fill="${COLOR.muted}">${escape(planLabel)}</text>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" font-family="Segoe UI, sans-serif">${parts.join("")}</svg>`;
}
