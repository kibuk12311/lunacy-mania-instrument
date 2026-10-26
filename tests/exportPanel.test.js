// The create tab's metadata and saving panels (mapgen v3, stream C), driven through the fake DOM: fields filled from
// the song's tags only where empty, the preview point picked on load, rate versions, and one export-set per save.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom, fire, textOf } from "./helpers/fakeDom.js";
import { initExportPanel, formatPreview, parsePreview, ratesFrom, saveLabel } from "../app/renderer/exportPanel.js";
import { setLang, t } from "../src/i18n/i18n.js";

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const find = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children ?? []) {
        const hit = find(child, id);
        if (hit) return hit;
    }
    return null;
};

// a 120 s song whose loudest stretch is 60–75 s, one bar every 2000 ms from 500
function song(path = "C:/songs/My Band - My Song.mp3") {
    const n = 12000;
    const energy = Float32Array.from({ length: n }, (_, f) => (f >= 6000 && f < 7500 ? 1 : 0.1));
    return {
        path, title: "My Band - My Song", durationMs: 120000,
        envelope: { values: new Float32Array(n), energy, hopSec: 0.01, frameTimeSec: (f) => f * 0.01 },
        timing: { sections: [{ timeMs: 500, bpm: 120, meter: 4 }], bpm: 120, offsetMs: 500 },
        parts: [],
    };
}
const diff = (id, version, rate = null) => ({ id, version, range: { lo: 12.5, hi: 13.5 }, result: { kind: "ok", label: version.split(" ").slice(0, 2).join(" "), numeric: 13 }, reachable: true, ...(rate ? { rate } : {}) });

function setup({ tags = { ok: true, artist: "Tag Artist", title: "Tag Title" }, diffs = [diff("a", "Gamma mid Jumpstream")], player = null } = {}) {
    const calls = { exportSet: [], open: [], show: [], tags: [], play: [] };
    let answer = (req) => ({ ok: true, file: `C:/maps/save${calls.exportSet.length}.osz`, entries: req.ids.map((id) => ({ version: id, label: "Gamma mid", numeric: 13.04, rate: 1 })) });
    const dom = fakeDom({
        songTags: async (p) => { calls.tags.push(p); return tags; },
        exportSet: async (req) => { calls.exportSet.push(req); return answer(req); },
        openMap: async (file) => { calls.open.push(file); },
        showMap: (file) => { calls.show.push(file); },
        pathForFile: () => "C:/pics/cover.png",
    });
    const selection = { song: song(), diffs };
    // as in the markup: both groups stay out of sight until a song is there
    dom.$("meta-group").hidden = true;
    dom.$("export-panel").hidden = true;
    const panel = initExportPanel({
        root: dom.$("export-panel"), metaRoot: dom.$("meta-group"),
        player: player ?? { playFrom: (start, seconds) => calls.play.push([start, seconds]) },
        getSelection: () => selection,
    });
    const el = (id) => find(dom.$("meta-group"), id) ?? find(dom.$("export-panel"), id);
    return { dom, panel, calls, selection, el, setAnswer: (fn) => { answer = fn; } };
}

test("preview times read and write as minutes:seconds", () => {
    assert.equal(formatPreview(83500), "1:23.5");
    assert.equal(formatPreview(60000), "1:00.0");
    assert.equal(formatPreview(5049), "0:05.0");
    assert.deepEqual(["1:23.5", "83.5", "1:23", "83", " 0:05,25 ", "2:00"].map(parsePreview), [83500, 83500, 83000, 83000, 5250, 120000]);
    assert.deepEqual(["", "abc", "-1", "1:75", "1:2:3"].map(parsePreview), [null, null, null, null, null]);
});

test("rate versions: the ticked ones plus a valid custom one, never 1.0, in order", () => {
    assert.deepEqual(ratesFrom({ picked: [1.2, 1.1], custom: "" }), { rates: [1.1, 1.2], bad: false });
    assert.deepEqual(ratesFrom({ picked: [1.1], custom: "1.35" }), { rates: [1.1, 1.35], bad: false });
    assert.deepEqual(ratesFrom({ picked: [1.1], custom: "1,1" }), { rates: [1.1], bad: false });
    assert.deepEqual(ratesFrom({ picked: [], custom: "0.8" }), { rates: [0.8], bad: false });
    for (const custom of ["1", "2.5", "x", "0.4"]) assert.deepEqual(ratesFrom({ picked: [1.2], custom }), { rates: [1.2], bad: true }, custom);
});

test("the save button counts every difficulty the file will hold", () => {
    assert.equal(saveLabel(1, 0), t("create.save.one"));
    assert.equal(saveLabel(1, 1), t("create.save.set", { n: 2 }));
    assert.equal(saveLabel(3, 2), t("create.save.set", { n: 9 }));
});

