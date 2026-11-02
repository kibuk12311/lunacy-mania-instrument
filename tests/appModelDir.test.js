// The folder of the generator's models (appModelDir, app/generatorJobs.js): ../models/ in a checkout, the models folder
// beside app.asar in a packaged app, from the module's own URL so that every process agrees. dan_model.json is not part
// of it: that one stays inside the asar (src/core/model.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_MODEL_DIR, appModelDir, generatorInfoOf, listModelFiles, modelDirs, readAppModel } from "../app/generatorJobs.js";
import { codeFiles, stripComments } from "./helpers/source.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// the module's URL when the app runs from `dir`, and the folder expected
const urlIn = (dir) => pathToFileURL(path.join(dir, "app", "generatorJobs.js")).href;
const modelsOf = (dir) => path.join(dir, "models") + path.sep;

test("a checkout reads its own models/", () => {
    assert.equal(APP_MODEL_DIR, modelsOf(root));
    assert.deepEqual(modelDirs({ env: {} }), [APP_MODEL_DIR]);
    const checkout = path.resolve("/work/lunacy mania");
    assert.equal(appModelDir(urlIn(checkout)), modelsOf(checkout));
});

test("inside app.asar: the models folder beside the archive, whatever the install folder is called", () => {
    for (const install of ["/Programs/Lunacy mania", "/Программы/Лунная мания", "/portable/2x #1", "/backup/app.asar/Lunacy mania"]) {
        const resources = path.resolve(install, "resources");
        assert.equal(appModelDir(urlIn(path.join(resources, "app.asar"))), modelsOf(resources));
    }
});

test("a folder that only looks like the archive is a checkout", () => {
    for (const name of ["app.asar.old", "my app.asar", "app.asar.unpacked", "app.asar/checkout"]) {
        const dir = path.resolve("/work", name);
        assert.equal(appModelDir(urlIn(dir)), modelsOf(dir), name);
    }
});

test("the module's URL decides, not process.resourcesPath: under `electron .` that is Electron's own folder", () => {
    const checkout = path.resolve("/work/lunacy mania");
    const resources = path.resolve("/Programs/Lunacy mania/resources");
    process.resourcesPath = path.resolve("/work/lunacy mania/node_modules/electron/dist/resources");
    try {
        assert.equal(appModelDir(urlIn(checkout)), modelsOf(checkout));
        assert.equal(appModelDir(urlIn(path.join(resources, "app.asar"))), modelsOf(resources));
    } finally {
        delete process.resourcesPath;
    }
});

test("readAppModel: the parsed file; a model that is not there rejects, and its engine is not offered", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lunacy-app-models-"));
    await writeFile(path.join(dir, "mapper.json"), JSON.stringify({ families: ["Stream"] }));
    assert.deepEqual(await readAppModel("mapper.json", dir), { families: ["Stream"] });
    await assert.rejects(readAppModel("mapper-nn2-s.json", dir));
    const info = generatorInfoOf(await listModelFiles([dir]));
    assert.deepEqual(info.engines, ["learned", "rules"]);
    assert.equal(info.sizes.s, false);
    // no folder at all: the rule-based generator alone, nothing thrown
    assert.deepEqual(generatorInfoOf(await listModelFiles([path.join(dir, "gone")])).engines, ["rules"]);
});

test("one place decides: outside appModelDir only the dan model, which stays in the asar, names the folder", () => {
    // the folder in any spelling of a path: models/ or models\ in a string, or the segment alone
    const namesFolder = /\bmodels(?:[/\\]|["'`])/;
    for (const reader of ['new URL("../models/", url)', 'path.join(x, "models")', "path.join(x, '..', 'models', name)", 'path.resolve(x, "..\\models\\mapper.json")', "`${x}/models`"]) {
        assert.match(reader, namesFolder);
    }
    const named = codeFiles(root).filter((file) => namesFolder.test(stripComments(readFileSync(file, "utf8"))));
    assert.deepEqual(named.map((file) => path.relative(root, file).replaceAll(path.sep, "/")).sort(), [
        "app/generatorJobs.js", "src/core/analyzerVersion.js", "src/core/model.js",
    ]);
});
