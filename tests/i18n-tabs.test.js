// English texts of the tabs: the keys the code asks for exist, every key of the create, rate, marathon and analysis
// areas is used somewhere, and the tabs, driven through a tiny fake DOM, show English when the language is English.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, setLang, allKeys } from "../src/i18n/i18n.js";
import { AREAS } from "../src/i18n/messages/index.js";
import { initRateTab, onRateTabShown } from "../app/renderer/rateTab.js";
import { initMarathonTab } from "../app/renderer/marathonTab.js";
import { codeFiles, stripComments } from "./helpers/source.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// every code file in app/ and src/ (comments stripped), and the keys the markup asks for
const CODE = codeFiles(root).map((file) => stripComments(readFileSync(file, "utf8"))).join("\n");
const MARKUP_KEYS = [...readFileSync(path.join(root, "app", "renderer", "index.html"), "utf8")
    .matchAll(/\bdata-i18n(?:-[a-z]+)?="([\w.]+)"/g)].map((m) => m[1]);
// areas whose every key must be used: by a string literal in code (a t() call or a lookup table) or in the markup
const GUARDED = ["create", "rate", "marathon", "analysis"];
// any {slot} a text has gets a value: has → true, get → 2
const ANY_PARAMS = new Proxy({}, { has: () => true, get: (_target, key) => (typeof key === "symbol" ? undefined : 2) });
const CYR = /[А-Яа-яЁё]/;
const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Just enough of the DOM for the tab modules: elements by id, created elements, listeners and children.
function fakeDom(api) {
    const nodes = new Map();
    const make = (tag = "div") => {
        const node = {
            tagName: tag.toUpperCase(), textContent: "", value: "", title: "", className: "", type: "",
            disabled: false, checked: false, hidden: false, dataset: {}, children: [], listeners: {},
            classList: { toggle() {}, add() {}, remove() {} },
            addEventListener(type, fn) { (node.listeners[type] ??= []).push(fn); },
            replaceChildren(...kids) { node.children = kids; },
            append(...kids) { node.children.push(...kids); },
        };
        return node;
    };
    const byId = (id) => {
        if (!nodes.has(id)) nodes.set(id, make());
        return nodes.get(id);
    };
    globalThis.document = { getElementById: byId, createElement: make };
    globalThis.window = { danApi: api };
    return byId;
}

const textOf = (node) => [node.textContent, ...node.children.map(textOf)].filter(Boolean).join(" | ");
const fire = async (node, type = "click") => { for (const fn of node.listeners[type] ?? []) await fn({ target: node }); };