test("loading a song fills the title, then the song's own tags where still empty, and picks the preview point", async () => {
    const { panel, el, calls, dom } = setup();
    assert.equal(dom.$("meta-group").hidden, true);
    el("exp-meta-creator").value = "me";
    await fire(el("exp-meta-creator"), "input");
    panel.onSongLoaded(song());
    assert.equal(dom.$("meta-group").hidden, false);
    assert.equal(dom.$("export-panel").hidden, false);
    assert.equal(el("exp-meta-title").value, "My Band - My Song");
    await nextTick();
    assert.deepEqual(calls.tags, ["C:/songs/My Band - My Song.mp3"]);
    assert.equal(el("exp-meta-title").value, "Tag Title", "the file name gives way to the tags");
    assert.equal(el("exp-meta-artist").value, "Tag Artist");
    assert.equal(el("exp-meta-creator").value, "me");
    assert.equal(el("exp-meta-note").textContent, t("create.meta.fromTags"));
    const preview = parsePreview(el("exp-preview").value);
    assert.ok(preview <= 60000 && preview > 58000, el("exp-preview").value);
    assert.equal(el("exp-preview-note").textContent, t("create.previewAt.auto"));
});

test("a field the user typed in keeps its text when the tags arrive, and a new song clears only what was filled in", async () => {
    const { panel, el } = setup();
    el("exp-meta-artist").value = "Typed";
    await fire(el("exp-meta-artist"), "input");
    panel.onSongLoaded(song());
    await nextTick();
    assert.equal(el("exp-meta-artist").value, "Typed");
    assert.equal(el("exp-meta-title").value, "Tag Title");
    panel.onSongLoaded({ ...song("C:/songs/other.mp3"), title: "other" });
    assert.equal(el("exp-meta-title").value, "other");
    assert.equal(el("exp-meta-artist").value, "Typed");
});

test("one difficulty without rates: «Сохранить .osz» sends ids and settings, then shows the file and the links", async () => {
    const { panel, el, calls } = setup({ tags: { ok: false, message: "no ffmpeg" } });
    panel.onSongLoaded(song());
    await nextTick();
    panel.onSelectionChanged();
    assert.equal(el("exp-save").textContent, t("create.save.one"));
    assert.equal(el("exp-ai-note").textContent, t("create.save.aiNote"), "the save box says AI maps are for practice");
    await fire(el("exp-save"));
    assert.equal(calls.exportSet.length, 1);
    const req = calls.exportSet[0];
    assert.deepEqual(req.ids, ["a"]);
    assert.deepEqual(req.meta, { title: "My Band - My Song", artist: "", creator: "", source: "", tags: "" });
    assert.ok(req.previewMs <= 60000 && req.previewMs > 58000);
    assert.deepEqual([req.background, req.rates, req.pitch], [{ mode: "none" }, [], false]);
    assert.ok(textOf(el("exp-result")).includes(t("create.save.done", { file: "C:/maps/save1.osz" })));
    await fire(el("exp-show"));
    assert.deepEqual(calls.show, ["C:/maps/save1.osz"]);
});

test("a ladder with rate versions saves one set and lists the rated dans", async () => {
    const { panel, el, calls, setAnswer } = setup({ diffs: [diff("a", "Beta mid Stream"), diff("b", "Gamma mid Stream"), diff("c", "Delta mid Stream")] });
    panel.onSongLoaded(song());
    panel.onSelectionChanged();
    el("exp-rate-1.1").checked = true;
    await fire(el("exp-rate-1.1"), "change");
    el("exp-rate-custom").value = "1.35";
    await fire(el("exp-rate-custom"), "input");
    el("exp-nightcore").checked = true;
    await fire(el("exp-nightcore"), "change");
    assert.equal(el("exp-save").textContent, t("create.save.set", { n: 9 }));
    setAnswer(() => ({ ok: true, file: "C:/maps/set.osz", entries: [
        { version: "Beta mid Stream", label: "Beta mid", numeric: 12.04, rate: 1 },
        { version: "Gamma low · Beta mid Stream 1.1x NC", label: "Gamma low", numeric: 12.61, rate: 1.1 },
        { version: "Delta low · Beta mid Stream 1.35x NC", label: "Delta low", numeric: 13.66, rate: 1.35 },
    ] }));
    await fire(el("exp-save"));
    const req = calls.exportSet[0];
    assert.deepEqual(req.ids, ["a", "b", "c"]);
    assert.deepEqual(req.rates, [1.1, 1.35]);
    assert.equal(req.pitch, true);
    const shown = textOf(el("exp-result"));
    assert.ok(shown.includes(t("create.save.rateRow", { rate: "1.1", label: "Gamma low", numeric: "12.6" })), shown);
    assert.ok(shown.includes(t("create.save.rateRow", { rate: "1.35", label: "Delta low", numeric: "13.7" })), shown);
});

