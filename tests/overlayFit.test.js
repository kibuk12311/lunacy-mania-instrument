// Numbers must not push anything on the overlay's widgets, and everything must fit (app/overlay/render.js, overlay.css,
// src/overlay/settings.js): a number sits in a box sized for its largest value in its own font, what is too wide is drawn
// smaller and never cut, a snapshot that changes nothing writes nothing. tests/smoke/electron-overlay-fit.mjs measures
// the same in real widget windows, every style, font, weight, scale and language.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDom } from "./helpers/fakeDom.js";
import { fakeSnapshot } from "../src/overlay/fake.js";
import { normalizeOverlaySettings, placeWidget, resizeAnchored, SHOW, widgetSize, withinScreen } from "../src/overlay/settings.js";

fakeDom();
const make = document.createElement;
document.createElement = (tag) => {
    const node = make(tag);
    node.style.setProperty = () => {};
    return node;
};
const { fitBox, fitNode, mountWidget, numberWidth, setNumber } = await import("../app/overlay/render.js");
const css = readFileSync(new URL("../app/overlay/overlay.css", import.meta.url), "utf8");
const allShown = (widget) => Object.fromEntries(SHOW[widget].map((k) => [k, true]));
const tree = (node) => [node, ...(node.children ?? []).flatMap(tree)];
const byClass = (root, cls) => tree(root).filter((n) => n.className.split(" ").includes(cls));

test("a number's box: digits by the font's own 0 and a bit for the widest digit, signs by the font where they are widest", () => {
    assert.equal(numberWidth("000"), "calc(3.12ch + 0.00em)");
    assert.equal(numberWidth("100.00%"), "calc(5.20ch + 1.75em)");
    assert.equal(numberWidth("00.00:0"), "calc(5.20ch + 1.10em)");
    assert.equal(numberWidth("3:12 / 3:12"), "calc(6.24ch + 2.78em)", "a space as wide as Consolas's, the widest of them");
});

test("what is wider than its box is drawn smaller, from where it begins; what fits is left alone; nothing without a layout", () => {
    const node = (clientWidth, scrollWidth, scale = "") => ({ clientWidth, scrollWidth, style: { scale } });
    const wide = node(100, 200);
    fitNode(wide);
    assert.equal(wide.style.scale, "0.497", "half of the room, half a pixel kept for rounding: never wider than the box");
    const fits = node(100, 100, "0.5");
    fitNode(fits);
    assert.equal(fits.style.scale, "", "it fits again: full size");
    const detached = node(0, 0, "0.5");
    fitNode(detached);
    assert.equal(detached.style.scale, "0.5", "no layout yet: nothing to go by");
    let writes = 0;
    const same = { clientWidth: 100, scrollWidth: 200, style: { get scale() { return "0.497"; }, set scale(v) { writes += 1; } } };
    fitNode(same);
    assert.equal(writes, 0, "the same size again writes nothing");
});

test("a box squeezed to nothing still has its text: it is drawn smaller, it keeps no size from an earlier one", () => {
    const squeezed = { clientWidth: 0, scrollWidth: 527, style: { scale: "0.071" } };
    fitNode(squeezed);
    assert.equal(squeezed.style.scale, "0.001", "as small as it goes, not left at the size of the map before");
    const fresh = { clientWidth: 0, scrollWidth: 527, style: {} };
    fitNode(fresh);
    assert.equal(fresh.style.scale, "0.001", "not left at full size over its neighbours");
    const hidden = { clientWidth: 0, scrollWidth: 0, style: { scale: "0.5" } };
    fitNode(hidden);
    assert.equal(hidden.style.scale, "0.5", "no text in it: nothing to go by");
});

