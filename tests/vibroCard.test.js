// The vibro mark where the player sees a map: the card's chip and its tooltip (app/renderer/view.js, the view from the
// selection controller), the Dan widget's "this play" (src/overlay/dan.js, app/overlay/danSource.js) and the profile's
// play row (app/renderer/profileViews.js is DOM: its words are checked through the messages). The map's dan itself
// never changes.
import test from "node:test";
import assert from "node:assert/strict";
import { renderView, vibroChip } from "../app/renderer/view.js";
import { createSelectionController, cardVibro } from "../app/selectionController.js";
import { buildDanPayload, danView, playDanOf } from "../src/overlay/dan.js";
import { createDanSource } from "../app/overlay/danSource.js";
import { setLang, t } from "../src/i18n/i18n.js";
import { chartOf, stream, jack, after } from "./fixtures/makeVibroChart.js";

const head = stream(1000, 200, 120);
const VIBRO_TEXT = chartOf([...head, ...jack(after(head), 200, 80, [0, 1])]);
const NORMAL_TEXT = chartOf([...head, ...jack(after(head), 200, 120, [0, 1])]);
const OK = { kind: "ok", label: "Kappa mid", numeric: 21.4, halfWidth: 0.3, confidenceLevel: "high", primary: "Chordjacks", top3: [{ name: "Chordjacks", share: 0.8 }], tech: false, bpm: 187.5, durationSec: 60, rate: 1 };
const memoryCache = () => {
    const m = new Map();
    return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
};
const flush = () => new Promise((r) => setImmediate(r));
const hits = { max: 950, n300: 0, n200: 50, n100: 0, n50: 0, miss: 0 };

test("card: a vibro chart's view carries the mark, a normal one's does not; the result stays the analysis's", async () => {
    const views = [];
    const files = { V: VIBRO_TEXT, N: NORMAL_TEXT };
    let current = null;
    const ctrl = createSelectionController({
        fetchOsu: async () => files[current], analyze: async () => ({ ...OK }), cache: memoryCache(), onView: (v) => views.push(v),
    });
    current = "V";
    ctrl.onFrame({ state: "songselect", checksum: "V", rate: 1, mods: [] });
    await flush();
    const v = views.at(-1);
    assert.equal(v.screen, "result");
    assert.deepEqual(v.result, OK, "the dan and everything else as the analysis gave it");
    assert.equal(v.vibro.share, 0.667);
    assert.equal(v.vibro.peakGapMs, 80);
    current = "N";
    ctrl.onFrame({ state: "songselect", checksum: "N", rate: 1, mods: [] });
    await flush();
    assert.equal("vibro" in views.at(-1), false);
    // the same chart slowed down to 0.8x is 100 ms a hit: not vibro there
    current = "V";
    ctrl.onFrame({ state: "songselect", checksum: "V", rate: 0.8, mods: [] });
    await flush();
    assert.equal("vibro" in views.at(-1), false);
    assert.equal(cardVibro("not a map", 1), null);
});

test("card: the chip says Vibro in both languages, its tooltip how much and how fast, in both languages; no chip without the mark", () => {
    try {
        setLang("ru");
        const vibro = cardVibro(VIBRO_TEXT, 1);
        const html = renderView({ screen: "result", result: OK, vibro }, {});
        assert.ok(html.includes('class="chip an-vibro"'), html);
        assert.ok(html.includes(">Vibro<"));
        assert.ok(html.includes("67% нот"), html);
        assert.ok(html.includes("до 13 нажатий в секунду"), html);
        assert.ok(html.includes("21.4"), "the map's dan is shown as it is");
        assert.ok(!renderView({ screen: "result", result: OK }, {}).includes("an-vibro"));
        // the comparison of calculators shows it too
        assert.ok(renderView({ screen: "result", result: OK, vibro }, { calc: "all" }).includes("an-vibro"));
        setLang("en");
        const chip = vibroChip(vibro);
        assert.equal(chip.text, "Vibro");
        assert.match(chip.title, /^Vibro at this rate: 67% of the notes are in long, fast jacks \(up to 13 hits a second per key\)\./);
        assert.match(vibroChip({ share: 0.2, peakGapMs: null }).title, /^Vibro at this rate: 20% of the notes are in long, fast jacks\./);
        assert.equal(vibroChip(null), null);
    } finally {
        setLang("ru");
    }
});

test("Dan widget: a vibro map's play has no dan of its own and says why; the map's dan is shown as ever", async () => {
    const source = createDanSource({ analyze: async ({ result }) => ({ result }) });
    source.fromCard({ checksum: "abc", rate: 1, result: { ...OK }, text: VIBRO_TEXT });
    source.fromCard({ checksum: "def", rate: 1, result: { ...OK }, text: NORMAL_TEXT });
    const vibroEntry = source.get("abc|1.00");
    assert.equal(vibroEntry.vibro.vibro, true);
    assert.equal(source.get("def|1.00").vibro.vibro, false);
    const payload = buildDanPayload({ checksum: "abc", rate: 1, entry: vibroEntry, recording: true });
    assert.deepEqual(payload.vibro, { share: 0.667, peakGapMs: 80 });
    assert.equal(payload.numeric, 21.4);
    const normal = buildDanPayload({ checksum: "def", rate: 1, entry: source.get("def|1.00"), recording: true });
    assert.equal("vibro" in normal, false);
    assert.equal(playDanOf(payload, hits), null);
    assert.ok(Number.isFinite(playDanOf(normal, hits)));
    try {
        setLang("ru");
        const results = danView(payload, { phase: "results", hits, mods: [] });
        assert.equal(results.play, "вибро — в даны профиля не идёт");
        assert.equal(results.playDan, null);
        assert.equal(results.number, "21.4");
        assert.equal(danView(payload, { phase: "playing", hits }).play, "", "only on the results screen");
        assert.equal(danView({ ...payload, recording: false }, { phase: "results", hits }).play, "", "not without the local profile");
        assert.match(danView(normal, { phase: "results", hits, mods: [] }).play, /^эта игра: /);
        setLang("en");
        assert.equal(danView(payload, { phase: "results", hits, mods: [] }).play, t("overlay.dan.vibro"));
        assert.equal(t("overlay.dan.vibro"), "vibro — not counted in your dans");
    } finally {
        setLang("ru");
    }
    // a map the card never showed: worked out from tosu's .osu, the answer with it
    const asked = createDanSource({ analyze: async () => ({ result: { ...OK } }) });
    asked.want("ghi", 1.0, { text: async () => VIBRO_TEXT });
    await flush();
    assert.equal(asked.get("ghi|1.00").vibro.vibro, true);
});

test("profile words: the play row's note and tooltip, the count of plays left out, in both languages", () => {
    try {
        setLang("ru");
        assert.equal(t("profile.play.vibro"), "вибро — не влияет на даны");
        assert.match(t("profile.play.vibroTitle", { pct: 60 }), /^На этом рейте 60% нот карты — вибро/);
        assert.equal(t("profile.local.vibro", { n: 3 }), "вибро не учтено: 3");
        setLang("en");
        assert.equal(t("profile.play.vibro"), "vibro — doesn't move your dans");
        assert.equal(t("profile.local.vibro", { n: 3 }), "3 vibro left out");
    } finally {
        setLang("ru");
    }
});