test("«Открыть в osu!» saves first when anything changed since the last save", async () => {
    const { panel, el, calls, selection } = setup();
    panel.onSongLoaded(song());
    await nextTick(); // the tags are in
    panel.onSelectionChanged();
    await fire(el("exp-save"));
    await fire(el("exp-open"));
    assert.equal(calls.exportSet.length, 1, "nothing changed: open the saved file");
    assert.deepEqual(calls.open, ["C:/maps/save1.osz"]);
    selection.diffs = [diff("z", "Gamma high Stream")];
    panel.onSelectionChanged();
    await fire(el("exp-open"));
    assert.equal(calls.exportSet.length, 2);
    assert.deepEqual(calls.exportSet[1].ids, ["z"]);
    assert.deepEqual(calls.open, ["C:/maps/save1.osz", "C:/maps/save2.osz"]);
    el("exp-meta-tags").value = "new tags";
    await fire(el("exp-meta-tags"), "input");
    await fire(el("exp-open"));
    assert.equal(calls.exportSet.length, 3, "a changed tag is a change too");
});

test("nothing to save, a bad preview time, a bad custom rate and a refused save are told in the status line", async () => {
    const { panel, el, calls, selection, setAnswer } = setup();
    selection.diffs = [];
    panel.onSongLoaded(song());
    panel.onSelectionChanged();
    assert.equal(el("exp-save").disabled, true);
    await fire(el("exp-save"));
    assert.equal(el("exp-status").textContent, t("create.save.nothing"));
    selection.diffs = [diff("a", "Gamma mid Stream")];
    panel.onSelectionChanged();
    el("exp-preview").value = "soon";
    await fire(el("exp-preview"), "input");
    await fire(el("exp-save"));
    assert.equal(el("exp-status").textContent, t("create.previewAt.hint"));
    el("exp-preview").value = "1:05.5";
    await fire(el("exp-preview"), "input");
    assert.equal(el("exp-preview-note").textContent, t("create.previewAt.manual"));
    el("exp-rate-custom").value = "1";
    await fire(el("exp-rate-custom"), "input");
    await fire(el("exp-save"));
    assert.equal(el("exp-status").textContent, t("app.export.badRate"));
    el("exp-rate-custom").value = "";
    await fire(el("exp-rate-custom"), "input");
    setAnswer(() => ({ ok: false, message: "disk full" }));
    await fire(el("exp-save"));
    assert.equal(el("exp-status").textContent, t("create.save.failed", { message: "disk full" }));
    assert.equal(calls.exportSet.at(-1).previewMs, 65500);
    panel.onSongLoaded(song());
    assert.equal(el("exp-preview").value, "1:05.5", "the same song again keeps a preview set by hand");
});

test("backgrounds: the image mode needs a picture; picking one switches to it and sends its path", async () => {
    const { panel, el, calls } = setup();
    panel.onSongLoaded(song());
    panel.onSelectionChanged();
    const chip = (mode) => el("exp-bg").children.find((c) => c.dataset.mode === mode);
    await fire(chip("image"));
    await fire(el("exp-save"));
    assert.equal(el("exp-status").textContent, t("create.bg.needImage"));
    assert.equal(calls.exportSet.length, 0);
    await fire(el("exp-bg-file"), "change", { target: { files: [{ name: "cover.png", size: 1000 }] } });
    await fire(el("exp-save"));
    assert.deepEqual(calls.exportSet[0].background, { mode: "image", imagePath: "C:/pics/cover.png" });
    await fire(chip("danCourse"));
    await fire(el("exp-save"));
    assert.deepEqual(calls.exportSet[1].background, { mode: "danCourse", imagePath: "C:/pics/cover.png" });
    await fire(chip("none"));
    await fire(el("exp-save"));
    assert.deepEqual(calls.exportSet[2].background, { mode: "none" });
    await fire(el("exp-bg-file"), "change", { target: { files: [{ name: "cover.gif", size: 1000 }] } });
    assert.equal(el("exp-status").textContent, t("app.export.badImage"));
});

test("«▶ послушать превью» plays 10 s from the preview point", async () => {
    const { panel, el, calls } = setup();
    panel.onSongLoaded(song());
    el("exp-preview").value = "1:05.5";
    await fire(el("exp-preview"), "input");
    await fire(el("exp-listen"));
    assert.deepEqual(calls.play, [[65.5, 10]]);
});

test("the panels speak English when the language is English", async () => {
    setLang("en");
    try {
        const { panel, el, dom } = setup({ diffs: [diff("a", "Gamma mid Stream"), diff("b", "Delta mid Stream")] });
        panel.onSongLoaded(song());
        panel.onSelectionChanged();
        const all = `${textOf(dom.$("meta-group"))} | ${textOf(dom.$("export-panel"))}`;
        for (const text of ["Artist", "Title", "Creator", "Source", "Tags", "No background", "Dan-course style", "pick an image", "Preview",
            "▶ listen to the preview", "Rate versions", "custom", "Nightcore (changes pitch)", "Save the mapset .osz (2)"]) {
            assert.ok(all.includes(text), text);
        }
        assert.ok(!/[А-Яа-яЁё]/.test(all), all);
        assert.equal(el("exp-preview").title, "Minutes:seconds, for example 1:23.5");
    } finally {
        setLang("ru");
    }
});
