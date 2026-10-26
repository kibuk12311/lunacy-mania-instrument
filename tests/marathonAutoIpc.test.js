import test from "node:test";
import assert from "node:assert/strict";
import { createMarathonAutoHandlers } from "../app/marathonAutoIpc.js";
import { setLang } from "../src/i18n/i18n.js";

const SKILL = { overall: 12.4, tiles: { speed: 12.1, stamina: 13.0, tech: 11.5, jack: null }, msd: {} };

function setup({ player = true, run } = {}) {
    const runs = [];
    const auto = {
        run: run ?? (async (request, isCancelled) => {
            runs.push({ request, isCancelled });
            return { entries: [{ path: "x.osu" }], warnings: [] };
        }),
    };
    const profile = { current: () => (player ? { ok: true, player: { id: 1, username: "Мира" }, skill: SKILL } : { ok: false }) };
    const lines = [];
    return { handlers: createMarathonAutoHandlers({ auto, profile, log: (l) => lines.push(l) }), runs, lines };
}

const good = (extra = {}) => ({ templateId: "dan", source: "manual", manualDan: 13, patternIds: ["jumpstream", "chordjack"], skipPlayed: false, rankedOnly: true, ...extra });

test("a manual dan course: the template's targets, its length, the patterns in turn", async () => {
    const { handlers, runs } = setup();
    const r = await handlers.start(good());
    assert.equal(r.ok, true);
    assert.deepEqual(r.entries, [{ path: "x.osu" }]);
    assert.deepEqual(r.plan, [12.55, 12.7, 12.85, 13]);
    assert.equal(r.finalDan, 13);
    assert.deepEqual(runs[0].request, {
        targets: [12.55, 12.7, 12.85, 13], patternIds: ["jumpstream", "chordjack"], lengthId: "medium", rankedOnly: true, skipPlayed: false,
    });
});

test("from the profile: the final dan is the first pattern's tile", async () => {
    const { handlers, runs } = setup();
    const r = await handlers.start(good({ source: "profile", manualDan: undefined, patternIds: ["handstream"], templateId: "stamina", skipPlayed: true }));
    assert.equal(r.finalDan, 13);
    assert.deepEqual(runs[0].request.targets, [12.4, 12.6, 12.8, 13]);
    assert.equal(runs[0].request.lengthId, "long");
    assert.equal(runs[0].request.skipPlayed, true);
    // no jack dan on the profile: the overall dan
    const jack = await handlers.start(good({ source: "profile", patternIds: ["chordjack"] }));
    assert.equal(jack.finalDan, 12.4);
});

test("custom: count 3–6 and step 0.1–0.4", async () => {
    const { handlers, runs } = setup();
    const r = await handlers.start(good({ templateId: "custom", count: 3, step: 0.3 }));
    assert.deepEqual(r.plan, [12.4, 12.7, 13]);
    assert.equal(runs[0].request.lengthId, "any");
    for (const [count, step] of [[2, 0.2], [7, 0.2], [3.5, 0.2], ["4", 0.2], [4, 0.05], [4, 0.5], [4, NaN], [4, null]]) {
        const bad = await handlers.start(good({ templateId: "custom", count, step }));
        assert.equal(bad.ok, false, `${count} ${step}`);
        assert.match(bad.message, /карт — от 3 до 6|шаг — от 0.1 до 0.4/);
    }
    assert.equal(runs.length, 1);
});

test("bad templates, patterns, dans and sources are refused before anything runs", async () => {
    const { handlers, runs } = setup();
    const cases = [
        [{ templateId: "nope" }, "неизвестный шаблон"],
        [{ templateId: undefined }, "неизвестный шаблон"],
        [{ patternIds: [] }, "выбери от 1 до 3 паттернов"],
        [{ patternIds: ["stream", "jack", "tech", "stamina"] }, "выбери от 1 до 3 паттернов"],
        [{ patternIds: ["nope"] }, "выбери от 1 до 3 паттернов"],
        [{ patternIds: "stream" }, "выбери от 1 до 3 паттернов"],
        [{ manualDan: 0.5 }, "выбери финальный дан"],
        [{ manualDan: 20.5 }, "выбери финальный дан"],
        [{ manualDan: "13" }, "выбери финальный дан"],
        [{ manualDan: NaN }, "выбери финальный дан"],
        [{ source: "other" }, "выбери финальный дан"],
    ];
    for (const [extra, message] of cases) {
        const r = await handlers.start(good(extra));
        assert.deepEqual(r, { ok: false, message }, JSON.stringify(extra));
    }
    for (const req of [null, undefined, 42, "x", []]) assert.equal((await handlers.start(req)).ok, false);
    assert.equal(runs.length, 0);
    // a repeated pattern counts once
    assert.equal((await handlers.start(good({ patternIds: ["stream", "stream"] }))).ok, true);
    assert.deepEqual(runs[0].request.patternIds, ["stream"]);
});

test("from the profile without a loaded player: told where to load one", async () => {
    const { handlers } = setup({ player: false });
    const r = await handlers.start(good({ source: "profile" }));
    assert.deepEqual(r, { ok: false, message: "Профиль не загружен — загрузи его во вкладке «Подбор» или выбери дан вручную." });
    setLang("en");
    try {
        assert.equal((await handlers.start(good({ source: "profile" }))).message, "No profile loaded — load one on the Picks tab or pick a dan by hand.");
    } finally {
        setLang("ru");
    }
});

test("one auto-marathon at a time; stop reaches the running one", async () => {
    let release;
    const { handlers } = setup({
        run: (request, isCancelled) => new Promise((resolve) => {
            release = () => resolve({ entries: [], warnings: [], cancelled: isCancelled() || undefined });
        }),
    });
    const first = handlers.start(good());
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await handlers.start(good()), { ok: false, message: "автоподбор уже идёт — дождись его или нажми «Стоп»" });
    assert.deepEqual(await handlers.cancel(), { ok: true });
    release();
    const r = await first;
    assert.equal(r.ok, true);
    assert.equal(r.cancelled, true);
    // free again, and a stop with nothing running is fine
    const again = handlers.start(good());
    await new Promise((r2) => setImmediate(r2));
    release();
    assert.equal((await again).cancelled, undefined);
    assert.deepEqual(await handlers.cancel(), { ok: true });
});

test("the handler never throws: a failing run, a failing profile", async () => {
    const failing = setup({ run: async () => { throw new Error("tracker down"); } });
    assert.deepEqual(await failing.handlers.start(good()), { ok: false, message: "tracker down" });
    // and is free again afterwards
    assert.deepEqual(await failing.handlers.start(good()), { ok: false, message: "tracker down" });
    const broken = createMarathonAutoHandlers({ auto: { run: async () => ({ entries: [], warnings: [] }) }, profile: { current: () => { throw new Error("x"); } } });
    assert.equal((await broken.start(good({ source: "profile" }))).ok, false);
});