test("every key the code asks for exists, and every key of the guarded areas is used", () => {
    const asked = new Set([...CODE.matchAll(/\bt\("([\w.]+)"/g)].map((m) => m[1]));
    assert.ok(asked.size > 100, `only ${asked.size} keys found`);
    const known = new Set(allKeys());
    assert.deepEqual([...asked].filter((key) => !known.has(key)), []);
    assert.deepEqual(MARKUP_KEYS.filter((key) => !known.has(key)), []);
    const literals = [...CODE.matchAll(/"((?:create|rate|marathon|analysis)\.[\w.]+)"/g)].map((m) => m[1]);
    const used = new Set([...literals, ...MARKUP_KEYS]);
    const ours = GUARDED.flatMap((area) => Object.keys(AREAS[area]));
    assert.deepEqual(ours.filter((key) => !used.has(key)), []);
});

test("English tab texts: plurals and no Russian left in function-made texts", () => {
    setLang("en");
    try {
        assert.equal(t("marathon.done", { n: 1, time: "3:05" }), "Done: a marathon of 1 map, 3:05");
        assert.equal(t("marathon.done", { n: 4, time: "12:40" }), "Done: a marathon of 4 maps, 12:40");
        assert.equal(t("create.result.stats", { notes: 1532, confidence: "high" }), "1532 notes · confidence high");
        assert.equal(t("create.level.dan", { n: 7 }), "Dan 7");
        assert.equal(t("rate.preview.keys", { keys: 7 }), "Not 4K (7k) — no dan for this one");
        for (const area of GUARDED) {
            for (const key of Object.keys(AREAS[area])) {
                const text = t(key, ANY_PARAMS);
                assert.ok(!CYR.test(text), `${key}: ${text}`);
                assert.ok(!/\{\w+\}/.test(text), `${key}: unfilled slot in ${text}`);
            }
        }
    } finally {
        setLang("ru");
    }
    assert.equal(t("marathon.done", { n: 4, time: "12:40" }), "Готово: марафон, 4 шт., 12:40");
});

test("Rate tab shows the dan preview, the not-4K note and the created copy in English", async () => {
    let preview = { kind: "ok", label: "Gamma mid", numeric: 13.04, primary: "Jumpstream", tech: true };
    const $ = fakeDom({
        rateInfo: async () => ({ ok: true, mania: true, info: { artist: "A", title: "T", version: "V", od: 8, hp: 7, bpm: 180 } }),
        ratePreview: async () => preview,
        rateCreate: async () => ({ ok: true, version: "1.2x" }),
    });
    $("rate-value").value = "1.2";
    initRateTab();
    try {
        setLang("ru");
        await onRateTabShown();
        await sleep(300);
        assert.equal($("rate-preview").textContent, "На ×1.2: Gamma mid · 13.0 · Jumpstream · Tech");

        setLang("en");
        await onRateTabShown();
        await sleep(300);
        assert.equal($("rate-map").textContent, "A - T [V]");
        assert.equal($("rate-preview").textContent, "At ×1.2: Gamma mid · 13.0 · Jumpstream · Tech");

        preview = { kind: "not-rice", reason: "keys", keys: 7 };
        await onRateTabShown();
        await sleep(300);
        assert.equal($("rate-preview").textContent, "Not 4K (7k) — no dan for this one");

        await fire($("rate-create"));
        assert.equal($("rate-status").textContent, "Done: [1.2x] is in the map's folder. If osu! doesn't show it, press F5 in song select.");

        globalThis.window.danApi.rateInfo = async () => ({ ok: false, message: "osu! is closed" });
        await onRateTabShown();
        assert.equal($("rate-map").textContent, "No map: osu! is closed");
        await sleep(300);
        assert.equal($("rate-preview").textContent, "—");
    } finally {
        setLang("ru");
    }
});

test("Marathon tab: empty list, refusals, row tooltips and the result in English", async () => {
    let next = null;
    let sent = null;
    const $ = fakeDom({
        marathonAddCurrent: async () => next,
        marathonDan: async () => ({ label: "Gamma mid", numeric: 13.02, cutMs: 60000 }),
        marathonCreate: async (req) => { sent = req; return { ok: true, totalMs: 185000, file: "m.osz" }; },
        openMap() {},
        showMap() {},
    });
    setLang("en");
    try {
        initMarathonTab();
        assert.equal(textOf($("mar-list")), "Nothing here yet — add maps below.");
        // the auto-marathon panel: templates, the profile line (none loaded), the patterns
        assert.deepEqual($("mar-tpl").children.map((o) => o.textContent), ["Dan course (4 maps)", "Stamina marathon", "Warm-up → challenge", "Custom"]);
        assert.equal($("mar-tpl-hint").textContent, "Four maps of one dan, each a bit harder");
        assert.equal($("mar-profile").textContent, "No profile loaded — load one on the Picks tab or pick a dan by hand.");
        assert.equal(textOf($("mar-patterns")), "Stream | Jumpstream | Handstream | Stamina | Chordjack | Jack | Tech");

        next = { ok: false, message: "no map selected" };
        await fire($("mar-add-current"));
        assert.equal($("mar-status").textContent, "Not added: no map selected");

        next = { ok: true, ok4k: false, name: "Song (7K)" };
        await fire($("mar-add-current"));
        assert.equal($("mar-status").textContent, "“Song (7K)” isn't 4K osu!mania, so it can't go in a marathon.");

        next = { ok: true, ok4k: true, path: "a.osu", name: "Good song" };
        await fire($("mar-add-current"));
        await nextTick();
        const row = $("mar-list").children[0];
        assert.deepEqual(row.children.map((c) => c.title).filter(Boolean), ["Good song", "Rate", "Move up", "Move down", "Remove"]);
        assert.ok(textOf(row).includes("Gamma mid"));
        // the curve's total line under the list
        assert.equal(textOf($("mar-curve")), "Total 1:00 · 1 map · Gamma mid → Gamma mid");

        $("mar-title").value = "  ";
        $("mar-gap").value = "10";
        await fire($("mar-create"));
        assert.equal(sent.title, "Marathon");
        assert.equal(sent.plan, null);
        assert.equal(textOf($("mar-result")), "Done: a marathon of 1 map, 3:05 | Open in osu! | Show file");
    } finally {
        setLang("ru");
    }
});
