import { test } from "node:test";
import assert from "node:assert/strict";
import { start, createQueue, previewMismatch, PAGE_KEY, MAX_IN_FLIGHT } from "../../../extension/content/main.js";
import { PRIORITY, ERR } from "../../../extension/shared/protocol.js";
import { RATES } from "../../../extension/shared/rates.js";
import { makeDocument, makeWindow, fakeTimers, FakeEvent, flush } from "./helpers/dom.js";
import { pageHtml, beatmapset, SET_ID, FOUR_K_ORDER, okResult, meta } from "./helpers/fixture.js";

const ORIGIN = "chrome-extension://pagelanetestextensionidxxxxxxxxxx";
const runtime = { getURL: (p) => `${ORIGIN}/${p}` };

// A client whose analyze answers wait until the test lets them go (auto: answer at once).
function fakeClient({ auto = true, answer = defaultAnswer } = {}) {
    const calls = [];
    const waiting = [];
    let running = 0;
    let maxRunning = 0;
    return {
        calls, waiting, manual: !auto,
        get maxRunning() { return maxRunning; },
        analyze(args) {
            calls.push(args);
            running++;
            maxRunning = Math.max(maxRunning, running);
            const done = (value) => { running--; return value; };
            if (auto) return Promise.resolve(answer(args)).then(done);
            return new Promise((resolve) => waiting.push({ args, resolve: (v) => resolve(done(v ?? answer(args))) }));
        },
        async info() { return { ok: true, version: "0.1.0", analyzer: { fingerprint: "f", appVersion: "0.10.3" } }; },
        async release(n = Infinity) {
            for (let i = 0; i < n && waiting.length; i++) {
                waiting.shift().resolve();
                await flush();
            }
            await flush();
        },
    };
}

function defaultAnswer({ beatmapId, rate }) {
    const base = { ok: true, beatmapId, rate, cached: false, meta: meta(beatmapId), analyzer: { fingerprint: "f", appVersion: "0.10.3" } };
    if (beatmapId === 1004) return { ...base, result: { kind: "not-rice", reason: "ln", keys: 4 } };
    return { ...base, result: okResult(10 + (beatmapId % 10) + (rate - 1) * 10, { rate }) };
}

// waits until the page's queue is empty (a manual client's waiting answers are let go)
async function settle({ ctl, client }) {
    for (let i = 0; i < 200; i++) {
        await ctl.loaded();
        if (client.waiting.length) await client.release();
        await flush();
        if (!ctl.queue.size && !ctl.queue.running && !client.waiting.length) return;
    }
    throw new Error("the page did not settle");
}

function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return { data, async get(k) { return data.get(k); }, async set(k, v) { data.set(k, v); } };
}

async function setup({ html = pageHtml(), url = `https://osu.ppy.sh/beatmapsets/${SET_ID}#mania/1001`, client = fakeClient(), storage = memoryStorage(), fetch = null } = {}) {
    const doc = makeDocument(html);
    const timers = fakeTimers();
    const win = makeWindow(doc, { url, timers });
    const ctl = await start({ client, doc, win, storage, runtime, timers, fetch });
    await ctl.loaded();
    if (client.manual) for (let i = 0; i < 5; i++) await flush();
    else await settle({ ctl, client });
    const host = () => doc.querySelector("[data-lm-root]");
    const $ = (s) => host()?.shadowRoot.querySelector(s) ?? null;
    const $$ = (s) => host()?.shadowRoot.querySelectorAll(s) ?? [];
    return { doc, win, timers, ctl, client, storage, host, $, $$ };
}

test("queue: priority order, at most `limit` running, no doubles, bump and remove", async () => {
    const q = createQueue({ limit: 2 });
    const order = [];
    const gates = [];
    const job = (name) => (p) => new Promise((resolve) => { order.push(`${name}:${p}`); gates.push(resolve); });
    q.add("a", PRIORITY.LOW, job("a"));
    q.add("b", PRIORITY.LOW, job("b"));
    q.add("c", PRIORITY.LOW, job("c"));
    q.add("d", PRIORITY.NORMAL, job("d"));
    q.add("e", PRIORITY.LOW, job("e"));
    assert.equal(q.add("d", PRIORITY.LOW, job("d2")), false, "waiting key not added twice");
    q.bump("e", PRIORITY.HIGH);
    q.remove((k) => k === "c");
    await flush();
    assert.deepEqual(order, ["a:low", "b:low"]);
    assert.equal(q.add("a", PRIORITY.HIGH, job("a2")), false, "running key not added again");
    gates.shift()();
    await flush();
    assert.deepEqual(order, ["a:low", "b:low", "e:high"]);
    gates.shift()();
    await flush();
    assert.deepEqual(order.at(-1), "d:normal");
    while (gates.length) { gates.shift()(); await flush(); }
    await q.idle();
    assert.equal(order.length, 4, "c was removed");
});

