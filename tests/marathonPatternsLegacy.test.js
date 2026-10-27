// Auto-marathon settings saved before the pattern and level choices grew (one pattern, no level) still load.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire } from "./helpers/fakeDom.js";
import { initMarathonTab } from "../app/renderer/marathonTab.js";

const autoCalls = [];
const { $ } = fakeDom({
    marathonAuto: async (req) => { autoCalls.push(req); return { ok: true, entries: [], warnings: [] }; },
    marathonAutoCancel: async () => ({ ok: true }),
    onMarathonAutoProgress: () => () => {},
    profileEnsure: async () => ({ ok: false, message: "нет" }),
}, { storage: { "marathon.auto.v1": JSON.stringify({ templateId: "dan", patternIds: ["stream"], source: "manual", manualDan: 13 }) } });
initMarathonTab();

const selected = () => $("mar-patterns").children.filter((c) => c.className === "sel").map((c) => c.textContent);

test("one saved pattern comes back alone, unnumbered, and is what the pick asks for", async () => {
    assert.deepEqual(selected(), ["Стрим"]);
    await fire($("mar-pick"));
    assert.deepEqual(autoCalls.at(-1).patternIds, ["stream"]);
    // saved before "overall or per pattern" existed: per pattern, which for one pattern is what it always did
    assert.equal(autoCalls.at(-1).level, "pattern");
});
