// openRateAt: another tab (the analysis ladder) opens the rate tab at a given rate.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeDom } from "./helpers/fakeDom.js";
import { initRateTab, onRateTabShown, openRateAt } from "../app/renderer/rateTab.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INFO = { ok: true, mania: true, info: { artist: "A", title: "T", version: "V", od: 8, hp: 7, bpm: 180 } };

test("openRateAt sets the rate the next refresh shows and previews; later refreshes read the field again", async () => {
    const asked = [];
    let info = INFO;
    const { $ } = fakeDom({
        rateInfo: async () => info,
        // the request shape may grow ({ rate, mirror, … }); the rate is what matters here
        ratePreview: async (a) => {
            asked.push(typeof a === "number" ? a : a.rate);
            return { kind: "ok", label: "Gamma mid", numeric: 13, primary: "Jumpstream" };
        },
        rateCreate: async () => ({ ok: true, version: "x" }),
    });
    $("rate-value").value = "1.1";
    initRateTab();

    openRateAt(1.25);
    await onRateTabShown();
    assert.equal($("rate-value").value, "1.25");
    assert.equal($("rate-slider").value, "1.25");
    await sleep(300);
    assert.deepEqual(asked, [1.25]);

    $("rate-value").value = "1.4";
    await onRateTabShown();
    await sleep(300);
    assert.deepEqual(asked, [1.25, 1.4]);

    // out of range or not a number: ignored
    openRateAt(3);
    openRateAt("1.3");
    await onRateTabShown();
    assert.equal($("rate-value").value, "1.4");

    // no map in osu!: the rate is still set, for when one is picked
    info = { ok: false, message: "osu! is closed" };
    openRateAt(0.9);
    await onRateTabShown();
    assert.equal($("rate-value").value, "0.9");
    info = INFO;
    await onRateTabShown();
    assert.equal($("rate-value").value, "0.9");
    await sleep(300);
    assert.equal(asked.at(-1), 0.9);
});