test("the numbers fit first, the lines are read with the numbers held in, so no value stays in a line", () => {
    const seen = [];
    let fitting = false;
    const part = (name, clientWidth, scrollWidth) => ({
        style: {}, clientWidth,
        get scrollWidth() {
            seen.push([name, fitting]);
            return scrollWidth;
        },
    });
    const number = part("number", 50, 60);
    const line = part("line", 100, 100);
    const outer = part("outer", 200, 200);
    const box = {
        clientWidth: 200,
        classList: { toggle: (name, on) => { assert.equal(name, "fitting"); fitting = on; } },
        querySelectorAll: (selector) => (selector === ".num" ? [number] : selector === ".fit" ? [outer, line] : assert.fail(selector)),
    };
    assert.equal(fitBox(box), true);
    assert.deepEqual(seen, [["number", false], ["line", true], ["outer", true]], "the insides before what holds them");
    assert.equal(fitting, false, "nothing of it is left for the paint");
    assert.ok(number.style.scale, "the number was over its box");
    assert.match(css, /.fitting .num {[^}]*overflow: clip;[^}]*scale: none !important/, "its text and its scale count for no line");
    const unmounted = { clientWidth: 0, classList: { toggle: () => assert.fail("not laid out") }, querySelectorAll: () => assert.fail("not laid out") };
    assert.equal(fitBox(unmounted), false);
});

test("the time of a play: a tick reads no layout while it is within its box, and looks at it when it is drawn smaller or longer", () => {
    const root = document.createElement("div");
    const view = mountWidget(root, "map", { style: "card", show: allShown("map") });
    const map = { title: "T", lengthMs: 192_000, rate: 1 };
    view.update({ map, progress: 0, elapsedMs: 10_000 });
    const time = byClass(root, "m-len")[0];
    let reads = 0;
    Object.defineProperty(time, "scrollWidth", { get: () => { reads += 1; return 100; } });
    time.clientWidth = 120;
    view.update({ map, progress: 0, elapsedMs: 11_000 });
    assert.equal(reads, 0, "a tick within the box");
    time.style.scale = "0.97";
    view.update({ map, progress: 0, elapsedMs: 12_000 });
    assert.equal(reads, 1);
    assert.equal(time.style.scale, "", "left smaller by the mount, it goes back to full size");
    view.update({ map, progress: 0, elapsedMs: 1_000_000 });
    assert.equal(reads, 2, "longer than the box was made for");
});

test("a number is written only when it changed, and only one that can leave its box is looked at", () => {
    const node = { textContent: "0", room: 3, style: {} };
    assert.equal(setNumber(node, "0"), false);
    let writes = 0;
    let text = "12";
    Object.defineProperty(node, "textContent", { get: () => text, set: (v) => { writes += 1; text = v; } });
    assert.equal(setNumber(node, "12"), false, "the same text");
    assert.equal(writes, 0);
    assert.equal(setNumber(node, "123"), false, "within its box: the layout is not read for it");
    assert.equal(writes, 1);
    assert.equal(setNumber(node, "1234"), true, "longer than the box was made for");
    node.style.scale = "0.8";
    assert.equal(setNumber(node, "123"), true, "drawn smaller: it may go back to full size");
});

test("every number of every widget has a box; a snapshot that changes nothing writes no text", () => {
    const snapshot = fakeSnapshot(60_000);
    const numbers = { judgements: 9, kps: 2, nps: 2, keys: 4, dan: 1 };
    for (const [widget, count] of Object.entries(numbers)) {
        const root = document.createElement("div");
        const view = mountWidget(root, widget, { style: "card", show: allShown(widget) });
        view.update(snapshot);
        view.paint(0);
        const boxes = byClass(root, "num");
        assert.equal(boxes.length, count, `${widget}: its numbers`);
        assert.ok(boxes.every((n) => n.room >= 0), `${widget}: each made with its shape`);
        let writes = 0;
        for (const n of boxes) {
            let text = n.textContent;
            Object.defineProperty(n, "textContent", { get: () => text, set: (v) => { writes += 1; text = v; } });
        }
        view.update(snapshot);
        assert.equal(writes, 0, `${widget}: nothing to write`);
    }
});

