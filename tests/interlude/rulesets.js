// Rulesets for the tests, made the way Prelude makes its built-in ones (prelude/src/Gameplay/Rulesets: osu!mania.fs,
// Wife3.fs, Quaver.fs; MIT), float32 as there, as .ruleset JSON for parseRuleset.
import { parseRuleset } from "../../src/interlude/ruleset.js";

const f = Math.fround;
const COLOURS = [[255, 0, 255, 255], [255, 255, 255, 0], [255, 0, 255, 100], [255, 0, 160, 255], [255, 160, 160, 160], [255, 255, 80, 80]];

// [[early, late] | null, breaksCombo] per judgement → the Judgements of a ruleset's JSON.
export const judgementsJson = (list) => list.map(([windows, breaksCombo], i) => ({
    Name: `J${i}`, Color: COLOURS[i % COLOURS.length], BreaksCombo: breaksCombo, TimingWindows: windows,
}));

export const rulesetJson = ({ name = "Test", judgements, priority = "OsuMania", ghost = null, hold, accuracy, lamps = [], grades = [] }) => ({
    Name: name, Description: "", Judgements: judgementsJson(judgements), Lamps: lamps, Grades: grades,
    HitMechanics: { NotePriority: priority, GhostTapJudgement: ghost }, HoldMechanics: hold, Accuracy: accuracy, Formatting: { DecimalPlaces: "TWO" },
});

// F# round: a half to the even one
const roundEven = (x) => {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

// OsuMania.create od NoMod
export function osuJson(od0) {
    const od = f(roundEven(f(od0 * 10)) / 10);
    const fl = Math.floor;
    const raw = { perfect: 16, great: f(64 - f(3 * od)), good: f(97 - f(3 * od)), ok: f(127 - f(3 * od)), meh: f(151 - f(3 * od)), miss: f(188 - f(3 * od)) };
    const clipped = (w) => f(fl(w) + 0.5);
    const [P, G, GO, OK, ME, MI] = ["perfect", "great", "good", "ok", "meh", "miss"].map((k) => clipped(raw[k]));
    const late = f(OK - 1);
    return rulesetJson({
        name: `osu! OD${od}`,
        judgements: [[[-P, P], false], [[-G, G], false], [[-GO, GO], false], [[-OK, late], false], [[-ME, late], false], [[-MI, late], true]],
        hold: { CombineHeadAndTail: { OsuMania: {
            Window320: clipped(f(fl(raw.perfect) * f(1.2))), Window300: clipped(f(fl(raw.great) * f(1.1))), Window200: clipped(fl(raw.good)),
            Window100: clipped(fl(raw.ok)), Window50: clipped(fl(raw.meh)), Window0: clipped(fl(raw.miss)),
            WindowOverhold200: f(fl(f(43 - f(od * 3))) + 0.5), WindowOverhold100: f(fl(f(103 - f(od * 3))) + 0.5),
        } } },
        accuracy: { PointsPerJudgement: [1, 1, 2 / 3, 1 / 3, 1 / 6, 0] },
    });
}
export const osuRuleset = (od) => parseRuleset(osuJson(od));

// Wife3.create judge
export function wife3Json(judge) {
    const p = judge === 9 ? 9 : f(45 * f(f(10 - judge) / 6));
    const w = (m) => [f(-p * m), f(p * m)];
    return rulesetJson({
        name: `Wife3 J${judge}`, priority: "Etterna",
        judgements: [[w(0.5), false], [w(1), false], [w(2), false], [w(3), true], [[-180, 180], true], [null, true]],
        hold: { OnlyRequireHold: 180 }, accuracy: { WifeCurve: judge },
    });
}

// Quaver.create Standard
export function quaverJson() {
    const std = [18, 43, 76, 106, 127, 164];
    const [marv, perfect, great, , okay] = std;
    const release = (x) => [f(-x * 1.5), f(x * 1.5)];
    return rulesetJson({
        name: "Quaver", judgements: std.map((x, i) => [[-x, x], i === 5]),
        hold: { JudgeReleasesSeparately: [[release(marv), release(perfect), release(great), release(okay), null, null], 4] },
        accuracy: { PointsPerJudgement: [1, 0.9825, 0.65, 0.25, -1.0, -0.5] },
    });
}

// two judgements: hit in [-180, 90] or miss; holds only need holding for `hold` ms
export const simpleJson = (hold = 90) => rulesetJson({
    name: "SIMPLE", priority: "Etterna", judgements: [[[-180, 90], false], [null, true]], hold: { OnlyRequireHold: hold }, accuracy: { PointsPerJudgement: [1, 0] },
});
