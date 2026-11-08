// Etterna support lives in src/etterna and app/etterna*: nothing the analyzer is made of may change with it. The
// fingerprint of the analyzer (src/core/analyzerVersion.js) names every module reachable from its roots; Etterna's
// converter and library must stay outside that set, so every saved dan stays valid.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzerFingerprint } from "../../src/core/analyzerVersion.js";

test("the analyzer is the released one, and none of its modules is Etterna's", async () => {
    const found = await analyzerFingerprint();
    assert.deepEqual(found.missing, []);
    assert.equal(found.fingerprint, "043490a9111ff0b5");
    assert.ok(found.code.every((file) => !file.startsWith("src/etterna/")), "src/etterna is outside the analyzer");
    assert.ok(found.code.every((file) => !file.startsWith("app/")), "and so is the app around it");
});
