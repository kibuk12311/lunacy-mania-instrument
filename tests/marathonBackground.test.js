import test from "node:test";
import assert from "node:assert/strict";
import { backgroundHtml } from "../src/rate/backgroundHtml.js";

test("background lists the marathon title and every map with rate and dan", () => {
    const html = backgroundHtml({
        title: "Gamma Dan",
        subtitle: "4K марафон · Beta mid — Delta low",
        items: [{ label: "Art - First [Hard]", dan: "Beta mid" }, { label: "Art - Second [Insane] 1.2x", dan: "Delta low" }],
    });
    assert.ok(html.includes("Gamma Dan"));
    assert.ok(html.includes("4K марафон"));
    assert.ok(html.includes("Art - Second [Insane] 1.2x"));
    assert.ok(html.includes("Delta low"));
    assert.ok(html.indexOf("First") < html.indexOf("Second"));
});

test("map names cannot inject markup", () => {
    const html = backgroundHtml({ title: "<script>x</script>", subtitle: "", items: [{ label: "a <b>bold</b>", dan: "" }] });
    assert.ok(!html.includes("<script>x"));
    assert.ok(!html.includes("<b>bold"));
});

test("an image behind the text is optional", () => {
    assert.ok(backgroundHtml({ title: "T", subtitle: "", items: [], imageDataUrl: "data:image/png;base64,AAAA" }).includes("data:image/png;base64,AAAA"));
    assert.ok(!backgroundHtml({ title: "T", subtitle: "", items: [] }).includes("data:image"));
});

test("the difficulty curve goes under the map list when given, and nothing is there without it", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/></svg>';
    const html = backgroundHtml({ title: "T", subtitle: "", items: [{ label: "Map one", dan: "Gamma mid" }], curveSvg: svg });
    assert.ok(html.includes(svg));
    assert.ok(html.indexOf("Map one") < html.indexOf("<svg"));
    assert.ok(!backgroundHtml({ title: "T", subtitle: "", items: [] }).includes("<svg"));
    assert.ok(!backgroundHtml({ title: "T", subtitle: "", items: [], curveSvg: "" }).includes('class="curve"'));
});