test("a line that may run out of room fits itself, in every widget that has lines", () => {
    const cases = {
        judgements: ["j-row", "j-rows", "j-ratio", "j-foot"], kps: ["k-head"], nps: ["k-head"], keys: ["l-name"],
        dan: ["d-label", "d-conf", "d-pattern", "d-play", "d-fit"], map: ["m-title", "m-artist", "m-diff", "m-side", "m-dan", "m-stats"],
    };
    for (const [widget, lines] of Object.entries(cases)) {
        const root = document.createElement("div");
        mountWidget(root, widget, { style: "card", show: allShown(widget) }).update(fakeSnapshot(60_000));
        for (const line of lines) {
            const nodes = byClass(root, line);
            assert.ok(nodes.length, `${widget}: ${line}`);
            assert.ok(nodes.every((n) => n.className.split(" ").includes("fit")), `${widget}: ${line} fits itself`);
        }
    }
});

test("view.fit() is there for the window's new size; a ruleset with more rows than the window has room for draws them smaller", () => {
    const root = document.createElement("div");
    const view = mountWidget(root, "judgements", { style: "card", show: allShown("judgements") });
    assert.equal(typeof view.fit, "function");
    const rows = byClass(root, "j-rows")[0];
    assert.equal(rows.style.zoom, "", "six rows: as they are");
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    view.update({ ...fakeSnapshot(60_000), judgeNames: { mapped: false, names, counts: names.map(() => 1) } });
    assert.equal(rows.style.zoom, String(6 / 8), "eight in the room of six");
    const line = document.createElement("div");
    const one = mountWidget(line, "judgements", { style: "compact", show: allShown("judgements") });
    one.update({ ...fakeSnapshot(60_000), judgeNames: { mapped: false, names, counts: names.map(() => 1) } });
    assert.equal(byClass(line, "j-rows")[0].style.zoom, "", "one line: wider, not lower");
});

