// The create tab's "from an existing map" mode (mapgen v3, stream C): pick an .osu or osu!'s current map, choose
// −1 / +1 / a custom dan, remap; driven through the fake DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "./helpers/fakeDom.js";
import { initRemapPanel, remapRange } from "../app/renderer/remapPanel.js";
import { setLang, t } from "../src/i18n/i18n.js";

const find = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children ?? []) {
        const hit = find(child, id);
        if (hit) return hit;
    }
    return null;
};
const RICE = { ok: true, path: "C:/Songs/1 A - B/A - B (C) [Hard].osu", name: "A - B [Hard]", ok4k: true, rice: true, numeric: 13.04, label: "Gamma mid" };

function setup({ load = RICE, create = null } = {}) {
    const calls = { load: [], create: [] };
    const dom = fakeDom({
        remapLoad: async (req) => { calls.load.push(req); return typeof load === "function" ? load(req) : load; },
        remapCreate: async (req) => {
            calls.create.push(req);
            return create ?? { ok: true, file: "x.osu", version: "Hard (Beta mid remap)", numeric: 12.04, label: "Beta mid", reachable: true, removed: 150, added: 0 };
        },
        pathForFile: () => "C:/maps/picked.osu",
    });
    const panel = initRemapPanel({ root: dom.$("remap-panel") });
    const el = (id) => find(dom.$("remap-panel"), id);
    const chip = (choice) => el("remap-target").children.find((c) => c.dataset.choice === choice);
    return { dom, panel, calls, el, chip };
}

test("−1 and +1 are the whole level below or above the map's; a custom dan is its step band", () => {
    assert.deepEqual(remapRange(13.04, "easier"), { lo: 11.5, hi: 12.5 });
    assert.deepEqual(remapRange(13.04, "harder"), { lo: 13.5, hi: 14.5 });
    assert.deepEqual(remapRange(13.6, "easier"), { lo: 12.5, hi: 13.5 }, "13.6 reads as Delta low, so −1 is Gamma");
    assert.deepEqual(remapRange(1.2, "easier"), { lo: 0.5, hi: 1.5 });
    assert.deepEqual(remapRange(20.3, "harder"), { lo: 19.5, hi: 20.5 });
    const custom = remapRange(13.04, "custom", { level: 12, step: "mid" });
    assert.ok(Math.abs(custom.lo - 11.9) < 1e-9 && Math.abs(custom.hi - 12.1) < 1e-9, JSON.stringify(custom));
    assert.equal(remapRange(null, "easier"), null);
    assert.equal(remapRange(13, "custom", null), null);
});

test("osu!'s map: its dan is shown, −1 is the default, «Переделать» remaps and tells where the map went", async () => {
    const { el, calls } = setup();
    assert.equal(el("remap-go").disabled, true);
    await fire(el("remap-current"));
    assert.deepEqual(calls.load, [{ current: true }]);
    assert.equal(el("remap-map").textContent, t("create.remap.now", { name: "A - B [Hard]", label: "Gamma mid", numeric: "13.0" }));
    assert.equal(el("remap-go").disabled, false);
    await fire(el("remap-go"));
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].path, RICE.path);
    assert.deepEqual(calls.create[0].range, { lo: 11.5, hi: 12.5 });
    assert.ok(Number.isSafeInteger(calls.create[0].seed));
    assert.equal(el("remap-result").textContent, t("create.remap.done", { version: "Hard (Beta mid remap)", numeric: "12.0", removed: 150, added: 0 }));
    await fire(el("remap-go"));
    assert.notEqual(calls.create[1].seed, calls.create[0].seed, "again gives another layout");
});

test("«Можно миниджеки и анкоры» is off at first and goes with the remap", async () => {
    const { dom, el, calls } = setup();
    const box = el("remap-jacks");
    assert.equal(box.type, "checkbox");
    assert.equal(box.checked, false);
    assert.ok(textOf(dom.$("remap-panel")).includes(t("create.remap.allowJacks")));
    await fire(el("remap-current"));
    await fire(el("remap-go"));
    assert.equal(calls.create[0].allowJacks, false);
    box.checked = true;
    await fire(box, "change");
    await fire(el("remap-go"));
    assert.equal(calls.create[1].allowJacks, true);
    box.checked = false;
    await fire(box, "change");
    await fire(el("remap-go"));
    assert.equal(calls.create[2].allowJacks, false);
});

