import test from "node:test";
import assert from "node:assert/strict";
import { createProfileClient } from "../app/renderer/profile.js";
import { fakeDom } from "./helpers/fakeDom.js";

const SKILL = { overall: 13.4, overallLabel: "Gamma mid/high", tiles: { stamina: 13.26 } };
const PLAYER = { id: 777, username: "TestPlayer", avatarUrl: null };

// danApi fake: profileEnsure answers `answer` (a value, or a function of the query), records its calls
function fakeApi(answer = { ok: true, player: PLAYER, skill: SKILL }) {
    const api = {
        calls: [],
        changed: null,
        profileEnsure: async (query) => {
            api.calls.push(query);
            return typeof answer === "function" ? answer(query) : answer;
        },
        onProfileChanged: (cb) => { api.changed = cb; },
    };
    return api;
}

const storageWith = (settings) => {
    const data = new Map(settings === undefined ? [] : [["rec-settings", JSON.stringify(settings)]]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
};

function client(api, { settings, clock = { now: 0 } } = {}) {
    return createProfileClient({ api: () => api, storage: () => storageWith(settings), now: () => clock.now });
}

test("starts idle; ensure loads the profile once and tells the subscribers", async () => {
    const api = fakeApi();
    const c = client(api, { settings: { source: "tracker", query: "TestPlayer" } });
    const states = [];
    c.onProfile((s) => states.push(s.state));
    assert.deepEqual(c.getProfile(), { state: "idle" });
    const r = await c.ensureProfile();
    assert.deepEqual(r, { state: "ready", player: PLAYER, skill: SKILL });
    assert.deepEqual(c.getProfile(), r);
    assert.deepEqual(states, ["loading", "ready"]);
    assert.deepEqual(api.calls, ["TestPlayer"]);
});

test("the nick from the picks settings is a hint only in tracker mode", async () => {
    const tracker = fakeApi();
    await client(tracker, { settings: { source: "tracker", query: " TestPlayer " } }).ensureProfile();
    assert.deepEqual(tracker.calls, ["TestPlayer"]);

    // manual mode: the hand-set profile is the one in use, main is not asked; mania-tracker's own load takes no hint
    const manual = fakeApi();
    const m = client(manual, { settings: { source: "manual", query: "TestPlayer" } });
    assert.equal((await m.ensureProfile()).manual, true);
    assert.deepEqual(manual.calls, []);
    await m.ensureTrackerProfile();
    assert.deepEqual(manual.calls, [undefined]);

    const none = fakeApi();
    await client(none).ensureProfile();
    assert.deepEqual(none.calls, [undefined]);

    const broken = fakeApi();
    await createProfileClient({ api: () => broken, storage: () => { throw new Error("no storage"); } }).ensureProfile();
    assert.deepEqual(broken.calls, [undefined]);
});

test("one profileEnsure per session, also when asked twice at once or after none", async () => {
    const api = fakeApi({ ok: false, reason: "none" });
    const c = client(api);
    const [a, b] = await Promise.all([c.ensureProfile(), c.ensureProfile()]);
    assert.deepEqual(a, { state: "none" });
    assert.deepEqual(b, { state: "none" });
    await c.ensureProfile();
    assert.equal(api.calls.length, 1);

    const ready = fakeApi();
    const r = client(ready);
    await r.ensureProfile();
    await r.ensureProfile();
    assert.equal(ready.calls.length, 1);
});

test("a failure (an answer or a rejected invoke) is tried again only after 60 s", async () => {
    const clock = { now: 1000 };
    let fail = true;
    const api = fakeApi(() => {
        if (fail) throw new Error("no handler for profile-ensure");
        return { ok: true, player: PLAYER, skill: SKILL };
    });
    const c = client(api, { clock });
    assert.deepEqual(await c.ensureProfile(), { state: "failed", message: "no handler for profile-ensure" });
    clock.now += 59_999;
    await c.ensureProfile();
    assert.equal(api.calls.length, 1);
    clock.now += 1;
    fail = false;
    assert.equal((await c.ensureProfile()).state, "ready");
    assert.equal(api.calls.length, 2);

    const told = fakeApi({ ok: false, reason: "failed", message: "mania-tracker 502" });
    assert.deepEqual(await client(told).ensureProfile(), { state: "failed", message: "mania-tracker 502" });
});

test("profile-changed from main makes it ready and tells the subscribers; unsubscribe stops that", async () => {
    const api = fakeApi({ ok: false, reason: "none" });
    const c = client(api);
    const seen = [];
    const off = c.onProfile((s) => seen.push(s));
    await c.ensureProfile();
    api.changed({ player: PLAYER, skill: SKILL });
    assert.deepEqual(c.getProfile(), { state: "ready", player: PLAYER, skill: SKILL });
    assert.deepEqual(seen.at(-1), { state: "ready", player: PLAYER, skill: SKILL });
    off();
    api.changed({ player: { ...PLAYER, username: "Other" }, skill: SKILL });
    assert.equal(c.getProfile().player.username, "Other");
    assert.equal(seen.at(-1).player.username, "TestPlayer");
});

test("a subscriber that throws does not stop the others", async () => {
    const c = client(fakeApi());
    const seen = [];
    c.onProfile(() => { throw new Error("boom"); });
    c.onProfile((s) => seen.push(s.state));
    await c.ensureProfile();
    assert.deepEqual(seen, ["loading", "ready"]);
});

test("a danApi without the profile methods (an old fake) gives none, no exception", async () => {
    const c = client({ rateInfo: async () => ({}) });
    assert.deepEqual(await c.ensureProfile(), { state: "none" });
    assert.deepEqual(createProfileClient({ api: () => undefined }).getProfile(), { state: "idle" });
    assert.deepEqual(await createProfileClient({ api: () => undefined }).ensureProfile(), { state: "none" });
});

test("the module's own client reads window.danApi and localStorage", async () => {
    const api = fakeApi();
    fakeDom(api, { storage: { "rec-settings": JSON.stringify({ source: "tracker", query: "TestPlayer" }) } });
    const { getProfile, onProfile, ensureProfile } = await import("../app/renderer/profile.js");
    const seen = [];
    onProfile((s) => seen.push(s.state));
    assert.equal(getProfile().state, "idle");
    assert.equal((await ensureProfile()).state, "ready");
    assert.deepEqual(api.calls, ["TestPlayer"]);
    assert.deepEqual(seen, ["loading", "ready"]);
});
