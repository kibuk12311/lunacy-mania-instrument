// The create tab's markup shells for mapgen v3: containers the streams build into with JS, all inside
// <section id="create-tab">, hidden until their owner fills them, with their headers translated.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "app", "renderer", "index.html"), "utf8");
const VOID = new Set(["input", "meta", "link", "br", "img", "hr", "source"]);

// Every element with its attributes and its ancestors (nearest last), in document order.
function elements(source) {
    const out = [];
    const stack = [];
    for (const m of source.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
        const [, closing, rawTag, rawAttrs] = m;
        const tag = rawTag.toLowerCase();
        if (closing) {
            const at = stack.map((e) => e.tag).lastIndexOf(tag);
            if (at >= 0) stack.length = at;
            continue;
        }
        const attrs = Object.fromEntries([...rawAttrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? ""]));
        const el = { tag, attrs, ancestors: [...stack], index: out.length };
        out.push(el);
        if (!VOID.has(tag) && !rawAttrs.trim().endsWith("/")) stack.push(el);
    }
    return out;
}

const all = elements(html);
const byId = (id) => {
    const found = all.filter((e) => e.attrs.id === id);
    assert.equal(found.length, 1, `#${id} once`);
    return found[0];
};
const inside = (el, id) => el.ancestors.some((a) => a.attrs.id === id);
const group = (el) => [...el.ancestors].reverse().find((a) => (a.attrs.class ?? "").split(" ").includes("group"));
const label = (el) => all.find((e) => e.ancestors.includes(el) && e.attrs.class === "flabel");

test("the create tab and mapset styles are linked", () => {
    const links = all.filter((e) => e.tag === "link").map((e) => e.attrs.href);
    assert.ok(links.includes("create.css"), links.join());
    assert.ok(links.includes("export.css"), links.join());
});

test("mode chips: from a song and from an existing map", () => {
    const mode = byId("create-mode");
    assert.ok(inside(mode, "create-tab"));
    const chips = all.filter((e) => e.ancestors.at(-1) === mode);
    assert.deepEqual(chips.map((c) => [c.attrs["data-mode"], c.attrs["data-i18n"]]), [["song", "html.create.modeSong"], ["remap", "html.create.modeRemap"]]);
});

test("the song mode wraps every control the tab has today", () => {
    const song = byId("song-mode");
    assert.ok(inside(song, "create-tab"));
    for (const id of ["drop", "file", "bpm", "offset", "listen", "timing-note", "diffs", "patterns", "shares", "mix", "stamina", "burst", "generate", "gen-status", "gen-result"]) {
        assert.ok(inside(byId(id), "song-mode"), id);
    }
});

test("the timing group gets the sections table, the wave strip and the snap chips", () => {
    const timing = group(byId("bpm"));
    for (const id of ["timing-sections", "wave-strip", "snaps"]) assert.equal(group(byId(id)), timing, id);
    assert.equal(byId("wave-strip").tag, "canvas");
    assert.equal(byId("wave-strip").attrs.tabindex, "0");
});

test("the dan group holds only the difficulty list: the old from/to rows are gone", () => {
    const diffs = byId("diffs");
    assert.equal(label(group(diffs)).attrs["data-i18n"], "html.create.dan");
    for (const id of ["dan-rows", "level", "step", "level-to", "step-to"]) assert.equal(all.find((e) => e.attrs.id === id), undefined, id);
});

test("song parts and preview groups with their canvases", () => {
    const parts = byId("parts-group");
    assert.ok(inside(parts, "song-mode"));
    assert.equal(label(parts).attrs["data-i18n"], "html.create.parts");
    assert.ok(inside(byId("timeline"), "parts-group"));
    assert.equal(byId("timeline").tag, "canvas");
    assert.ok(inside(byId("part-editor"), "parts-group"));

    const preview = byId("preview");
    assert.ok(inside(preview, "song-mode"));
    assert.equal(label(preview).attrs["data-i18n"], "html.create.preview");
    assert.equal(byId("playfield").tag, "canvas");
    assert.equal(byId("playfield").attrs.tabindex, "0");
    assert.ok(inside(byId("playfield"), "preview"));
    assert.ok(inside(byId("play-controls"), "preview"));
});

test("metadata and saving come after the result", () => {
    const result = byId("gen-result");
    const meta = byId("meta-group");
    const save = byId("export-panel");
    assert.ok(meta.index > result.index && save.index > meta.index);
    assert.equal(label(meta).attrs["data-i18n"], "html.create.metadata");
    assert.equal(label(save).attrs["data-i18n"], "html.create.save");
    for (const el of [meta, save]) assert.ok(inside(el, "song-mode"));
});

test("the remap panel sits next to the song mode, hidden", () => {
    const remap = byId("remap-panel");
    assert.ok(inside(remap, "create-tab"));
    assert.ok(!inside(remap, "song-mode"));
    assert.ok("hidden" in remap.attrs);
});

test("the new shells are hidden until their stream fills them", () => {
    for (const id of ["create-mode", "timing-sections", "wave-strip", "snaps", "diffs", "parts-group", "preview", "meta-group", "export-panel", "remap-panel"]) {
        assert.ok("hidden" in byId(id).attrs, id);
    }
    // the create tab's own rule makes [hidden] win over .group { display: flex }
    const css = readFileSync(path.join(root, "app", "renderer", "create.css"), "utf8");
    assert.match(css, /#create-tab \[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
});