test("previewMismatch: different audio or preview time among the 4K answers", () => {
    const r = (m) => ({ ok: true, meta: meta(1, m) });
    assert.equal(previewMismatch([r({}), r({}), undefined, { ok: false }]), false);
    assert.equal(previewMismatch([r({}), r({ audioFilename: "Other.mp3" })]), true);
    assert.equal(previewMismatch([r({}), r({ audioFilename: "AUDIO.mp3" })]), false, "names compare case-insensitively");
    assert.equal(previewMismatch([r({}), r({ previewTime: 1 })]), true);
});

test("no panel off set pages or on sets without 4K mania", async () => {
    const off = await setup({ url: "https://osu.ppy.sh/beatmapsets/1/discussion" });
    assert.equal(off.host(), null);
    assert.equal(off.client.calls.length, 0);
    const sevenOnly = beatmapset({ beatmaps: beatmapset().beatmaps.filter((b) => b.cs !== 4 || b.mode !== "mania" || b.convert) });
    const none = await setup({ html: pageHtml({ set: sevenOnly }) });
    assert.equal(none.host(), null);
    assert.equal(none.client.calls.length, 0);
});

test("the selected diff first (high), the others normal, at most 3 in flight; chips and card fill in", async () => {
    const client = fakeClient({ auto: false });
    const t = await setup({ client, url: `https://osu.ppy.sh/beatmapsets/${SET_ID}#mania/1002` });
    assert.equal(t.host().getAttribute("data-set-id"), String(SET_ID));
    assert.equal(t.host().getAttribute("data-lm-state"), "loading");
    assert.equal(t.doc.querySelector(".beatmapset-header").nextElementSibling, t.host(), "after the header");
    assert.equal(client.calls.length, MAX_IN_FLIGHT);
    assert.deepEqual(client.calls.map((c) => [c.beatmapId, c.priority]), [[1002, "high"], [1003, "normal"], [1001, "normal"]]);
    assert.deepEqual(client.calls[0], { beatmapId: 1002, checksum: beatmapset().beatmaps[1].checksum, rate: 1, lang: "en", priority: "high" });
    assert.deepEqual(t.$$("[data-lm-chip]").map((c) => c.getAttribute("data-state")), ["pending", "pending", "pending", "pending"]);
    await client.release(1);
    assert.equal(client.calls.length, 4, "the next one starts as one finishes");
    await client.release();
    await settle(t);
    assert.ok(client.maxRunning <= MAX_IN_FLIGHT);
    assert.equal(client.calls.length, 4, "one request per 4K diff, no rates while the block is closed");
    assert.deepEqual(t.$$("[data-lm-chip]").map((c) => c.getAttribute("data-beatmap-id")), FOUR_K_ORDER.map(String));
    assert.deepEqual(t.$$("[data-lm-chip]").map((c) => c.getAttribute("data-state")), ["ok", "ok", "ok", "not-rice"]);
    assert.equal(t.host().getAttribute("data-lm-state"), "ready");
    assert.equal(t.$('[data-lm-chip][aria-current="true"]').getAttribute("data-beatmap-id"), "1002");
    assert.equal(t.$("[data-lm-card]").getAttribute("data-beatmap-id"), "1002");
    assert.equal(t.$('[data-lm-chip][data-beatmap-id="1002"]').getAttribute("data-numeric"), "12");
    assert.match(t.$(".foot").textContent, /Lunacy mania 0\.10\.3/);
});

