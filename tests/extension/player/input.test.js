import { test } from "node:test";
import assert from "node:assert/strict";
import { createInput, createRebinder, offsetNudge, validKeys, keyLabel, DEFAULT_KEYS } from "../../../extension/player/input.js";

function fakeTarget() {
    const listeners = {};
    return {
        listeners,
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
        fire(type, props = {}) {
            const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
            for (const fn of [...(listeners[type] ?? [])]) fn(event);
            return event;
        },
    };
}

function setup(keys = DEFAULT_KEYS) {
    const win = fakeTarget();
    const doc = fakeTarget();
    doc.visibilityState = "visible";
    const log = [];
    const input = createInput({
        target: win, doc, keys,
        onLaneDown: (col, e) => log.push(["down", col, e?.timeStamp ?? null]),
        onLaneUp: (col) => log.push(["up", col]),
        onKey: (e) => log.push(["key", e.code]),
        onLeave: () => log.push(["leave"]),
    });
    return { win, doc, log, input };
}

test("default keys D F J K by event.code; layout does not matter", () => {
    assert.deepEqual([...DEFAULT_KEYS], ["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const { win, log } = setup();
    const e = win.fire("keydown", { code: "KeyD", key: "в", timeStamp: 12 }); // Russian layout: key "в", code KeyD
    assert.equal(e.defaultPrevented, true);
    win.fire("keydown", { code: "KeyK", key: "л", timeStamp: 13 });
    win.fire("keyup", { code: "KeyD" });
    assert.deepEqual(log, [["down", 0, 12], ["down", 3, 13], ["up", 0]]);
});

test("repeats are ignored; other keys go to onKey and are not prevented", () => {
    const { win, log } = setup();
    win.fire("keydown", { code: "KeyF" });
    const rep = win.fire("keydown", { code: "KeyF", repeat: true });
    assert.equal(rep.defaultPrevented, true);
    win.fire("keydown", { code: "KeyF" }); // a second keydown without keyup (OS quirk) is still one press
    const other = win.fire("keydown", { code: "KeyQ" });
    assert.equal(other.defaultPrevented, false);
    win.fire("keyup", { code: "KeyQ" }); // not held: nothing
    assert.deepEqual(log, [["down", 1, null], ["key", "KeyQ"]]);
});

test("blur and a hidden page release held lanes and report the leave", () => {
    const { win, doc, log, input } = setup();
    win.fire("keydown", { code: "KeyD" });
    win.fire("keydown", { code: "KeyJ" });
    assert.deepEqual(input.heldColumns().sort(), [0, 2]);
    win.fire("blur");
    assert.deepEqual(log.slice(2), [["up", 0], ["up", 2], ["leave"]]);
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    assert.deepEqual(log.at(-1), ["leave"]);
    win.fire("keyup", { code: "KeyD" }); // already released
    assert.equal(log.filter((x) => x[0] === "up").length, 2);
});

test("setKeys swaps bindings; capture takes every keydown while rebinding", () => {
    const { win, log, input } = setup();
    input.setKeys(["KeyS", "KeyD", "KeyK", "KeyL"]);
    win.fire("keydown", { code: "KeyS" });
    win.fire("keydown", { code: "KeyF" });
    assert.deepEqual(log, [["down", 0, null], ["key", "KeyF"]]);
    const got = [];
    input.setCapture((e) => got.push(e.code));
    const e = win.fire("keydown", { code: "KeyL" });
    assert.equal(e.defaultPrevented, true);
    win.fire("keydown", { code: "KeyA", repeat: true });
    input.setCapture(null);
    assert.deepEqual(got, ["KeyL"]);
    input.detach();
    win.fire("keydown", { code: "KeyK" });
    assert.equal(log.length, 2); // detached: nothing more arrives
});

test("rebinding: four keys, Escape/Tab/Enter/Space refused, no duplicates", () => {
    const r = createRebinder(4);
    assert.equal(r.feed("Space").status, "refused");
    assert.equal(r.feed("Escape").status, "refused");
    assert.equal(r.feed("Tab").status, "refused");
    assert.equal(r.feed("Enter").status, "refused");
    assert.equal(r.feed("KeyS").status, "next");
    assert.equal(r.feed("KeyS").status, "duplicate");
    assert.equal(r.feed("KeyD").status, "next");
    assert.equal(r.feed("Semicolon").status, "next");
    const done = r.feed("KeyL");
    assert.equal(done.status, "done");
    assert.deepEqual(done.keys, ["KeyS", "KeyD", "Semicolon", "KeyL"]);
    assert.ok(validKeys(done.keys));
});

test("valid key sets and labels", () => {
    assert.ok(validKeys(["KeyD", "KeyF", "KeyJ", "KeyK"]));
    assert.ok(!validKeys(["KeyD", "KeyF", "KeyJ"]));
    assert.ok(!validKeys(["KeyD", "KeyD", "KeyJ", "KeyK"]));
    assert.ok(!validKeys(["KeyD", "Space", "KeyJ", "KeyK"]));
    assert.ok(!validKeys(["KeyD", 5, "KeyJ", "KeyK"]));
    assert.ok(!validKeys("KeyD"));
    assert.equal(keyLabel("KeyD"), "D");
    assert.equal(keyLabel("Digit3"), "3");
    assert.equal(keyLabel("Semicolon"), ";");
    assert.equal(keyLabel("Numpad4"), "Num 4");
    assert.equal(keyLabel("F13"), "F13");
});

test("offset nudge: - and = by 5 ms, with Shift by 1 ms", () => {
    assert.equal(offsetNudge({ code: "Minus" }), -5);
    assert.equal(offsetNudge({ code: "Equal" }), 5);
    assert.equal(offsetNudge({ code: "Minus", shiftKey: true }), -1);
    assert.equal(offsetNudge({ code: "Equal", shiftKey: true }), 1);
    assert.equal(offsetNudge({ code: "NumpadAdd" }), 5);
    assert.equal(offsetNudge({ code: "NumpadSubtract" }), -5);
    assert.equal(offsetNudge({ code: "KeyA" }), 0);
});

test("rebinding refuses keys the browser cannot name ('' / Unidentified)", () => {
    const r = createRebinder(4);
    assert.equal(r.feed("KeyS").status, "next");
    assert.equal(r.feed("").status, "refused");
    assert.equal(r.feed("Unidentified").status, "refused");
    assert.equal(r.feed(undefined).status, "refused");
    assert.deepEqual(r.keys, ["KeyS"]);
});
