// The mapper styles of the model files (app/modelStyles.js, 0.9.5): only the "styles" array is read, wherever it sits
// in the file (the 118 MB XGBoost v3 keeps it near the end, past many 1 MB chunks); each file is scanned once and
// then comes from userData\model-styles.json until its size or change time differs; per picker choice the list of
// the file the worker would load, named (src/gen/styleNames.js) and sorted.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanStyles, createStyleCatalog } from "../app/modelStyles.js";
import { displayStyles, namesFrom } from "../src/gen/styleNames.js";

const STYLES = [{ key: "n:a]b", name: "A]b \"q\" {x}", maps: 3 }, { key: "u:7", name: "u:7", maps: 9 }];
const tmp = () => mkdtemp(path.join(tmpdir(), "model-styles-"));

test("scanStyles: the array near the start, past several 1 MB chunks, split across a chunk edge, with brackets and quotes in names", async () => {
    const dir = await tmp();
    const small = path.join(dir, "small.json");
    await writeFile(small, JSON.stringify({ kind: "nn-v2", styles: STYLES, weights: { w: [1, 2, 3] } }));
    assert.deepEqual(await scanStyles(small), STYLES);
    // the key itself cut by the 1 MB chunk edge, at several offsets
    for (const cut of [1, 4, 8, 9, 11]) {
        const pad = "x".repeat((1 << 20) - '{"pad":"'.length - '",'.length - cut);
        const file = path.join(dir, `edge-${cut}.json`);
        await writeFile(file, `{"pad":"${pad}", "styles" :\n [${STYLES.map((s) => JSON.stringify(s)).join(",")}], "tail": 1}`);
        assert.deepEqual(await scanStyles(file), STYLES, `cut ${cut}`);
    }
    const far = path.join(dir, "far.json");
    await writeFile(far, JSON.stringify({ pattern: "y".repeat(3.5 * (1 << 20)), styles: STYLES }));
    assert.deepEqual(await scanStyles(far), STYLES);
});

test("scanStyles: no styles, \"styles\" as a value, a styles object or a broken array give [] or the real array", async () => {
    const dir = await tmp();
    const write = async (name, text) => { const f = path.join(dir, name); await writeFile(f, text); return f; };
    assert.deepEqual(await scanStyles(await write("none.json", JSON.stringify({ kind: "xgb-v1", pattern: { a: 1 } }))), []);
    assert.deepEqual(await scanStyles(await write("value.json", JSON.stringify({ note: "styles", other: ["styles"], styles: STYLES }))), STYLES);
    assert.deepEqual(await scanStyles(await write("object.json", '{"styles": {"a": 1}, "x": 2}')), []);
    assert.deepEqual(await scanStyles(await write("broken.json", '{"styles": [{"key": "a", }]}')), []);
    assert.deepEqual(await scanStyles(await write("open.json", '{"styles": [{"key": "a"}')), []);
    // entries without a key are dropped
    assert.deepEqual(await scanStyles(await write("keys.json", '{"styles": [{"name": "x"}, {"key": "k", "maps": "4"}]}')), [{ key: "k", name: null, maps: 4 }]);
});

test("the catalog scans a file once, then reads the cache in userData until the file changes", async () => {
    const dir = await tmp();
    const cacheFile = path.join(await tmp(), "model-styles.json");
    const model = path.join(dir, "mapper-xgb3.json");
    await writeFile(model, JSON.stringify({ kind: "xgb-v3", styles: STYLES }));
    const scanned = [];
    const counting = (file) => { scanned.push(file); return scanStyles(file); };
    const one = createStyleCatalog({ dirs: [dir], cacheFile, scan: counting });
    assert.deepEqual(await one.forFile("mapper-xgb3.json"), STYLES);
    assert.deepEqual(await one.forFile("mapper-xgb3.json"), STYLES);
    assert.equal(scanned.length, 1, "kept in memory");
    const cached = JSON.parse(await readFile(cacheFile, "utf8"));
    assert.equal(cached.files[model].size, (await stat(model)).size);
    // the next start: from the cache, nothing scanned
    const two = createStyleCatalog({ dirs: [dir], cacheFile, scan: async () => { throw new Error("scanned"); } });
    assert.deepEqual(await two.forFile("mapper-xgb3.json"), STYLES);
    // the file changed: scanned again
    await writeFile(model, JSON.stringify({ kind: "xgb-v3", styles: STYLES.slice(0, 1) }));
    const later = new Date(Date.now() + 5000);
    await utimes(model, later, later);
    const three = createStyleCatalog({ dirs: [dir], cacheFile, scan: counting });
    assert.deepEqual(await three.forFile("mapper-xgb3.json"), STYLES.slice(0, 1));
    assert.equal(scanned.length, 2);
    // a missing file has no styles; a broken cache file is the same as none
    assert.deepEqual(await three.forFile("mapper-nn2-m.json"), []);
    await writeFile(cacheFile, "{broken");
    assert.deepEqual(await createStyleCatalog({ dirs: [dir], cacheFile, scan: counting }).forFile("mapper-xgb3.json"), STYLES.slice(0, 1));
});