test("rates: only while open, low priority, for the selected diff; remembered in storage", async () => {
    const t = await setup();
    assert.equal(t.$$("[data-lm-rate-row]").length, 0);
    t.$("[data-lm-rates-toggle]").click();
    await settle(t);
    assert.deepEqual(t.storage.data.get(PAGE_KEY), { ratesOpen: true });
    const rateCalls = t.client.calls.filter((c) => c.rate !== 1);
    assert.equal(rateCalls.length, RATES.length - 1, "1.0× is the card's own answer");
    assert.ok(rateCalls.every((c) => c.beatmapId === 1001 && c.priority === "low"));
    const rows = t.$$("[data-lm-rate-row]");
    assert.equal(rows.length, 15);
    assert.ok(rows.every((r) => r.getAttribute("data-state") === "ok"));
    assert.equal(t.$('[data-lm-rate-row][data-rate="1.2"]').getAttribute("data-numeric"), String(11 + 2));

    // another diff: its own rates; back again: nothing asked twice
    t.win.history.replaceState(null, "", "#mania/1003");
    t.timers.tick(300);
    await settle(t);
    assert.equal(t.$("[data-lm-card]").getAttribute("data-beatmap-id"), "1003");
    assert.equal(t.client.calls.filter((c) => c.rate !== 1 && c.beatmapId === 1003).length, 14);
    t.win.history.replaceState(null, "", "#mania/1001");
    t.timers.tick(300);
    await settle(t);
    assert.equal(t.client.calls.filter((c) => c.rate !== 1 && c.beatmapId === 1001).length, 14);

    // the LN diff: no rates asked
    t.win.history.replaceState(null, "", "#mania/1004");
    t.timers.tick(300);
    await settle(t);
    assert.equal(t.client.calls.filter((c) => c.rate !== 1 && c.beatmapId === 1004).length, 0);

    t.$("[data-lm-rates-toggle]").click();
    await flush();
    assert.deepEqual(t.storage.data.get(PAGE_KEY), { ratesOpen: false });
    assert.equal(t.$$("[data-lm-rate-row]").length, 0);
});

test("rates open from storage start after the selected diff's answer; closing drops the queued ones", async () => {
    const client = fakeClient({ auto: false });
    const t = await setup({ client, storage: memoryStorage({ [PAGE_KEY]: { ratesOpen: true } }) });
    await client.release(1); // the selected diff (1001)
    const queuedRates = () => t.ctl.queue.size;
    assert.ok(queuedRates() > 0);
    t.$("[data-lm-rates-toggle]").click();
    await client.release();
    await settle(t);
    const rateCalls = client.calls.filter((c) => c.rate !== 1);
    assert.ok(rateCalls.length <= 2, `only those already running went out (${rateCalls.length})`);
});