test("no text is cut off by the CSS, and a graph takes no size from the numbers", () => {
    const widgets = css.slice(0, css.indexOf("---- edit mode"));
    assert.ok(!widgets.includes("text-overflow"), "no ellipsis left: a text that does not fit is drawn smaller");
    const rule = (selector) => {
        const at = css.indexOf(`\n${selector} {`);
        assert.ok(at >= 0, selector);
        return css.slice(at, css.indexOf("}", at));
    };
    assert.match(rule(".num"), /width: var\(--num/);
    for (const selector of [".m-title", ".m-artist", ".m-stats", ".d-label", ".d-pattern", ".num", ".fit"]) {
        assert.doesNotMatch(rule(selector), /overflow/, `${selector} cuts nothing`);
    }
    assert.match(css, /\.style-compact \.k-graph \{[^}]*flex: 1 1 0/, "one line: the graph's width is what the boxes leave");
    const floor = String.raw`min-width: calc-size\(max-content, min\(size, 20cqw\)\)`;
    assert.match(css, new RegExp(String.raw`\.style-compact \.m-title \{[^}]*${floor}`), "one line: the title is never squeezed to nothing");
    assert.match(css, new RegExp(String.raw`\.style-compact \.m-names \{[^}]*${floor}`), "one line: the names neither");
    assert.match(css, /\.style-compact\.ov-map \.ov-box \{[^}]*container-type: inline-size/, "what cqw counts from");
    assert.doesNotMatch(css, /min-width: 1\.4em/, "no box of two digits a third one breaks out of");
    assert.match(css, /\.style-compact\.ov-keys \.ov-box \{[^}]*align-items: stretch/, "the keys under their lanes, not as wide as their numbers");
});

test("one line: a judgement hidden takes its own width with it, so what is left keeps its room for three digits", () => {
    const off = (...keys) => Object.fromEntries(keys.map((key) => [key, false]));
    const width = (...keys) => widgetSize("judgements", "compact", 1, null, off(...keys)).width;
    assert.equal(width(), 625);
    // measured rows in the widgets' own font (a label, a number's box, the gap): MAX 66, 300 60, 200 and 100 52, 50 46, miss 60
    assert.deepEqual([width("max"), width("n300"), width("n200"), width("n100"), width("n50"), width("miss")], [559, 565, 573, 573, 579, 565]);
    assert.equal(width("n300", "n200", "n100", "n50"), 625 - 60 - 52 - 52 - 46);
    assert.equal(widgetSize("judgements", "compact", 1, { counts: false }, off("n50")).width, 625, "counts off: nothing to take");
    assert.equal(widgetSize("judgements", "compact", 2, null, off("n50")).width, 579 * 2);
});

test("a window larger than its screen is as large as the screen, across two screens it may stay", () => {
    const old = { v: 3, enabled: true, widgets: { judgements: { style: "compact", scale: 2.5, x: 40, y: 900 } } };
    const settings = normalizeOverlaySettings(old);
    const on = (width, height = 864) => {
        const area = { x: 0, y: 0, width, height };
        return [{ workArea: area, bounds: area }];
    };
    assert.equal(widgetSize("judgements", "compact", 2.5).width, 1563);
    assert.deepEqual(placeWidget("judgements", settings, on(1920, 1080)), { x: 40, y: 900, width: 1563, height: 100 }, "it fits: as it was");
    for (const screen of [1536, 1366]) {
        const box = placeWidget("judgements", settings, on(screen, 1000));
        assert.deepEqual(box, { x: 0, y: 900, width: screen, height: 100 }, `${screen}: nothing hangs off the screen`);
    }
    const unplaced = normalizeOverlaySettings({ v: 3, enabled: true, widgets: { judgements: { style: "compact", scale: 2.5 } } });
    assert.deepEqual(placeWidget("judgements", unplaced, on(1366)), { x: 0, y: 120, width: 1366, height: 100 });
    const second = { x: 1366, y: 0, width: 1366, height: 864 };
    const two = [on(1366)[0], { workArea: second, bounds: second }];
    const high = normalizeOverlaySettings({ v: 3, enabled: true, widgets: { judgements: { style: "compact", scale: 2.5, x: 40, y: 100 } } });
    assert.equal(placeWidget("judgements", high, two).width, 1563, "across two screens");

    // a new scale on a window that has its place
    const box = { x: 900, y: 20, width: 100, height: 40 };
    assert.deepEqual(resizeAnchored(box, { width: 1563, height: 100 }, on(1366)), { x: 0, y: 20, width: 1366, height: 100 });
    assert.deepEqual(resizeAnchored(box, { width: 500, height: 100 }, on(1366)), { x: 900, y: 20, width: 500, height: 100 }, "smaller than the screen: as before");
    assert.deepEqual(withinScreen({ x: 10, y: 10, width: 300, height: 2000 }, on(1366)), { x: 10, y: 0, width: 300, height: 864 });
});

test("the sizes have room for three digits; an old overlay.json keeps its places and takes the new sizes", () => {
    assert.deepEqual(widgetSize("kps", "card", 1), { width: 210, height: 128 });
    assert.deepEqual(widgetSize("judgements", "card", 1), { width: 192, height: 196 });
    assert.deepEqual(widgetSize("judgements", "classic", 1), { width: 210, height: 196 });
    assert.deepEqual(widgetSize("judgements", "minimal", 1), { width: 172, height: 150 });
    assert.deepEqual(widgetSize("judgements", "compact", 1), { width: 625, height: 40 });

    // a file of the last release: a widget near the right edge of the screen, in the one-line style that got wider
    const old = {
        v: 3, enabled: true,
        widgets: { judgements: { style: "compact", font: "impact", weight: 900, scale: 1.5, x: 1400, y: 40 }, kps: { style: "compact", x: 100, y: 200 } },
    };
    const settings = normalizeOverlaySettings(old);
    assert.deepEqual([settings.widgets.kps.x, settings.widgets.kps.y, settings.widgets.kps.style], [100, 200, "compact"]);
    assert.deepEqual([settings.widgets.judgements.font, settings.widgets.judgements.weight, settings.widgets.judgements.scale], ["impact", 900, 1.5]);
    const screen = { x: 0, y: 0, width: 1920, height: 1080 };
    const box = placeWidget("judgements", settings, [{ workArea: screen, bounds: screen }]);
    assert.equal(box.width, Math.round(625 * 1.5));
    assert.ok(box.x + box.width <= screen.width, "it does not hang off the screen");
    assert.equal(box.y, 40);
});
