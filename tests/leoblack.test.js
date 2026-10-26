import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeChart } from "./fixtures/makeChart.js";
import {
    runSunnyEstimatorFromText,
    runDanielEstimatorFromText,
    analyzeEtternaFromText,
    analyzePatternFromText,
    classifyCompanellaDifficulty,
    calculateInterludeStar,
} from "../src/core/leoblack.js";

test("all estimators run on synthetic 4K stream", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "дан тест "));
    const file = path.join(dir, "stream.osu");
    await writeFile(file, makeChart({ kind: "stream", bpm: 180, seconds: 90 }), "utf8");
    const text = await readFile(file, "utf8");

    const sunny = runSunnyEstimatorFromText(text, { speedRate: 1 });
    assert.ok(sunny.star > 0);

    const daniel = runDanielEstimatorFromText(text, { speedRate: 1 });
    assert.equal(Number(daniel.columnCount), 4);

    const ett = await analyzeEtternaFromText(text, { musicRate: 1 });
    assert.equal(typeof ett.values.Overall, "number");
    assert.equal(typeof ett.values.Technical, "number");

    const patterns = analyzePatternFromText(text);
    assert.ok(patterns.report.Clusters.length > 0);

    const interludeStar = await calculateInterludeStar(text, 1);
    const companella = await classifyCompanellaDifficulty({
        msdValues: ett.values,
        interludeStar,
        sunnyStar: sunny.star,
    });
    assert.ok(Number.isFinite(companella.numericDifficulty));
});

test("pattern instances come straight from find(), with their times", async () => {
    const { findPatterns, parseOsuManiaFromText } = await import("../src/core/leoblack.js");
    const chart = parseOsuManiaFromText(makeChart({ kind: "jumpstream", bpm: 180, seconds: 30 }));
    assert.equal(chart.Keys, 4);
    const instances = findPatterns(chart);
    assert.ok(instances.length > 0);
    for (const inst of instances) assert.ok(inst.Start < inst.End, JSON.stringify(inst));
    assert.ok(instances.some((inst) => inst.Pattern === "Chordstream" && inst.SpecificType === "Jumpstream"));
});