test("hash poll, active-class change and chip clicks follow the selected difficulty", async () => {
    const t = await setup();
    t.win.history.replaceState(null, "", "#mania/1002");
    t.timers.tick(299);
    assert.equal(t.$("[data-lm-card]").getAttribute("data-beatmap-id"), "1001");
    t.timers.tick(1);
    assert.equal(t.$("[data-lm-card]").getAttribute("data-beatmap-id"), "1002");

    // a 7K diff in the hash: no chip selected, no card, a short line says it is not 4K
    t.win.history.replaceState(null, "", "#mania/1005");
    t.timers.tick(300);
    assert.equal(t.$("[data-lm-card]"), null);
    assert.equal(t.$('[data-lm-chip][aria-current="true"]'), null);
    assert.match(t.$("[data-lm-foreign]").textContent, /isn't 4K/);

    // the picker's --active class moves (no hash change)
    const anchor = (id) => t.doc.querySelector(`a[href$="#mania/${id}"]`);
    for (const a of t.doc.querySelectorAll(".beatmapset-beatmap-picker__beatmap")) a.classList.remove("beatmapset-beatmap-picker__beatmap--active");
    anchor(1003).classList.add("beatmapset-beatmap-picker__beatmap--active");
    t.win.mutate();
    t.timers.tick(30);
    assert.equal(t.$("[data-lm-card]").getAttribute("data-beatmap-id"), "1003");
    assert.equal(t.$("[data-lm-foreign]"), null);

    // a chip click clicks osu-web's own picker anchor
    let clicked = null;
    anchor(1004).addEventListener("click", (e) => { clicked = e.target.getAttribute("href"); });
    t.$('[data-lm-chip][data-beatmap-id="1004"]').click();
    assert.match(clicked, /#mania\/1004$/);
    assert.equal(t.$("[data-lm-card]").getAttribute("data-beatmap-id"), "1004");
    assert.equal(t.$('[data-lm-chip][aria-current="true"]').getAttribute("data-beatmap-id"), "1004");
});

test("osu-web's picker on a non-4K difficulty: the line, then back to the same 4K one by the picker or a chip", async () => {
    const t = await setup();
    const anchor = (id) => t.doc.querySelector(`a[href$="#mania/${id}"]`);
    const activate = (id) => {
        for (const a of t.doc.querySelectorAll(".beatmapset-beatmap-picker__beatmap")) a.classList.remove("beatmapset-beatmap-picker__beatmap--active");
        anchor(id).classList.add("beatmapset-beatmap-picker__beatmap--active");
        t.win.mutate();
        t.timers.tick(30);
    };
    // osu-web: the 7K anchor active and its hash
    activate(1005);
    t.win.history.replaceState(null, "", "#mania/1005");
    t.timers.tick(300);
    assert.ok(t.$("[data-lm-foreign]"));
    assert.equal(t.$('[data-lm-chip][aria-current="true"]'), null);
    // back to the 4K diff that was selected before: the card is back
    activate(1001);
    assert.equal(t.$("[data-lm-foreign]"), null);
    assert.equal(t.$("[data-lm-card]").getAttribute("data-beatmap-id"), "1001");
    assert.equal(t.$('[data-lm-chip][aria-current="true"]').getAttribute("data-beatmap-id"), "1001");
    // again away, and back by our own chip of the same diff
    activate(1005);
    assert.ok(t.$("[data-lm-foreign]"));
    t.$('[data-lm-chip][data-beatmap-id="1001"]').click();
    assert.equal(t.$("[data-lm-foreign]"), null);
    assert.equal(t.$("[data-lm-card]").getAttribute("data-beatmap-id"), "1001");
});

test("a page opened on a non-4K difficulty starts with the line; Russian words", async () => {
    const t = await setup({ html: pageHtml({ lang: "ru" }), url: `https://osu.ppy.sh/beatmapsets/${SET_ID}#mania/1005` });
    assert.equal(t.$("[data-lm-card]"), null);
    assert.match(t.$("[data-lm-foreign]").textContent, /не 4K/);
    assert.equal(t.$$("[data-lm-chip]").length, 4, "the chips stay to pick a 4K one");
});

test("a failed rate row: its retry asks again; reopening the block or selecting the diff again retries failed rates", async () => {
    let failing = true;
    const client = fakeClient({
        answer: (args) => (failing && args.rate === 1.2 ? { ok: false, beatmapId: args.beatmapId, rate: 1.2, error: { code: ERR.NETWORK } } : defaultAnswer(args)),
    });
    const t = await setup({ client });
    t.$("[data-lm-rates-toggle]").click();
    await settle(t);
    const row = () => t.$('[data-lm-rate-row][data-rate="1.2"]');
    const asked = () => client.calls.filter((c) => c.beatmapId === 1001 && c.rate === 1.2).length;
    assert.equal(row().getAttribute("data-state"), "error");
    assert.match(row().textContent, /can't reach osu!/);
    assert.equal(t.$$('[data-lm-action="retry-rate"]').length, 1, "only the failed row has one");
    assert.equal(asked(), 1);

    // its own retry (still failing): asked again at high priority
    t.$('[data-lm-action="retry-rate"][data-rate="1.2"]').click();
    assert.equal(row().getAttribute("data-state"), "pending");
    await settle(t);
    assert.equal(asked(), 2);
    assert.equal(client.calls.at(-1).priority, "high");
    assert.equal(row().getAttribute("data-state"), "error");

    // the block closed and opened again
    t.$("[data-lm-rates-toggle]").click();
    t.$("[data-lm-rates-toggle]").click();
    await settle(t);
    assert.equal(asked(), 3);

    // another diff and back: failed ones asked again, the ok ones not
    const okBefore = client.calls.filter((c) => c.beatmapId === 1001 && c.rate === 1.1).length;
    t.win.history.replaceState(null, "", "#mania/1002");
    t.timers.tick(300);
    await settle(t);
    failing = false;
    t.win.history.replaceState(null, "", "#mania/1001");
    t.timers.tick(300);
    await settle(t);
    assert.equal(asked(), 4);
    assert.equal(client.calls.filter((c) => c.beatmapId === 1001 && c.rate === 1.1).length, okBefore);
    assert.equal(row().getAttribute("data-state"), "ok");
    assert.equal(t.$$('[data-lm-action="retry-rate"]').length, 0);
});

test("chip click without a picker anchor marks the hash itself", async () => {
    const t = await setup();
    t.doc.querySelector(`a[href$="#mania/1002"]`).remove();
    t.$('[data-lm-chip][data-beatmap-id="1002"]').click();
    assert.equal(t.win.location.hash, "#mania/1002");
    t.timers.tick(600);
    assert.equal(t.$("[data-lm-card]").getAttribute("data-beatmap-id"), "1002");
});

test("React dropping the host puts it back; a floating host moves under the header once it exists", async () => {
    const t = await setup();
    const host = t.host();
    host.remove();
    t.win.mutate();
    t.timers.tick(30);
    assert.equal(t.doc.querySelector(".beatmapset-header").nextElementSibling, host);

    const late = await setup({ html: pageHtml({ rendered: false }) });
    assert.equal(late.host().hasAttribute("data-lm-floating"), true);
    const rendered = makeDocument(pageHtml());
    late.doc.querySelector('[data-react="beatmapset-page"]').append(rendered.querySelector(".osu-page"));
    late.timers.tick(300);
    assert.equal(late.host().hasAttribute("data-lm-floating"), false);
    assert.equal(late.doc.querySelector(".beatmapset-header").nextElementSibling, late.host());
});

test("turbo:before-cache tears down; late answers are dropped; turbo:load builds the next set's panel", async () => {
    const client = fakeClient({ auto: false });
    const t = await setup({ client });
    t.$('[data-lm-action="play-file"]').click();
    assert.ok(t.doc.querySelector("iframe[data-lm-player]"));
    t.doc.dispatchEvent(new FakeEvent("turbo:before-cache"));
    assert.equal(t.host(), null, "host removed before Turbo snapshots the page");
    assert.equal(t.doc.querySelector("iframe[data-lm-player]"), null, "player closed");
    assert.equal(t.doc.documentElement.style.overflow, "");
    await client.release();
    assert.equal(t.host(), null, "late answers draw nothing");
    const before = client.calls.length;
    t.timers.tick(3000);
    assert.equal(client.calls.length, before, "no work for a page that is gone");

    // Turbo visit: new body, new URL, turbo:load
    const next = beatmapset({ id: 900002, beatmaps: [{ ...beatmapset().beatmaps[0], id: 3001, beatmapset_id: 900002 }] });
    const fresh = makeDocument(pageHtml({ set: next, activeId: 3001 }));
    t.doc.body.replaceChildren(...fresh.body.childNodes);
    t.win.navigate("https://osu.ppy.sh/beatmapsets/900002");
    t.doc.dispatchEvent(new FakeEvent("turbo:load"));
    await flush();
    await client.release();
    await settle(t);
    assert.equal(t.host().getAttribute("data-set-id"), "900002");
    assert.deepEqual(t.$$("[data-lm-chip]").map((c) => c.getAttribute("data-beatmap-id")), ["3001"]);
    assert.equal(t.$("[data-lm-chip]").getAttribute("data-state"), "ok");
});

test("a second turbo:load for the same page keeps the panel and asks nothing again", async () => {
    const t = await setup();
    const host = t.host();
    const n = t.client.calls.length;
    t.doc.dispatchEvent(new FakeEvent("turbo:load"));
    await settle(t);
    assert.equal(t.host(), host);
    assert.equal(t.client.calls.length, n);
    t.timers.tick(300);
    assert.equal(t.ctl.page.selectedId, 1001, "still watching");
});

test("the demo buttons open the player with the page's params", async () => {
    const t = await setup({ html: pageHtml({ user: {} }) });
    t.$('[data-lm-action="play-preview"]').click();
    let frame = t.doc.querySelector("iframe[data-lm-player]");
    let params = new URLSearchParams(frame.getAttribute("src").split("#")[1]);
    assert.equal(frame.getAttribute("src").split("#")[0], `${ORIGIN}/player/player.html`);
    assert.deepEqual(Object.fromEntries(params), {
        set: String(SET_ID), map: "1001", src: "preview", rate: "1.0", lang: "en",
        checksum: beatmapset().beatmaps[0].checksum, login: "0", previewWarn: "0",
    });
    t.doc.body.dispatchEvent(new FakeEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(t.doc.querySelector("iframe[data-lm-player]"), null);

    // the demo rate from the rates block, «● сейчас» on it
    t.$("[data-lm-rates-toggle]").click();
    await settle(t);
    t.$('[data-lm-rate-row][data-rate="1.15"]').click();
    assert.match(t.$('[data-lm-rate-row][data-rate="1.15"]').textContent, /● now/);
    t.$('[data-lm-action="play-full"]').click();
    frame = t.doc.querySelector("iframe[data-lm-player]");
    params = new URLSearchParams(frame.getAttribute("src").split("#")[1]);
    assert.equal(params.get("src"), "full");
    assert.equal(params.get("rate"), "1.15");
    // the player's close message, from its own window and the extension's origin
    t.win.dispatchEvent(new FakeEvent("message", { source: frame.contentWindow, origin: ORIGIN, data: { source: "lunacy-mania-player", type: "close" } }));
    assert.equal(t.doc.querySelector("iframe[data-lm-player]"), null);
});

test("preview: warned when the diffs' audio differs, off without a preview point; full off when osu! disables downloads", async () => {
    const answer = (args) => {
        const a = defaultAnswer(args);
        if (args.beatmapId === 1002) a.meta = meta(1002, { audioFilename: "other.mp3" });
        if (args.beatmapId === 1003) a.meta = meta(1003, { previewTime: -1 });
        return a;
    };
    const set = beatmapset({ availability: { download_disabled: true, more_information: null } });
    const t = await setup({ client: fakeClient({ answer }), html: pageHtml({ set, user: { id: 5 } }) });
    t.$('[data-lm-action="play-preview"]').click();
    const params = new URLSearchParams(t.doc.querySelector("iframe[data-lm-player]").getAttribute("src").split("#")[1]);
    assert.equal(params.get("previewWarn"), "1");
    assert.equal(params.get("login"), "1");
    t.ctl.player.close();

    assert.equal(t.$('[data-lm-action="play-full"]').hasAttribute("disabled"), true);
    assert.equal(t.ctl.openPlayer("full"), null);

    t.win.history.replaceState(null, "", "#mania/1003");
    t.timers.tick(300);
    const preview = t.$('[data-lm-action="play-preview"]');
    assert.equal(preview.hasAttribute("disabled"), true);
    preview.click();
    assert.equal(t.doc.querySelector("iframe[data-lm-player]"), null);
    t.$('[data-lm-action="play-file"]').click();
    assert.ok(t.doc.querySelector("iframe[data-lm-player]"), "the own-file fallback stays");
});

test("a client that throws (extension reloaded) reads as «reload the page»; retry asks again", async () => {
    let fail = true;
    const client = fakeClient({ answer: (args) => { if (fail) throw new Error("Extension context invalidated."); return defaultAnswer(args); } });
    const t = await setup({ client });
    assert.deepEqual(t.$$("[data-lm-chip]").map((c) => c.getAttribute("data-state")), ["error", "error", "error", "error"]);
    assert.match(t.$("[data-lm-card]").textContent, /reload the page/);
    fail = false;
    t.$('[data-lm-action="retry"]').click();
    await settle(t);
    assert.equal(t.$('[data-lm-chip][data-beatmap-id="1001"]').getAttribute("data-state"), "ok");
    assert.equal(client.calls.at(-1).priority, "high");
});

test("a failed answer is shown by its code", async () => {
    const client = fakeClient({ answer: (args) => (args.beatmapId === 1001 ? { ok: false, beatmapId: 1001, rate: 1, error: { code: ERR.NOT_FOUND, status: 404 } } : defaultAnswer(args)) });
    const t = await setup({ client });
    assert.match(t.$("[data-lm-card]").textContent, /Error: osu! has no such map/);
});

test("Russian page: lang passed to the analyzer and the player", async () => {
    const t = await setup({ html: pageHtml({ lang: "ru" }) });
    assert.ok(t.client.calls.every((c) => c.lang === "ru"));
    assert.match(t.$('[data-lm-action="play-preview"]').textContent, /Сыграть демо/);
    t.$('[data-lm-action="play-preview"]').click();
    assert.equal(new URLSearchParams(t.doc.querySelector("iframe").getAttribute("src").split("#")[1]).get("lang"), "ru");
});

test("no json in the page: one same-origin fetch of the page", async () => {
    const urls = [];
    const fetch = async (url) => { urls.push(url); return { ok: true, text: async () => pageHtml() }; };
    const t = await setup({ html: pageHtml({ json: false }), fetch });
    assert.deepEqual(urls, [`/beatmapsets/${SET_ID}`]);
    assert.equal(t.$$("[data-lm-chip]").length, 4);
});

test("stop removes everything", async () => {
    const t = await setup();
    t.ctl.stop();
    assert.equal(t.host(), null);
    assert.equal(t.timers.pending, 0);
    assert.equal(t.win.observers.size, 0);
});
