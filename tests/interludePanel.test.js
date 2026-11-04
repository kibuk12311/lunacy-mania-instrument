// Interlude's block on the Settings page (app/renderer/interludePanel.js) in a fake DOM: the switch for Interlude as a
// whole is its first line; a click asks main over the live settings' channel and draws the block again; while it is
// off the block shows the switch, the remembered folder and a note, and every "only while linked" button in the window
// (app/renderer/interlude.js) is hidden as for no folder.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire } from "./helpers/fakeDom.js";
import { setLang, t } from "../src/i18n/i18n.js";
import { initInterludePanel } from "../app/renderer/interludePanel.js";
import { initInterludeState, interludeOff, interludeLinked, sendButton, sendButtons } from "../app/renderer/interlude.js";

const FOLDER = String.raw`D:\Games\Interlude`;
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const ON = { linked: true, folder: FOLDER, size: 3, selected: null };
const OFF = { linked: false, off: true, folder: FOLDER, selected: null };
// main's push of interlude-state, kept from the first test that starts the window's state (it starts once per file)
let pushState = null;

function mount({ lang = "en", answer = null } = {}) {
    setLang(lang);
    let status = ON;
    const calls = [];
    const api = {
        interludeStatus: async () => status,
        interludeSearch: async (query) => { calls.push(["search", query]); return { ok: true, items: [], total: 0, size: 3 }; },
        interludeLiveGet: async () => ({ ok: true, settings: { live: null, allowDownload: false, enabled: true, follow: true }, state: { status: "waiting" }, text: "waiting" }),
        interludeLiveSet: async (patch) => {
            calls.push(["live", patch]);
            if (answer) return answer;
            if (typeof patch.enabled === "boolean") status = patch.enabled ? ON : OFF;
            return { ok: true, settings: { live: null, allowDownload: false, enabled: status === ON, follow: status === ON }, state: { status: "off" }, text: "" };
        },
        onInterludeLive: () => {},
    };
    const dom = fakeDom(api);
    const button = dom.$("interlude-toggle");
    const panel = dom.$("interlude-panel");
    const view = initInterludePanel({ button, panel, api });
    // the block's parts by their class
    const part = (cls) => panel.children.find((n) => n.className.split(" ").includes(cls));
    return { ...dom, api, calls, panel, button, view, part, setStatus: (s) => { status = s; } };
}

test("the switch is the block's first line, on while Interlude is on, with the block as before", async () => {
    const m = mount();
    m.view.render(ON);
    const [first] = m.panel.children;
    assert.equal(first, m.part("il-enable"));
    const [input, label] = first.children;
    assert.equal(input.type, "checkbox");
    assert.equal(label.textContent, "Enable Interlude");
    assert.equal(first.title, t("interlude.panel.enableTitle"));
    assert.equal(input.checked, true);
    for (const cls of ["il-status", "il-actions", "il-live-box", "il-library", "il-note"]) assert.equal(m.part(cls).hidden, false, cls);
    assert.equal(m.part("il-off-note").hidden, true);
    assert.equal(m.button.hidden, false, "the IL button under the card");
});

test("a click turns Interlude off in main and draws the block as off: the switch, the folder and a note; again, back on", async () => {
    const m = mount();
    m.view.render(ON);
    const input = m.part("il-enable").children[0];
    input.checked = false;
    await fire(input, "change");
    await flush();
    assert.deepEqual(m.calls.filter(([k]) => k === "live"), [["live", { enabled: false }]]);
    assert.equal(input.checked, false);
    assert.equal(input.disabled, false);
    for (const cls of ["il-status", "il-actions", "il-live-box", "il-library", "il-note"]) assert.equal(m.part(cls).hidden, true, cls);
    assert.equal(m.part("il-folder").hidden, false);
    assert.equal(m.part("il-folder").textContent, FOLDER, "the folder stays remembered");
    assert.equal(m.part("il-off-note").hidden, false);
    assert.equal(m.part("il-off-note").textContent, t("interlude.panel.offNote"));
    assert.equal(m.button.hidden, true, "no IL button under the card");

    input.checked = true;
    await fire(input, "change");
    await flush();
    assert.deepEqual(m.calls.filter(([k]) => k === "live").at(-1), ["live", { enabled: true }]);
    assert.equal(input.checked, true);
    assert.equal(m.part("il-library").hidden, false);
    assert.equal(m.part("il-off-note").hidden, true);
    assert.equal(m.button.hidden, false);
});

test("off without a folder: the switch and the note only; a refused click says why and shows the switch as it is", async () => {
    const m = mount();
    m.view.render({ linked: false, off: true, folder: null, selected: null });
    assert.equal(m.part("il-folder").hidden, true);
    assert.equal(m.part("il-off-note").hidden, false);
    assert.equal(m.part("il-off-note").textContent, t("interlude.panel.offNoteNoFolder"), "no folder to remember: not said to be");

    const refused = mount({ answer: { ok: false, message: "could not save" } });
    refused.view.render(ON);
    const input = refused.part("il-enable").children[0];
    input.checked = false;
    await fire(input, "change");
    await flush();
    assert.equal(refused.part("il-answer").textContent, "could not save");
    assert.equal(input.checked, true, "drawn again from what main says");
});

test("the switch in Russian", () => {
    const m = mount({ lang: "ru" });
    m.view.render(OFF);
    assert.equal(m.part("il-enable").children[1].textContent, "Включить Interlude");
    assert.match(m.part("il-off-note").textContent, /^Interlude выключен/);
    setLang("en");
});

test("the window's shared state: off is no link for every tab, and says it is off", async () => {
    setLang("en");
    let push = null;
    const api = { interludeStatus: async () => ON, onInterludeState: (cb) => { push = cb; pushState = cb; }, interludeSend: async () => ({ ok: true, message: "" }) };
    fakeDom(api);
    initInterludeState(api);
    await flush();
    const send = sendButton(["x.osz"], api);
    assert.deepEqual([interludeLinked(), interludeOff(), send.hidden], [true, false, false]);
    push(OFF);
    assert.deepEqual([interludeLinked(), interludeOff(), send.hidden], [false, true, true], "\"→ Interlude\" hidden as for no folder");
    push(ON);
    assert.deepEqual([interludeLinked(), interludeOff(), send.hidden], [true, false, false]);
    send.dispose();
});

test("a result line made while Interlude is off gets its \"→ Interlude\" once Interlude is on again", () => {
    setLang("en");
    fakeDom({ interludeSend: async () => ({ ok: true, message: "" }) });
    const push = pushState;
    push(OFF);
    const line = sendButtons(["x.osz"]);
    assert.equal(line.length, 1, "the button is there, hidden");
    assert.equal(line[0].hidden, true);
    push(ON);
    assert.equal(line[0].hidden, false);
    line[0].dispose();
});