test("+1 and a custom dan", async () => {
    const { el, calls, chip } = setup({ create: { ok: true, file: "y.osu", version: "Hard (Delta low remap)", numeric: 13.66, label: "Delta low", reachable: false, removed: 0, added: 300 } });
    await fire(el("remap-current"));
    await fire(chip("harder"));
    await fire(el("remap-go"));
    assert.deepEqual(calls.create[0].range, { lo: 13.5, hi: 14.5 });
    assert.equal(el("remap-result").textContent, t("create.remap.closest", { version: "Hard (Delta low remap)", numeric: "13.7", removed: 0, added: 300 }));
    await fire(chip("custom"));
    assert.equal(el("remap-custom").hidden, false);
    el("remap-level").value = "11";
    el("remap-step").value = "high";
    await fire(el("remap-go"));
    const r = calls.create[1].range;
    assert.ok(Math.abs(r.lo - 11.3) < 1e-9 && Math.abs(r.hi - 11.5) < 1e-9, JSON.stringify(r));
    await fire(chip("easier"));
    assert.equal(el("remap-custom").hidden, true);
});

test("a miss «Можно миниджеки и анкоры» would have got closer to says to try it", async () => {
    const answer = { ok: true, file: "y.osu", version: "Hard (Delta low remap)", numeric: 13.66, label: "Delta low", reachable: false, removed: 0, added: 30 };
    const fields = { version: "Hard (Delta low remap)", numeric: "13.7", removed: 0, added: 30 };
    const { el } = setup({ create: { ...answer, jacksWouldHelp: true } });
    await fire(el("remap-current"));
    await fire(el("remap-go"));
    assert.equal(el("remap-result").textContent, `${t("create.remap.closest", fields)} ${t("create.remap.tryJacks")}`);
    const plain = setup({ create: answer });
    await fire(plain.el("remap-current"));
    await fire(plain.el("remap-go"));
    assert.equal(plain.el("remap-result").textContent, t("create.remap.closest", fields));
});

test("a picked .osu file is loaded by its path; a map that is not 4K rice cannot be remapped", async () => {
    const { el, calls } = setup({ load: { ...RICE, rice: false, numeric: null, label: null } });
    await fire(el("remap-file"), "change", { target: { files: [{ name: "picked.osu" }] } });
    assert.deepEqual(calls.load, [{ file: "C:/maps/picked.osu" }]);
    assert.equal(el("remap-map").textContent, `A - B [Hard] · ${t("create.remap.onlyRice")}`);
    assert.equal(el("remap-go").disabled, true);
    await fire(el("remap-go"));
    assert.equal(calls.create.length, 0);
});

test("failures are told in the status line and leave no map behind", async () => {
    const { el, calls } = setup({ load: { ok: false, message: "no map is selected in osu!" }, create: { ok: false, message: "worker died" } });
    await fire(el("remap-current"));
    assert.equal(el("remap-status").textContent, t("create.remap.failed", { message: "no map is selected in osu!" }));
    assert.equal(el("remap-go").disabled, true);
    globalThis.window.danApi.remapLoad = async () => RICE;
    await fire(el("remap-current"));
    await fire(el("remap-go"));
    assert.equal(el("remap-status").textContent, t("create.remap.failed", { message: "worker died" }));
    assert.equal(calls.create.length, 1);
});

test("the remap mode speaks English when the language is English", async () => {
    setLang("en");
    try {
        const { dom, el } = setup();
        await fire(el("remap-current"));
        const all = textOf(dom.$("remap-panel"));
        for (const text of ["Remake an existing map for another dan", "+ .osu file", "take from osu!", "−1 dan", "+1 dan", "custom dan", "Allow minijacks and anchors", "Remap", "A - B [Hard] · now Gamma mid (13.0)"]) {
            assert.ok(all.includes(text), text);
        }
        assert.ok(!/[А-Яа-яЁё]/.test(all), all);
    } finally {
        setLang("ru");
    }
});
