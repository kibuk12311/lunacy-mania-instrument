// The settings window's keyboard block (app/overlay/settings.js) on a fake DOM: the switch, the keys of a key count
// as labels and where they come from, a lane's key set by clicking it and pressing a key in the window (a key already on
// another lane swaps), Escape cancels, «Use osu!'s» clears the keys set by hand, the reader missing is told.
import test from "node:test";
import assert from "node:assert/strict";
import { applyPatch, normalizeOverlaySettings } from "../src/overlay/settings.js";
import { setLang, t } from "../src/i18n/i18n.js";
import { fakeDom, fire } from "./helpers/fakeDom.js";

let pageNo = 0;
async function openSettings({ info }) {
    const dom = fakeDom();
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.location = { search: "" };
    const make = document.createElement;
    document.createElement = (tag) => {
        const node = make(tag);
        node.style.setProperty = () => {};
        return node;
    };
    const listeners = {};
    Object.assign(document, {
        body: { classList: { toggle() {} } },
        documentElement: { style: {} },
        visibilityState: "hidden",
        addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    });
    Object.assign(window, { devicePixelRatio: 1, matchMedia: () => ({ addEventListener() {} }) });
    let settings = normalizeOverlaySettings({ enabled: true });
    const patches = [];
    const asked = [];
    const on = {};
    window.overlayApi = {
        lang: "en",
        onConfig() {}, onState() {}, onVisible() {}, setScale() {}, setEdit() {},
        onSettings: (cb) => { on.settings = cb; },
        get: async () => ({ settings, edit: false }),
        set: async (patch) => {
            patches.push(patch);
            settings = applyPatch(settings, patch);
            return { settings, edit: false };
        },
        keys: async (n) => {
            asked.push(n);
            return info(n, settings);
        },
    };
    pageNo += 1;
    await import(`../app/overlay/settings.js?keys=${pageNo}`);
    const settle = () => new Promise((r) => setTimeout(r, 5));
    await settle();
    await settle();
    const lanes = () => dom.$("kbdLanes").children;
    const press = async (event) => {
        for (const fn of listeners.keydown ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...event });
        await settle();
        await settle();
    };
    return { dom, patches, asked, on, lanes, press, settle, labels: () => lanes().map((b) => b.textContent) };
}

// main's answer: osu!'s cfg says A S ; ' for 4K; nothing for the other counts
const fromOsu = (asked, settings) => {
    const n = asked ?? 4; // nothing asked: the last play's count (4K here)
    const osu = n === 4 ? ["A", "S", "OemSemicolon", "OemQuotes"] : null;
    const manual = settings.keyboard.keys[n] ?? null;
    const effective = manual ? { names: manual, source: "manual", file: null }
        : osu ? { names: osu, source: "osu", file: "osu!.Tester.cfg" } : null;
    return { keys: n, enabled: settings.keyboard.enabled, found: true, file: "osu!.Tester.cfg", osu, manual, effective, reader: null };
};

test("settings window: the keys from osu!'s settings; a lane set by a key pressed here; a key on another lane swaps; Escape cancels", async () => {
    setLang("en");
    const p = await openSettings({ info: fromOsu });
    assert.equal(p.dom.$("kbdOn").checked, true, "on out of the box");
    assert.deepEqual(p.labels(), ["A", "S", ";", "'"]);
    assert.equal(p.dom.$("kbdFrom").textContent, `${t("overlay.kbd.fromOsu")} (osu!.Tester.cfg)`);
    assert.equal(p.dom.$("kbdReset").hidden, true, "nothing set by hand: nothing to give back");
    assert.equal(p.dom.$("kbdHint").textContent, t("overlay.kbd.rebind"));

    await fire(p.lanes()[2]);
    assert.equal(p.labels()[2], t("overlay.kbd.press"));
    assert.equal(p.lanes()[2].className, "wait");
    await p.press({ keyCode: 76, code: "KeyL" });
    assert.deepEqual(p.patches.at(-1), { keyboard: { keys: { 4: ["A", "S", "L", "OemQuotes"] } } });
    assert.deepEqual(p.labels(), ["A", "S", "L", "'"]);
    assert.equal(p.dom.$("kbdFrom").textContent, t("overlay.kbd.fromManual"));
    assert.equal(p.dom.$("kbdReset").hidden, false);

    // S onto the first lane: the first lane's A goes to the second
    await fire(p.lanes()[0]);
    await p.press({ keyCode: 83, code: "KeyS" });
    assert.deepEqual(p.patches.at(-1).keyboard.keys[4], ["S", "A", "L", "OemQuotes"]);

    // Escape: nothing changes
    const before = p.patches.length;
    await fire(p.lanes()[1]);
    await p.press({ keyCode: 27, code: "Escape" });
    assert.equal(p.patches.length, before);
    assert.deepEqual(p.labels(), ["S", "A", "L", "'"]);
    // a key pressed with no lane waiting is nothing
    await p.press({ keyCode: 70, code: "KeyF" });
    assert.equal(p.patches.length, before);

    await fire(p.dom.$("kbdReset"));
    assert.deepEqual(p.patches.at(-1), { keyboard: { keys: { 4: null } } });
    await p.settle();
    assert.deepEqual(p.labels(), ["A", "S", ";", "'"]);

    // another key count: asked of main; none known for it → "?" lanes, set lane by lane, saved once whole
    p.dom.$("kbdCount").value = "2";
    await fire(p.dom.$("kbdCount"), "change", { target: { value: "2" } });
    await p.settle();
    assert.equal(p.asked.at(-1), 2);
    assert.deepEqual(p.labels(), ["?", "?"]);
    assert.equal(p.dom.$("kbdFrom").textContent, t("overlay.kbd.unknown"));
    const n = p.patches.length;
    await fire(p.lanes()[0]);
    await p.press({ keyCode: 70, code: "KeyF" });
    assert.equal(p.patches.length, n, "half a layout is not saved");
    assert.deepEqual(p.labels(), ["F", "?"]);
    await fire(p.lanes()[1]);
    await p.press({ keyCode: 74, code: "KeyJ" });
    assert.deepEqual(p.patches.at(-1), { keyboard: { keys: { 2: ["F", "J"] } } });

    await fire(p.dom.$("kbdOn"), "change", { target: { checked: false } });
    assert.deepEqual(p.patches.at(-1), { keyboard: { enabled: false } });
});

test("settings window: the reader missing or refused is told", async () => {
    setLang("en");
    const p = await openSettings({ info: (n, s) => ({ ...fromOsu(n, s), reader: "missing" }) });
    assert.equal(p.dom.$("kbdHint").textContent, t("overlay.kbd.missing"));
    const q = await openSettings({ info: (n, s) => ({ ...fromOsu(n, s), reader: "error" }) });
    assert.equal(q.dom.$("kbdHint").textContent, t("overlay.kbd.failed"));
});
