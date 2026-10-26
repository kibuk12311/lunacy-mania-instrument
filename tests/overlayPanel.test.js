// The overlay block in the main window (app/renderer/overlayPanel.js): it shows the overlay's own state, its
// checkboxes and buttons go through the overlay's channels, and a change made anywhere else redraws it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeDom, fire, textOf } from "./helpers/fakeDom.js";
import { setLang } from "../src/i18n/i18n.js";
import { applyPatch, normalizeOverlaySettings, WIDGETS } from "../src/overlay/settings.js";
import { initOverlayPanel } from "../app/renderer/overlayPanel.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const flush = () => new Promise((resolve) => setImmediate(resolve));

// a fake of the overlay's side: the settings it keeps, the calls that reach it, its broadcast to the window
function fakeOverlayApi() {
    let state = { settings: normalizeOverlaySettings(null), edit: false };
    const calls = [];
    let listener = null;
    return {
        calls,
        broadcast: (payload) => { state = payload; listener?.(payload); },
        state: () => state,
        api: {
            overlayGet: async () => state,
            overlaySet: async (patch) => {
                calls.push(["set", patch]);
                state = { ...state, settings: applyPatch(state.settings, patch) };
                return state;
            },
            overlaySetEdit: (on) => calls.push(["edit", on]),
            overlayOpenSettings: () => calls.push(["open"]),
            onOverlaySettings: (cb) => { listener = cb; },
        },
    };
}

function mount(lang = "ru") {
    setLang(lang);
    const fake = fakeOverlayApi();
    const { $ } = fakeDom(fake.api);
    globalThis.document.addEventListener = () => {};
    const button = $("overlay-toggle");
    const panel = $("overlay-panel");
    panel.hidden = true;
    panel.contains = () => false;
    button.setAttribute = () => {};
    const view = initOverlayPanel({ button, panel, api: fake.api });
    return { fake, button, panel, view };
}

const boxes = (panel) => {
    const out = [];
    const walk = (node) => {
        if (node.tagName === "INPUT") out.push(node);
        node.children.forEach(walk);
    };
    walk(panel);
    return out;
};
const find = (panel, tag, cls) => {
    let hit = null;
    const walk = (node) => {
        if (!hit && node.tagName === tag && (!cls || node.className.split(" ").includes(cls))) hit = node;
        node.children.forEach(walk);
    };
    walk(panel);
    return hit;
};

test("main window overlay block: on/off, a box per widget (NPS among them), the move mode and the settings link", async () => {
    const { fake, button, panel } = mount("ru");
    await flush();
    const [enabled, ...perWidget] = boxes(panel);
    assert.equal(perWidget.length, WIDGETS.length);
    assert.deepEqual(perWidget.map((b) => b.dataset.widget), WIDGETS);
    assert.equal(enabled.checked, false, "the overlay starts off");
    assert.ok(perWidget.every((b) => b.checked));
    const text = textOf(panel);
    for (const word of ["Оверлей в игре", "Показывать во время игры", "NPS карты", "Линии нажатий", "Двигать окна (Ctrl+Shift+O)", "Все настройки…"]) {
        assert.ok(text.includes(word), word);
    }
    // the button opens and closes it
    assert.equal(panel.hidden, true);
    await fire(button, "click", { stopPropagation() {} });
    assert.equal(panel.hidden, false);

    enabled.checked = true;
    await fire(enabled, "change");
    assert.deepEqual(fake.calls.at(-1), ["set", { enabled: true }]);
    const nps = perWidget.find((b) => b.dataset.widget === "nps");
    nps.checked = false;
    await fire(nps, "change");
    assert.deepEqual(fake.calls.at(-1), ["set", { widgets: { nps: { enabled: false } } }]);
    await flush();
    assert.equal(nps.checked, false);

    await fire(find(panel, "BUTTON", "ov-move"), "click");
    assert.deepEqual(fake.calls.at(-1), ["edit", true]);
    await fire(find(panel, "A", "ov-more"), "click", { preventDefault() {} });
    assert.deepEqual(fake.calls.at(-1), ["open"]);
});

test("main window overlay block: a change from the tray, the hotkey or the settings window redraws it (en)", async () => {
    const { fake, panel } = mount("en");
    await flush();
    const settings = applyPatch(fake.state().settings, { enabled: true, widgets: { kps: { enabled: false } } });
    fake.broadcast({ settings, edit: true });
    const [enabled, ...perWidget] = boxes(panel);
    assert.equal(enabled.checked, true);
    assert.equal(perWidget.find((b) => b.dataset.widget === "kps").checked, false);
    const move = find(panel, "BUTTON", "ov-move");
    assert.equal(move.textContent, "Done, lock them");
    fake.broadcast({ settings, edit: false });
    assert.equal(move.textContent, "Move windows (Ctrl+Shift+O)");
    assert.ok(textOf(panel).includes("Map NPS"));
    setLang("ru");
});

test("the OV button sits in the analysis footer, the panel right after it; compact mode hides both", () => {
    const html = readFileSync(path.join(root, "app/renderer/index.html"), "utf8");
    const footer = html.slice(html.indexOf("<footer>"), html.indexOf("</footer>"));
    assert.match(footer, /id="overlay-toggle"[^>]*>OV</);
    assert.match(html, /<\/footer>\s*<div id="overlay-panel" class="overlay-panel" hidden><\/div>/);
    const css = readFileSync(path.join(root, "app/renderer/styles.css"), "utf8");
    assert.match(css, /body\.compact \.ov-button, body\.compact \.overlay-panel \{ display: none; \}/);
});
