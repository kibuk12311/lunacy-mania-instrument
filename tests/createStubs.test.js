// The cross-stream stubs of mapgen v3 that the create tab can import from day 1 (stream C fills them in).
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom } from "./helpers/fakeDom.js";
import { initExportPanel } from "../app/renderer/exportPanel.js";
import { initRemapPanel } from "../app/renderer/remapPanel.js";

test("the export panel answers the create tab's calls (its drawing is tested in tests/exportPanel.test.js)", () => {
    const { $ } = fakeDom({});
    const panel = initExportPanel({ root: $("export-panel"), metaRoot: $("meta-group"), player: null, getSelection: () => ({ song: null, diffs: [] }) });
    assert.equal(typeof panel.onSongLoaded, "function");
    assert.equal(typeof panel.onSelectionChanged, "function");
    panel.onSongLoaded({ path: "a.mp3" });
    panel.onSelectionChanged();
});

test("the remap panel is an empty object for now", () => {
    const { $ } = fakeDom({});
    assert.deepEqual(initRemapPanel({ root: $("remap-panel") }), {});
});

test("fake DOM canvases hand out a 2d context that records drawing", () => {
    const { $ } = fakeDom({});
    const canvas = document.createElement("canvas");
    assert.equal(canvas.width, 300);
    assert.equal(canvas.height, 150);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f5c66b";
    ctx.fillRect(0, 0, 10, 20);
    ctx.beginPath();
    assert.equal(ctx.fillStyle, "#f5c66b");
    assert.ok(ctx.measureText("abc").width > 0);
    assert.deepEqual(ctx.calls, [["fillRect", 0, 0, 10, 20], ["beginPath"]]);
    assert.equal(canvas.getContext("webgl"), null);
    // by id too, so a tab can draw into the canvases of the markup
    assert.equal(typeof $("playfield").getContext("2d").clearRect, "function");
});
