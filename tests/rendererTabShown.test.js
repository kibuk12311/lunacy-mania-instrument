// renderer.js tells the tabs which one is showing (mapgen v3: the create tab's playfield pauses on any other tab):
// showTab dispatches "tab-shown" on window with the tab as detail. Driven through the open-tab event.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom } from "./helpers/fakeDom.js";

test("showing a tab dispatches tab-shown with the tab", async () => {
    // every danApi method answers "nothing here" so the tabs can init
    const api = new Proxy({ lang: "ru" }, {
        get: (target, key) => (key in target ? target[key] : () => Promise.resolve({ ok: false, message: "test" })),
    });
    const { $, window, events } = fakeDom(api);
    globalThis.document.body = $("test-body");
    globalThis.document.documentElement = $("test-html");
    globalThis.document.addEventListener = () => {};
    // the picks tab reaches a checkbox's label through closest()
    const byId = globalThis.document.getElementById;
    globalThis.document.getElementById = (id) => Object.assign(byId(id), { closest: () => byId(`${id}-parent`) });
    globalThis.Option = class Option {
        constructor(text, value, _defaultSelected, selected) {
            Object.assign(this, { text, value, selected: Boolean(selected) });
        }
    };
    const tabs = [];
    window.addEventListener("tab-shown", (e) => tabs.push(e.detail));
    await import("../app/renderer/renderer.js");

    for (const tab of ["create", "rate", "analysis"]) window.dispatchEvent(new CustomEvent("open-tab", { detail: { tab } }));
    assert.deepEqual(tabs, ["create", "rate", "analysis"]);
    assert.equal($("create-tab").hidden, true);
    assert.equal($("analysis-tab").hidden, false);
    assert.ok(events.some((e) => e.type === "tab-shown" && e.detail === "analysis"));
});
