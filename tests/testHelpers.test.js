// The shared test helpers behave as the tab tests expect.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeDom, fire, textOf } from "./helpers/fakeDom.js";
import { codeFiles, stripComments } from "./helpers/source.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("fakeDom: elements by id, empty queries, window events and a localStorage stub", async () => {
    const { $, events, storage } = fakeDom({ ping: () => "pong" }, { storage: { a: 1 } });
    assert.equal(document.getElementById("x"), $("x"));
    assert.equal(document.querySelector(".y"), null);
    assert.deepEqual($("x").querySelectorAll("b"), []);
    assert.equal(window.danApi.ping(), "pong");

    const seen = [];
    window.addEventListener("open-tab", (e) => seen.push(e.detail.tab));
    window.dispatchEvent(new CustomEvent("open-tab", { detail: { tab: "rate" } }));
    assert.deepEqual(seen, ["rate"]);
    assert.equal(events[0].type, "open-tab");

    assert.equal(localStorage.getItem("a"), "1");
    localStorage.setItem("b", 2);
    assert.equal(storage.get("b"), "2");
    assert.equal(localStorage.getItem("none"), null);

    const kid = document.createElement("span");
    kid.textContent = "kid";
    $("x").textContent = "x";
    $("x").append(kid);
    assert.equal(textOf($("x")), "x | kid");
    let clicks = 0;
    $("x").addEventListener("click", () => { clicks += 1; });
    await fire($("x"));
    assert.equal(clicks, 1);

    fakeDom({}, { storage: null });
    assert.equal(typeof globalThis.localStorage, "undefined");
});

test("source helpers: comments go, strings stay; code files skip the message files", () => {
    assert.equal(stripComments("a // b\nc /* d */ \"// e\""), "a \nc  \"// e\"");
    const files = codeFiles(root).map((f) => path.relative(root, f).split(path.sep).join("/"));
    assert.ok(files.includes("app/main.js"));
    assert.ok(files.includes("app/preload.cjs"));
    assert.ok(files.includes("src/i18n/i18n.js"));
    assert.ok(!files.some((f) => f.startsWith("src/i18n/messages/")));
});
