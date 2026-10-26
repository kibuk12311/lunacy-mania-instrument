import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { noteProbability, sizeProbabilities } from "../../src/gen/learnedModel.js";

const model = await readFile(new URL("../../models/mapper.json", import.meta.url), "utf8").then(JSON.parse).catch(() => null);

test("JS evaluation of the trained mapper matches XGBoost", { skip: !model && "models/mapper.json not trained yet" }, () => {
    const { x, noteP, sizeP } = model.parity;
    x.forEach((row, i) => {
        assert.ok(Math.abs(noteProbability(model.note, row) - noteP[i]) < 1e-3, `note ${i}`);
        sizeProbabilities(model.size, row).forEach((p, k) => assert.ok(Math.abs(p - sizeP[i][k]) < 1e-3, `size ${i}/${k}`));
    });
});
