// Etterna's block on the Settings page (app/renderer/etternaPanel.js) in a fake DOM: not linked it offers the folder;
// linked it lists the charts with Etterna's MSD at the chosen rate and fills in their dans; a click puts a chart on the
// card at that rate; turned off it shows the switch, the folder and a note. Russian and English.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "./helpers/fakeDom.js";
import { setLang } from "../src/i18n/i18n.js";
import { initEtternaPanel } from "../app/renderer/etternaPanel.js";

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
const FOLDER = String.raw`C:\Games\Etterna`;
const LINKED = { linked: true, folder: FOLDER, size: 2, scanning: null };
const OFF = { linked: false, off: true, folder: FOLDER };
const ROWS = [
    { id: "/Songs/P/A/a.sm|0", pack: "Pack", title: "Alpha", artist: "Artist", version: "Challenge 12", lengthMs: 125000, notes: 900, skip: null, msdAtRate: 21.5 },
    { id: "/Songs/P/B/b.sm|0", pack: "Pack", title: "Beta", artist: "Other", version: "Edit 30", lengthMs: 61000, notes: 0, skip: "warps", msdAtRate: null },
];

function mount({ lang = "ru", status = LINKED } = {}) {
    setLang(lang);
    const calls = [];
    const api = {
        etternaStatus: async () => status,
        etternaSearch: async (query, rate) => { calls.push(["search", query, rate]); return { ok: true, rows: ROWS }; },
        etternaDans: async (ids, rate, batch) => { calls.push(["dans", ids, rate]); assert.ok(Number.isSafeInteger(batch)); return { ok: true, dans: { [ROWS[0].id]: { label: "9 high", numeric: 9.8 }, [ROWS[1].id]: { label: "", numeric: null, why: "warps" } } }; },
        etternaSelect: async (id, rate) => { calls.push(["select", id, rate]); return { ok: true, label: "Artist - Alpha [Challenge 12]" }; },
        etternaPickFolder: async () => { calls.push(["pick"]); return { ok: true }; },
        etternaDetect: async () => { calls.push(["detect"]); return { ok: true }; },
        etternaUnlink: async () => { calls.push(["unlink"]); return { ok: true }; },
        etternaSetEnabled: async (on) => { calls.push(["enabled", on]); return { ok: true }; },
        onEtternaState: () => {},
    };
    const dom = fakeDom(api);
    const panel = dom.$("etterna-panel");
    const view = initEtternaPanel({ panel, api });
    const part = (cls) => panel.children.find((n) => n.className.split(" ").includes(cls));
    return { ...dom, api, calls, panel, view, part };
}

test("not linked: the folder buttons and the note", async () => {
    const m = mount({ status: { linked: false, folder: null } });
    m.view.render({ linked: false, folder: null });
    assert.match(m.part("et-status").textContent, /Укажи папку Etterna/);
    assert.equal(m.part("et-library").hidden, true);
    const buttons = m.part("et-actions").children;
    assert.deepEqual(buttons.map((b) => b.textContent), ["Выбрать папку…", "Найти", "Отвязать"]);
    assert.equal(buttons[2].hidden, true, "nothing to unlink");
    await fire(buttons[1]);
    await flush();
    assert.deepEqual(m.calls.filter((c) => c[0] === "detect"), [["detect"]]);
    setLang("en");
});

test("linked: search, the rate select from 0.7 to 2.0 by 0.05 at 1.0, rows with the MSD at the rate", async () => {
    const m = mount();
    m.view.render(LINKED);
    await flush();
    assert.match(m.part("et-status").textContent, /2/);
    assert.equal(m.part("et-library").hidden, false);
    const select = m.part("et-library").children.find((n) => n.className.includes("et-rate")).children.find((n) => n.tagName === "SELECT");
    const values = select.children.map((o) => o.value);
    assert.equal(values.length, 27);
    assert.equal(values[0], "0.70");
    assert.equal(values.at(-1), "2.00");
    assert.equal(select.value, "1.00");
    assert.deepEqual(m.calls.find((c) => c[0] === "search"), ["search", "", 1]);
    const text = textOf(m.part("et-library"));
    assert.match(text, /Artist - Alpha \[Challenge 12\]/);
    assert.match(text, /MSD 21\.50/);
    assert.match(text, /2:05/);
    // another rate asks again
    select.value = "1.30";
    await fire(select, "change");
    await flush();
    assert.deepEqual(m.calls.filter((c) => c[0] === "search").at(-1), ["search", "", 1.3]);
    setLang("en");
});

test("dans fill in as they come, only for the rows shown", async () => {
    const m = mount();
    m.view.render(LINKED);
    await flush();
    const dans = m.calls.find((c) => c[0] === "dans");
    assert.deepEqual(dans, ["dans", ROWS.map((r) => r.id), 1]);
    const text = textOf(m.part("et-library"));
    assert.match(text, /9 high/);
    assert.match(text, /не считается: warps/);
    setLang("en");
});

test("a click on a row puts the chart on the card at the rate, and the analysis tab opens", async () => {
    const m = mount();
    m.view.render(LINKED);
    await flush();
    const list = m.part("et-library").children.find((n) => n.className.includes("et-results"));
    const row = list.children.find((n) => n.className.includes("et-row"));
    await fire(row);
    await flush();
    assert.deepEqual(m.calls.filter((c) => c[0] === "select"), [["select", ROWS[0].id, 1]]);
    assert.ok(m.events.some((e) => e.type === "open-tab" && e.detail?.tab === "analysis"));
    setLang("en");
});

test("off: the switch unticked, the folder kept and the note; no list", async () => {
    const m = mount({ status: OFF });
    m.view.render(OFF);
    await flush();
    const enable = m.part("et-enable");
    assert.equal(enable.children[0].checked, false);
    assert.equal(enable.children[1].textContent, "Включить Etterna");
    assert.equal(m.part("et-off-note").hidden, false);
    assert.match(m.part("et-off-note").textContent, /Etterna выключена/);
    assert.equal(m.part("et-library").hidden, true);
    assert.equal(m.part("et-folder").textContent, FOLDER);
    enable.children[0].checked = true;
    await fire(enable.children[0], "change");
    await flush();
    assert.deepEqual(m.calls.filter((c) => c[0] === "enabled"), [["enabled", true]]);
    setLang("en");
});

test("the same in English", async () => {
    const m = mount({ lang: "en", status: { linked: false, folder: null } });
    m.view.render({ linked: false, folder: null });
    assert.match(m.part("et-status").textContent, /Point to your Etterna folder/);
    assert.equal(m.part("et-enable").children[1].textContent, "Enable Etterna");
    m.view.render(LINKED);
    await flush();
    assert.match(textOf(m.part("et-library")), /not rated: warps/);
    m.view.render({ ...LINKED, scanning: { done: 50, total: 200 } });
    assert.match(m.part("et-status").textContent, /Reading charts: 50 of 200/);
});
