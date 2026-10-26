import test from "node:test";
import assert from "node:assert/strict";
import { createHooks, HOOK_NAMES } from "../app/hooks.js";

const flush = () => new Promise((r) => setImmediate(r));

test("subscribers run in the order they subscribed, with the payload", () => {
    const hooks = createHooks();
    const seen = [];
    hooks.on("result", (p) => seen.push(["a", p.key]));
    hooks.on("result", (p) => seen.push(["b", p.key]));
    hooks.on("window-load", () => seen.push(["load"]));
    hooks.emit("result", { key: "k1" });
    hooks.emit("window-load");
    assert.deepEqual(seen, [["a", "k1"], ["b", "k1"], ["load"]]);
    assert.deepEqual(HOOK_NAMES, ["result", "window-load"]);
});

test("off stops one subscriber only", () => {
    const hooks = createHooks();
    const seen = [];
    const off = hooks.on("result", () => seen.push("a"));
    hooks.on("result", () => seen.push("b"));
    off();
    off();
    hooks.emit("result", {});
    assert.deepEqual(seen, ["b"]);
});

test("a subscriber that throws (or rejects) is logged and the others still run", async () => {
    const lines = [];
    const hooks = createHooks({ log: (line) => lines.push(line) });
    const seen = [];
    hooks.on("result", () => { throw new Error("boom"); });
    hooks.on("result", async () => { throw new Error("later"); });
    hooks.on("result", () => seen.push("ok"));
    assert.doesNotThrow(() => hooks.emit("result", {}));
    await flush();
    assert.deepEqual(seen, ["ok"]);
    assert.ok(lines.some((l) => l.includes("result") && l.includes("boom")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("later")), lines.join("\n"));
});

test("an unknown hook name is a mistake caught at once", () => {
    const hooks = createHooks();
    assert.throws(() => hooks.on("resutl", () => {}), /resutl/);
    assert.throws(() => hooks.emit("nope"), /nope/);
    assert.throws(() => hooks.on("result", "not a function"), TypeError);
});
