// What tests/smoke/electron-overlay-fit.mjs runs inside a real widget window (widget.html with its real CSS, preload and
// modules): window.__fit.measure() reads every text's and canvas's rect as they are, window.__fit.sweep(combos) mounts
// each combination (a style, a font, a weight, a scale, a language, the values) in that page and says how far the graph
// and the labels moved between the values, and what was cut off or ran into something else.
// All lengths are window pixels at the widget's own scale (the zoom taken out by measuring against the viewport).
/* eslint-disable no-undef */
(async () => {
    const base = location.href.split("?")[0];
    const at = (p) => new URL(p, base).href;
    const { mountWidget } = await import(at("./render.js"));
    const { getLang, setLang } = await import(at("../../src/i18n/i18n.js"));
    const { fakeSnapshot } = await import(at("../../src/overlay/fake.js"));
    const { formatRatio } = await import(at("../../src/overlay/format.js"));

    // the clock of the easings run by hand: a jump past them and the big number stands at its value
    const realNow = performance.now.bind(performance);
    let offset = 0;
    performance.now = () => realNow() + offset;

    const LEAVES = [
        ".k-now-value", ".k-max-value", ".k-unit", ".j-label", ".j-value", ".j-ratio-value", ".j-acc b", ".j-ur b", ".l-name", ".l-count",
        ".d-num", ".d-label", ".d-conf", ".d-pattern", ".d-play", ".d-fit", ".m-title", ".m-artist", ".m-version", ".m-mapper",
        ".m-stars", ".m-dan", ".m-bpm", ".m-len", ".m-rate", ".m-mods",
    ].join(",");
    // what stands beside a number: it must not move with it
    const LABELS = [".k-unit", ".j-label", ".l-name", ".d-label", ".k-max .k-unit", ".m-rate"];
    const GRAPHS = "canvas";

    const tag = (n, i) => `${n.className || n.tagName}${n.closest?.(".j-row") ? `@${[...n.closest(".j-row").classList].join(".")}` : ""}#${i}`;

    // the rect of the text itself (its glyph boxes, whatever box it sits in), as drawn: transforms count
    function textRect(node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect();
    }

    function clipOf(node, top) {
        let c = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
        for (let p = node.parentElement; p; p = p.parentElement) {
            const css = getComputedStyle(p);
            if (css.overflowX !== "visible" || css.overflowY !== "visible" || p === top) {
                const r = p.getBoundingClientRect();
                c = {
                    left: Math.max(c.left, r.left), top: Math.max(c.top, r.top),
                    right: Math.min(c.right, r.right), bottom: Math.min(c.bottom, r.bottom),
                };
            }
            if (p === top) break;
        }
        return c;
    }

    // every visible text and canvas of the root, in window px
    function measure(root = document.getElementById("widget")) {
        const box = root.getBoundingClientRect();
        const k = (root.__windowWidth ?? innerWidth) / box.width; // rects → window px
        const zoom = Number(document.documentElement.style.zoom) || 1;
        const rel = (r) => ({
            left: (r.left - box.left) * k, top: (r.top - box.top) * k, right: (r.right - box.left) * k, bottom: (r.bottom - box.top) * k,
            width: r.width * k, height: r.height * k,
        });
        const texts = [];
        root.querySelectorAll(LEAVES).forEach((n, i) => {
            if (!n.textContent || n.closest("[hidden]") || getComputedStyle(n).display === "none") return;
            const r = textRect(n);
            if (!r.width) return;
            const clip = clipOf(n, root);
            const em = parseFloat(getComputedStyle(n).fontSize) * zoom;
            // a font's line box is taller than its letters: only the em box counts for "cut off" up and down
            const slackY = Math.max(0, (r.height - Math.min(r.height, em)) / 2);
            const cut = Math.max(
                clip.left - r.left, r.right - clip.right,
                clip.top - (r.top + slackY), r.bottom - slackY - clip.bottom, 0,
            ) * k;
            texts.push({ name: tag(n, i), text: n.textContent, cut: Math.round(cut * 100) / 100, ...rel(r) });
        });
        const graphs = [...root.querySelectorAll(GRAPHS)].map((n) => ({ name: n.className, ...rel(n.getBoundingClientRect()) }));
        const labels = {};
        for (const sel of LABELS) {
            root.querySelectorAll(sel).forEach((n, i) => {
                if (!n.closest("[hidden]")) labels[`${sel}#${i}`] = rel(n.getBoundingClientRect());
            });
        }
        return { texts, graphs, labels, box: rel(box), size: [innerWidth, innerHeight] };
    }

    // two texts, or a text and a graph, over each other by more than a pixel either way
    function overlaps(m) {
        const out = [];
        const items = [...m.texts, ...m.graphs];
        for (let i = 0; i < items.length; i += 1) {
            for (let j = i + 1; j < items.length; j += 1) {
                const [a, b] = [items[i], items[j]];
                const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                // the line boxes of two rows touch: only an overlap of most of a line is letters over letters
                if (w > 1 && h > Math.min(a.height, b.height) * 0.45) out.push(`${a.name}×${b.name} ${Math.round(w)}×${Math.round(h)}`);
            }
        }
        return out;
    }

    // what is drawn smaller, and by how much
    const scales = (root) => [...root.querySelectorAll(".num, .fit")].map((n) => n.style.scale);

    // the made-up play with every number at v
    function snapshotAt(v, variant = {}) {
        const s = fakeSnapshot(60_000, {});
        s.hits = { max: v, n300: v, n200: v, n100: v, n50: v, miss: v };
        // ∞ (no 300s yet) comes from a fallback font in some of them
        s.ratio = v === 0 ? "—" : v === 777 ? "∞" : formatRatio(v * v, v);
        s.accuracy = v === 0 ? null : Math.min(100, v);
        s.ur = v === 0 ? null : v;
        s.kps.now = v;
        s.kps.max = v;
        s.nps = { ...s.nps, now: v, peak: v };
        const keys = variant.keys ?? 4;
        s.lanes = { ...s.lanes, keys, counts: Array.from({ length: keys }, () => v), pressed: Array.from({ length: keys }, () => false) };
        s.elapsedMs = v * 1000;
        s.progress = 0.4;
        if (variant.map) s.map = { ...s.map, ...variant.map };
        if (variant.dan) s.dan = { ...s.dan, ...variant.dan };
        if (variant.judgeNames) s.judgeNames = { ...variant.judgeNames, counts: variant.judgeNames.names.map(() => v) };
        if (variant.phase) s.phase = variant.phase;
        return s;
    }

    function settle(view, s) {
        view.update(s);
        offset += 100_000;
        view.paint(s.clock);
        view.update(s);
        offset += 100_000;
        view.paint(s.clock);
    }

    const shift = (a, b) => Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.right - b.right), Math.abs(a.bottom - b.bottom));

    // one combination: { widget, style, show, look, scale, lang, width, height, values, variant }
    function one(c) {
        if (getLang() !== c.lang) setLang(c.lang);
        const root = document.getElementById("widget");
        document.documentElement.style.zoom = String(c.scale);
        root.style.width = `${c.width / c.scale}px`;
        root.style.height = `${c.height / c.scale}px`;
        root.__windowWidth = c.width;
        const mount = () => mountWidget(root, c.widget, { style: c.style, show: c.show, zoom: c.scale, look: c.look, dan: null });
        const view = mount();
        const seen = [];
        const smallest = { k: 1, who: null };
        for (const v of c.values) {
            settle(view, snapshotAt(v, c.variant));
            seen.push({ v, m: measure(root) });
            if (v < 1000) {
                root.querySelectorAll(".num, .fit").forEach((n) => {
                    const k = Number(n.style.scale) || 1;
                    if (k < smallest.k) {
                        smallest.k = k;
                        smallest.who = n.className;
                    }
                });
            }
        }
        const out = { smallest, graphShift: 0, labelShift: 0, labelWho: null, textShifted: 0, cut: 0, cutWho: null, over: [], graphs: [], box: seen[0]?.m.box ?? null };
        const first = seen[0]?.m;
        for (const { v, m } of seen) {
            m.graphs.forEach((g, i) => {
                out.graphShift = Math.max(out.graphShift, shift(g, first.graphs[i]));
                if (!(g.width > 8 && g.height > 8)) out.over.push(`graph squeezed at ${v}: ${Math.round(g.width)}×${Math.round(g.height)}`);
            });
            for (const [name, r] of Object.entries(m.labels)) {
                const was = first.labels[name];
                if (!was) continue;
                const d = shift(r, was);
                if (d > out.labelShift) {
                    out.labelShift = d;
                    out.labelWho = `${name} at ${v}`;
                }
            }
            for (const t of m.texts) {
                if (t.cut > out.cut) {
                    out.cut = t.cut;
                    out.cutWho = `${t.name} "${t.text.slice(0, 24)}" at ${v}`;
                }
            }
            for (const line of overlaps(m)) if (out.over.length < 4) out.over.push(`${line} at ${v}`);
            root.querySelectorAll(".num, .fit").forEach((n) => {
                if (n.scrollWidth > 0 && !n.clientWidth && out.over.length < 4) out.over.push(`no room for ${n.className} at ${v}`);
            });
        }
        out.graphs = first?.graphs ?? [];
        // A value over every box first, a long title before this map: what is left of them is what a mount at this value shows.
        const again = (before) => {
            const v = mount();
            if (before) settle(v, before);
            settle(v, snapshotAt(123, c.variant));
            return scales(root);
        };
        const big = snapshotAt(123456, c.variant);
        if (big.map) big.map = { ...big.map, title: `${big.map.title} `.repeat(9), lengthMs: 36_000_000 };
        const fresh = again(null);
        const stale = again(big);
        out.stale = stale.filter((k, i) => k !== fresh[i]).length;
        return out;
    }

    window.__fit = {
        measure,
        overlaps,
        snapshotAt,
        // the eased numbers stand at their values
        jump() { offset += 100_000; },
        sweep(combos) { return combos.map(one); },
        frame: () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    };
    return true;
})();
