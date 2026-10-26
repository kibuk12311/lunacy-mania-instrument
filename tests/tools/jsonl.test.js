import test from "node:test";
import assert from "node:assert/strict";
import { jsonLine, parseJsonl, SPLITLINES_BREAKS } from "../../tools/lib/jsonl.mjs";

test("jsonLine: no character Python's str.splitlines() breaks at, and JSON.parse gives the same value back", () => {
    assert.deepEqual(SPLITLINES_BREAKS.map((c) => c.codePointAt(0)), [0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);
    const nasty = `a${SPLITLINES_BREAKS.join("b")}z`;
    const value = { artist: nasty, title: "Line\u{2028}Sep\u{2029}Para\u{0085}Next", version: "\u{000b}\u{000c}\u{001c}\u{001d}\u{001e}", n: [1, "x\ny"] };
    const line = jsonLine(value);
    for (const c of SPLITLINES_BREAKS) assert.equal(line.includes(c), false, `U+${c.charCodeAt(0).toString(16)}`);
    assert.deepEqual(JSON.parse(line), value);
    // what Python's splitlines() sees: one line
    assert.equal(line.split(new RegExp(`[${SPLITLINES_BREAKS.join("")}]`, "u")).length, 1);
    // plain text is unchanged
    assert.equal(jsonLine({ a: "Камелия ★" }), JSON.stringify({ a: "Камелия ★" }));
});

test("parseJsonl splits at \\n only, drops \\r and blank lines, counts bad lines", () => {
    const text = `${JSON.stringify({ a: "x\u{2028}y" })}\r\n\n{"b":2}\nnot json\n`;
    const { rows, bad } = parseJsonl(text);
    assert.deepEqual(rows, [{ a: "x\u{2028}y" }, { b: 2 }]);
    assert.equal(bad, 1);
});