test("bySize: each choice gets the file the worker would load (dev folders first), the nn-v2 names come from XGBoost v3", async () => {
    const dev = await tmp();
    const app = await tmp();
    const xgb = [{ key: "n:magikarp1234", name: "Magikarp1234", maps: 288 }, { key: "u:13747903", name: "[Crz]hinako1804", maps: 230 }, { key: "u:9", name: "u:9", maps: 5 }];
    const nn = xgb.map((s) => ({ ...s, name: s.key }));
    await writeFile(path.join(app, "mapper.json"), JSON.stringify({ pattern: {} }));
    await writeFile(path.join(app, "mapper-xgb3.json"), JSON.stringify({ kind: "xgb-v3", styles: xgb }));
    await writeFile(path.join(app, "mapper-nn2-s.json"), JSON.stringify({ kind: "nn-v2", styles: nn }));
    await writeFile(path.join(dev, "mapper-nn2-m.json"), JSON.stringify({ kind: "nn-v2", styles: nn.slice(0, 1) }));
    await writeFile(path.join(app, "mapper-nn2-m.json"), JSON.stringify({ kind: "nn-v2", styles: nn }));
    const catalog = createStyleCatalog({ dirs: [dev, app] });
    const by = await catalog.bySize(["mapper-nn2-m.json", "mapper-nn2-s.json", "mapper-xgb3.json", "mapper.json"]);
    assert.deepEqual(Object.keys(by), ["auto", "xgb3", "s", "m", "l"]);
    assert.deepEqual(by.auto, []);
    const named = [
        { key: "n:magikarp1234", name: "Magikarp1234", user: null, maps: 288 },
        { key: "u:13747903", name: "[Crz]hinako1804", user: null, maps: 230 },
        { key: "u:9", name: null, user: "9", maps: 5 },
    ];
    assert.deepEqual(by.xgb3, named);
    assert.deepEqual(by.s, named, "the nn-v2 keys named from XGBoost v3");
    assert.deepEqual(by.m, named.slice(0, 1), "the dev folder's M comes first, as in the worker");
    assert.deepEqual(by.l, named.slice(0, 1), "no L file: the worker runs M");
    // without XGBoost v3 the classic model runs for it: no styles; the nn names lose their n:
    const noXgb = await createStyleCatalog({ dirs: [app] }).bySize(["mapper-nn2-s.json", "mapper.json"]);
    assert.deepEqual(noXgb.xgb3, []);
    assert.deepEqual(noXgb.s.map((s) => [s.name, s.user]), [["magikarp1234", null], [null, "13747903"], [null, "9"]]);
});

test("styleNames: real names win, then names from other lists, then the key without n:; u:<id> → user; most maps first", () => {
    const names = namesFrom([[{ key: "n:x", name: "X" }, { key: "u:1", name: "u:1" }], [{ key: "u:2", name: "Two" }], null]);
    assert.deepEqual([...names], [["n:x", "X"], ["u:2", "Two"]]);
    const list = displayStyles([
        { key: "n:x", name: "n:x", maps: 4 }, { key: "u:1", maps: 7 }, { key: "u:2", name: "", maps: 7 }, { key: "plain", maps: 1 },
        { key: "n:x", maps: 99 }, { name: "no key" }, null, { key: "n:own", name: " Own ", maps: 2 },
    ], names);
    assert.deepEqual(list, [
        { key: "u:1", name: null, user: "1", maps: 7 },
        { key: "u:2", name: "Two", user: null, maps: 7 },
        { key: "n:x", name: "X", user: null, maps: 4 },
        { key: "n:own", name: "Own", user: null, maps: 2 },
        { key: "plain", name: "plain", user: null, maps: 1 },
    ]);
    assert.deepEqual(displayStyles(list, names), list, "showing them again changes nothing");
});
