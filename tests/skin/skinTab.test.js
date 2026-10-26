// The Skin tab's wiring through a tiny fake DOM: a skin made from scratch opens with its name, the Interlude export
// only for it, edits through the editor change skin.ini and undo / redo walk them back; an opened osu! skin hides
// the Interlude button and says why; the tab registers in renderer.js. Plus the history and the preview's autoplay.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeDom, fire, textOf } from "../helpers/fakeDom.js";
import { setLang, t } from "../../src/i18n/i18n.js";
import { createHistory } from "../../src/skin/history.js";
import { PATTERN, autoplayAt } from "../../src/skin/previewPattern.js";
import { getValue, parseSkinIni } from "../../src/skin/skinIni.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tick = () => new Promise((r) => setTimeout(r, 0));
const INI = "[General]\r\nName: Made Here\r\nAuthor: TestPlayer\r\n\r\n[Mania]\r\nKeys: 4\r\nHitPosition: 410\r\n";

function api(origin, saved) {
    return {
        skinCreate: async () => ({ ok: true, id: "abc123", name: "Made Here", origin, ini: INI, builder: null, interlude: origin === "template", mania4: true }),
        skinSave: async (req) => { saved.push(req.ini); return { ok: true }; },
        skinImages: async () => ({ ok: true, images: {} }),
        skinRecent: async () => ({ ok: true, items: [] }),
        skinList: async () => ({ ok: true, folder: null, skins: [] }),
    };
}

async function openTab(origin, lang = "ru") {
    setLang(lang);
    const saved = [];
    const dom = fakeDom(api(origin, saved));
    const { initSkinTab } = await import("../../app/renderer/skinTab.js");
    const tab = initSkinTab();
    await fire(dom.$("sk-create"));
    await tick();
    return { ...dom, tab, saved };
}

test("a skin made from scratch: opened, named, Interlude offered; an edit, undo and redo", async () => {
    const { $, tab } = await openTab("template");
    try {
        assert.equal($("sk-session").hidden, false);
        assert.equal($("sk-start").hidden, true);
        assert.equal($("sk-name").textContent, "Made Here");
        assert.equal($("sk-export-il").hidden, false);
        assert.equal($("sk-il-note").textContent, t("skin.interlude.how"));
        // the editor has a group per area, the layout one with the column width row
        const groups = $("sk-editor").children;
        assert.equal(groups.length, 7);
        assert.ok(textOf(groups[1]).includes(t("skin.f.columnWidth")));
        tab.setField("HitPosition", 430);
        await tick();
        assert.equal(getValue(parseSkinIni(tab.ini), { mania: 4 }, "HitPosition"), "430");
        assert.equal($("sk-undo").disabled, false);
        await fire($("sk-undo"));
        assert.equal(getValue(parseSkinIni(tab.ini), { mania: 4 }, "HitPosition"), "410");
        await fire($("sk-redo"));
        assert.equal(getValue(parseSkinIni(tab.ini), { mania: 4 }, "HitPosition"), "430");
        tab.setField("Name", "Renamed");
        await tick();
        assert.equal($("sk-name").textContent, "Renamed");
    } finally {
        setLang("ru");
    }
});

test("an osu! skin opened for editing: no Interlude button, the reason said; English texts", async () => {
    const { $ } = await openTab("osu", "en");
    try {
        assert.equal($("sk-export-il").hidden, true);
        assert.equal($("sk-il-note").textContent, "For Interlude, make a skin from scratch; your own skin can be finished in Interlude's own editor.");
        assert.equal($("sk-origin").textContent, "from osu!");
        assert.ok(!/[А-Яа-яЁё]/.test(textOf($("sk-editor"))), "no Russian in the English editor");
    } finally {
        setLang("ru");
    }
});

test("the tab is wired: a button, a section, the preload block and main's register call", () => {
    const html = readFileSync(path.join(root, "app/renderer/index.html"), "utf8");
    assert.match(html, /<button data-tab="skin"[^>]*data-i18n="skin\.html\.tab"/);
    assert.match(html, /<section id="skin-tab" hidden>/);
    const renderer = readFileSync(path.join(root, "app/renderer/renderer.js"), "utf8");
    assert.match(renderer, /"skin"\]/);
    assert.match(renderer, /initSkinTab\(\);/);
    assert.match(readFileSync(path.join(root, "app/main.js"), "utf8"), /registerSkinIpc\(deps\);/);
    assert.match(readFileSync(path.join(root, "app/preload.cjs"), "utf8"), /\/\/ >>> skin[\s\S]*skinExportInterlude[\s\S]*\/\/ <<< skin/);
});

test("history: steps, merging one field's quick edits, undo past a new edit drops the redo", () => {
    let now = 0;
    const h = createHistory("a", { now: () => now });
    h.push("b");
    h.push("c", "W");
    now += 100;
    h.push("d", "W");
    assert.equal(h.current, "d");
    assert.equal(h.undo(), "b", "c and d were one step");
    assert.equal(h.redo(), "d");
    h.undo();
    h.push("x");
    assert.equal(h.canRedo, false);
    assert.equal(h.undo(), "b");
    assert.equal(h.push("b"), false, "no change, no step");
});

test("the preview's loop: notes sorted, holds end after they start, autoplay presses on time and judges", () => {
    assert.ok(PATTERN.notes.length > 40);
    assert.ok(PATTERN.notes.every((n, i) => i === 0 || PATTERN.notes[i - 1].t <= n.t));
    assert.ok(PATTERN.notes.some((n) => n.end !== undefined));
    assert.ok(PATTERN.notes.every((n) => n.end === undefined || n.end > n.t));
    assert.ok(PATTERN.notes.every((n) => n.t < PATTERN.length && n.col >= 0 && n.col < 4));
    const first = PATTERN.notes[0];
    const at = autoplayAt(first.t + 10);
    assert.equal(at.pressed[first.col], true);
    assert.equal(at.judgement.key, "Hit300g");
    const hold = PATTERN.notes.find((n) => n.end !== undefined);
    assert.equal(autoplayAt((hold.t + hold.end) / 2).hold[hold.col], true);
});
