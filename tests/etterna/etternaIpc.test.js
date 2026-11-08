// Main's side of the Etterna block (app/etternaIpc.js) with a stand-in client, analysis and card: a picked chart goes
// on the card at the rate asked, dans run on the background line one id at a time, what the window sends is checked,
// and every handler answers instead of throwing.
import test from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../../src/i18n/i18n.js";
import { createEtternaHandlers } from "../../app/etternaIpc.js";
import { msdText } from "../fixtures/etternaFolder.js";
import { parseMsd } from "../../app/etternaLibrary.js";

setLang("en");
const ROWS = [
    { id: "/Songs/P/A/a.sm|0", title: "A", artist: "x", pack: "P", version: "Hard 10", skip: null, msd: parseMsd(msdText(20)), key: "Xa" },
    { id: "/Songs/P/B/b.sm|0", title: "B", artist: "y", pack: "P", version: "Edit 30", skip: "warps", msd: null, key: null },
];

function setup({ throwOn = null } = {}) {
    const calls = { card: [], analyze: [], link: [] };
    const etterna = {
        status: async () => { if (throwOn === "status") throw new Error("disk gone"); return { linked: true, folder: "C:/Games/Etterna", size: 2 }; },
        link: async (dir) => { calls.link.push(dir); return { ok: true }; },
        detect: async () => ({ ok: true }),
        unlink: async () => ({ linked: false, folder: null }),
        setEnabled: async (on) => ({ linked: on, off: !on }),
        search: (query, opts) => { if (throwOn === "search") throw new Error("broken index"); return ROWS.filter((r) => r.title.toLowerCase().includes(query.toLowerCase())).slice(0, opts?.limit ?? 200); },
        row: (id) => ROWS.find((r) => r.id === id) ?? null,
        chart: async (id) => { const r = ROWS.find((x) => x.id === id); return r ? { id, osu: r.skip ? null : `osu of ${r.title}`, label: r.title } : null; },
    };
    const analysis = { analyzeQueued: async (text, rate) => { calls.analyze.push([text, rate]); return { kind: "ok", label: "8 mid", numeric: 8.1 }; } };
    const card = { showExternal: (req) => calls.card.push(req) };
    const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: ["C:/Games/Etterna"] }) };
    return { h: createEtternaHandlers({ etterna, analysis, card, dialog }), calls };
}

test("search answers rows with the MSD at the rate asked; 1.05x has none", async () => {
    const { h } = setup();
    const r = await h.search({ query: "", rate: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].msdAtRate, 20);
    assert.equal(r.rows[1].msdAtRate, null);
    assert.equal(r.rows[0].msd, undefined, "the whole table stays in main");
    assert.equal((await h.search({ query: "", rate: 1.05 })).rows[0].msdAtRate, null);
    assert.equal((await h.search({ query: "a", rate: 1.2 })).rows[0].msdAtRate, 24);
});

