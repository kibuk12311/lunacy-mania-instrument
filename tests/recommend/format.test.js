import test from "node:test";
import assert from "node:assert/strict";
import { mmss, signed, shortNumber } from "../../src/recommend/format.js";
import { REC_PATTERNS, GOALS, LENGTHS, patternById, goalById, lengthById } from "../../src/recommend/catalog.js";
import { setLang } from "../../src/i18n/i18n.js";

test("mm:ss for map lengths", () => {
    assert.deepEqual([0, 9, 60, 197, 260, 3600].map(mmss), ["0:00", "0:09", "1:00", "3:17", "4:20", "60:00"]);
});

test("signed deltas use a typographic minus and no negative zero", () => {
    assert.deepEqual([0.3, -0.24, 0, -0.01, 1.25].map((x) => signed(x)), ["+0.3", "−0.2", "0.0", "0.0", "+1.3"]);
    assert.equal(signed(NaN), "—");
});

test("short play counts", () => {
    assert.deepEqual([950, 126009, 1234567, 2000000].map(shortNumber), ["950", "126k", "1.2M", "2M"]);
});

test("catalog lookups", () => {
    assert.equal(REC_PATTERNS.length, 7);
    assert.equal(patternById("jumpstream").tile, "stamina");
    assert.equal(goalById("growth").dan[1], 0.5);
    assert.equal(lengthById("long").lenMin, 240);
    assert.equal(patternById("ln"), null);
    assert.ok(GOALS.every((g) => g.dan[0] < g.dan[1]) && LENGTHS[0].id === "any");
});

test("catalog names and hints follow the language at read time", () => {
    assert.deepEqual(REC_PATTERNS.map((p) => p.name), ["Стрим", "Джампстрим", "Хендстрим", "Стамина", "Чордджек", "Джек", "Тех"]);
    assert.equal(goalById("comfort").hint, "чуть ниже твоего уровня — набить точность");
    setLang("en");
    try {
        assert.deepEqual(REC_PATTERNS.map((p) => p.name), ["Stream", "Jumpstream", "Handstream", "Stamina", "Chordjack", "Jack", "Tech"]);
        assert.deepEqual(GOALS.map((g) => g.name), ["Comfort", "Growth", "Challenge"]);
        assert.equal(goalById("growth").hint, "what's worth playing right now");
        assert.deepEqual(LENGTHS.map((l) => l.name), ["any", "up to 2:30", "2–4 min", "4+ min"]);
        // a serialized copy (IPC, JSON) carries the text of the moment and keeps the other fields
        assert.deepEqual(JSON.parse(JSON.stringify(lengthById("medium"))), { id: "medium", name: "2–4 min", lenMin: 120, lenMax: 240 });
        assert.equal(GOALS.every((g) => !/[А-Яа-яЁё]/.test(g.name + g.hint)), true);
    } finally {
        setLang("ru");
    }
    assert.equal(patternById("tech").name, "Тех");
});
