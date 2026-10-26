// Metadata of a generated map (mapgen v3, stream C): set in place, idempotent, every other line untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { applyMeta, readMeta, setVersion, setField, addTag, GENERATED_TAG, OLD_GENERATED_TAGS } from "../../src/gen/osuMeta.js";
import { toOsu } from "../../src/gen/writer.js";

const generated = () => toOsu({
    rows: [{ t: 1000, cols: [0] }, { t: 1250, cols: [1, 3] }],
    bpm: 120, offsetMs: 1000, title: "Song", version: "Gamma mid Jumpstream", audioFilename: "audio.mp3", previewMs: 4000,
});
const lines = (text) => text.split(/\r?\n/);
const count = (text, re) => lines(text).filter((l) => re.test(l)).length;

test("sets title, artist, creator, source, tags and the preview point, both title and artist fields", () => {
    const out = applyMeta(generated(), { title: "New title", artist: "Some Artist", creator: "me", source: "game", tags: "fast stream", previewMs: 61234.4 });
    const meta = readMeta(out);
    assert.equal(meta.title, "New title");
    assert.equal(meta.titleUnicode, "New title");
    assert.equal(meta.artist, "Some Artist");
    assert.equal(meta.artistUnicode, "Some Artist");
    assert.equal(meta.creator, "me");
    assert.equal(meta.source, "game");
    assert.equal(meta.tags, `${GENERATED_TAG} fast stream`);
    assert.equal(meta.previewMs, 61234);
    assert.equal(meta.version, "Gamma mid Jumpstream");
    assert.ok(out.includes("\r\nPreviewTime: 61234\r\n"), "General keeps its 'Key: value' style");
    assert.ok(out.includes("\r\nTitle:New title\r\n"), "Metadata keeps its 'Key:value' style");
});

test("line breaks inside values are stripped, so a value can never add a line", () => {
    const out = applyMeta(generated(), { title: "a\r\nb", artist: "x\ny", tags: "t1\r\n[HitObjects]", source: "s\rq", creator: "c\n" });
    const meta = readMeta(out);
    assert.equal(meta.title, "a b");
    assert.equal(meta.artist, "x y");
    assert.equal(meta.source, "s q");
    assert.equal(meta.creator, "c");
    assert.equal(count(out, /^\[HitObjects\]$/), 1);
    assert.equal(lines(out).length, lines(generated()).length);
});

test("empty title, artist or creator keep the map's own; empty source and tags clear them", () => {
    const first = applyMeta(generated(), { title: "T", artist: "A", creator: "C", source: "S", tags: "x" });
    const out = applyMeta(first, { title: "", artist: " ", creator: "", source: "", tags: "" });
    const meta = readMeta(out);
    assert.deepEqual([meta.title, meta.artist, meta.creator, meta.source, meta.tags], ["T", "A", "C", "", GENERATED_TAG]);
    // undefined leaves a field alone
    assert.equal(readMeta(applyMeta(first, {})).tags, `${GENERATED_TAG} x`);
});

test("the user's tags always keep 'lunacy-mania generated', once", () => {
    assert.equal(GENERATED_TAG, "lunacy-mania generated");
    assert.equal(readMeta(applyMeta(generated(), { tags: "lunacy-mania generated   rice  " })).tags, GENERATED_TAG + " rice");
    assert.equal(readMeta(applyMeta(generated(), { tags: "jumpstream" })).tags, `${GENERATED_TAG} jumpstream`);
});

test("a map from before the rename: its 'dan-analyzer generated' is taken as ours and becomes the new tag", () => {
    assert.deepEqual(OLD_GENERATED_TAGS, ["dan-analyzer generated"]);
    const old = generated().replace(/^Tags:.*$/m, "Tags:dan-analyzer generated rice");
    assert.equal(readMeta(applyMeta(old, { tags: readMeta(old).tags })).tags, `${GENERATED_TAG} rice`);
    assert.equal(readMeta(applyMeta(generated(), { tags: "rice dan-analyzer generated lunacy-mania generated" })).tags,
        `${GENERATED_TAG} rice`);
});

test("the background line is inserted after //Background and Video events, and applying twice leaves one", () => {
    const once = applyMeta(generated(), { background: "bg.png" });
    const twice = applyMeta(once, { background: "bg.jpg" });
    assert.equal(count(twice, /^0,0,"/), 1);
    const at = lines(twice).indexOf("//Background and Video events");
    assert.equal(lines(twice)[at + 1], '0,0,"bg.jpg",0,0');
    assert.equal(readMeta(twice).background, "bg.jpg");
    assert.equal(count(applyMeta(twice, { background: null }), /^0,0,"/), 0, "null takes the background out");
    assert.equal(readMeta(applyMeta(twice, {})).background, "bg.jpg", "undefined leaves it");
});

test("a map without the events comment still gets its background under [Events]", () => {
    const text = generated().replace("//Background and Video events\r\n", "");
    const out = applyMeta(text, { background: "bg.png" });
    assert.equal(lines(out)[lines(out).indexOf("[Events]") + 1], '0,0,"bg.png",0,0');
});

test("applying the same metadata twice changes nothing", () => {
    const meta = { title: "T", artist: "A", creator: "C", source: "S", tags: "a b", previewMs: 1500, background: "bg.png" };
    const once = applyMeta(generated(), meta);
    assert.equal(applyMeta(once, meta), once);
});

test("only the metadata, preview and background lines change; LF files stay LF", () => {
    const before = generated();
    const after = applyMeta(before, { title: "T", previewMs: 1, background: "bg.png" });
    const a = lines(before);
    const b = lines(after).filter((l) => l !== '0,0,"bg.png",0,0');
    assert.equal(a.length, b.length);
    const changed = a.filter((l, i) => l !== b[i]);
    assert.deepEqual(changed, ["PreviewTime: 4000", "Title:Song", "TitleUnicode:Song"]);
    const lf = applyMeta(before.replaceAll("\r\n", "\n"), { title: "T" });
    assert.ok(!lf.includes("\r"));
});

test("missing metadata keys are added inside [Metadata]", () => {
    const text = generated().replace("Source:\r\n", "").replace("TitleUnicode:Song\r\n", "");
    const out = applyMeta(text, { title: "T", source: "S" });
    const all = lines(out);
    const start = all.indexOf("[Metadata]");
    const end = all.indexOf("[Difficulty]");
    const inside = all.slice(start, end);
    assert.ok(inside.includes("Source:S"));
    assert.ok(inside.includes("TitleUnicode:T"));
});

test("setVersion, setField and addTag", () => {
    let text = setVersion(generated(), "Delta low · Gamma mid 1.2x\n");
    assert.equal(readMeta(text).version, "Delta low · Gamma mid 1.2x");
    text = setField(text, "Metadata", "BeatmapID", "0");
    assert.equal(count(text, /^BeatmapID:0$/), 1);
    text = addTag(addTag(text, "lunacy-mania-remap"), "lunacy-mania-remap");
    assert.equal(readMeta(text).tags, `${GENERATED_TAG} lunacy-mania-remap`);
});