test("select puts the chart on the card at the rate asked", async () => {
    const { h, calls } = setup();
    const r = await h.select({ id: ROWS[0].id, rate: 1.3 });
    assert.equal(r.ok, true);
    assert.equal(calls.card.length, 1);
    assert.equal(calls.card[0].id, `etterna:${ROWS[0].id}`);
    assert.equal(calls.card[0].text, "osu of A");
    assert.equal(calls.card[0].rate, 1.3);
    const skipped = await h.select({ id: ROWS[1].id, rate: 1 });
    assert.equal(skipped.ok, false);
    assert.match(skipped.message, /couldn't be converted: warps/);
    assert.equal((await h.select({ id: "nope", rate: 1 })).ok, false);
    assert.equal(calls.card.length, 1);
});

test("dans run on the background line and answer per id; a skipped chart answers its reason", async () => {
    const { h, calls } = setup();
    const r = await h.dans({ ids: [ROWS[0].id, ROWS[1].id, "nope"], rate: 1.1 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.dans[ROWS[0].id], { label: "8 mid", numeric: 8.1 });
    assert.equal(r.dans[ROWS[1].id].numeric, null);
    assert.equal(r.dans[ROWS[1].id].why, "warps");
    assert.equal(r.dans.nope.numeric, null);
    assert.deepEqual(calls.analyze, [["osu of A", 1.1]]);
    const many = await h.dans({ ids: Array.from({ length: 80 }, () => ROWS[0].id), rate: 1 });
    assert.equal(Object.keys(many.dans).length, 1);
    assert.ok(calls.analyze.length <= 1 + 50, "at most 50 ids a call");
});

test("a chart the analyzer does not rate says why in words: LN map, not 4K rice, too short", async () => {
    for (const [answer, why] of [
        [{ kind: "not-rice", reason: "ln", keys: 4 }, "LN map"],
        [{ kind: "not-rice", reason: "keys", keys: 7 }, "not 4K rice"],
        [{ kind: "too-short" }, "too short"],
        [{ kind: "error", message: "the worker stopped" }, "the worker stopped"],
    ]) {
        const { h } = setup();
        const analysis = { analyzeQueued: async () => answer };
        const h2 = createEtternaHandlers({ etterna: { row: (id) => ROWS.find((r) => r.id === id), chart: async () => ({ osu: "osu" }) }, analysis, card: null });
        const r = await h2.dans({ ids: [ROWS[0].id], rate: 1 });
        assert.deepEqual(r.dans[ROWS[0].id], { label: "", numeric: null, why }, JSON.stringify(answer));
        assert.ok(h);
    }
});

test("rates outside 0.5–3.0 and ids that are not strings are refused", async () => {
    const { h, calls } = setup();
    for (const rate of [0.4, 3.5, Number.NaN, "1.0", null]) {
        assert.equal((await h.select({ id: ROWS[0].id, rate })).ok, false, `select at ${rate}`);
        assert.equal((await h.dans({ ids: [ROWS[0].id], rate })).ok, false, `dans at ${rate}`);
    }
    assert.equal((await h.select({ id: 42, rate: 1 })).ok, false);
    assert.equal((await h.dans({ ids: "nope", rate: 1 })).ok, false);
    assert.deepEqual((await h.dans({ ids: [42, null], rate: 1 })).dans, {});
    assert.equal(calls.card.length, 0);
    assert.equal(calls.analyze.length, 0);
});

test("every handler answers { ok: false, message } instead of throwing", async () => {
    const broken = setup({ throwOn: "status" });
    assert.deepEqual(await broken.h.status(), { ok: false, message: "disk gone" });
    const badIndex = setup({ throwOn: "search" });
    assert.deepEqual(await badIndex.h.search({ query: "", rate: 1 }), { ok: false, message: "broken index" });
    const { h, calls } = setup();
    assert.equal((await h.pickFolder()).ok, true);
    assert.deepEqual(calls.link, ["C:/Games/Etterna"]);
    assert.equal((await h.setEnabled({ on: "yes" })).ok, false, "the switch takes a boolean");
    assert.equal((await h.setEnabled({ on: false })).off, true);
});

test("the dans of an older batch are cancelled once the window asks for a newer one", async () => {
    const seen = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const analysis = { analyzeQueued: async (text, rate, { isCancelled } = {}) => { seen.push(isCancelled); await gate; return { kind: "ok", label: "x", numeric: 1 }; } };
    const etterna = { row: (id) => ROWS.find((r) => r.id === id), chart: async () => ({ osu: "osu" }) };
    const h = createEtternaHandlers({ etterna, analysis, card: null });
    const first = h.dans({ ids: [ROWS[0].id], rate: 1, batch: 1 });
    await new Promise((r) => setImmediate(r));
    const second = h.dans({ ids: [ROWS[0].id], rate: 1.1, batch: 2 });
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 2);
    assert.equal(seen[0](), true, "the first batch is stale");
    assert.equal(seen[1](), false, "the newest is not");
    release();
    await Promise.all([first, second]);
});
