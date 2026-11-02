// Interlude's rulesets, the .ruleset files of its Rulesets folder, re-implemented in our own JS from reading Prelude
// (github.com/YAVSRG/YAVSRG, prelude/src/Gameplay/Rulesets/Rulesets.fs, MIT): the JSON as Prelude's codec writes it,
// checked the way Ruleset.Validate checks it, the windows a note and a release can be hit in (NoteWindows,
// ReleaseWindows) and how an accuracy is written (FormatAccuracy). In the JSON a record is an object, an option null or
// its value, a union case with no fields its name, with one field { "Case": value }, with several { "Case": [values] },
// a colour [A, R, G, B]. Windows are ms of real time and float32 (System.Single) as in Prelude, so each is
// Math.fround-ed as it is read. Pure.
const f32 = Math.fround;

// The six judgements the Replay tab knows (src/replay/judge.js KINDS), which a ruleset's own are put in.
const SLOTS = Object.freeze(["max", "n300", "n200", "n100", "n50", "miss"]);
const DECIMALS = Object.freeze({ TWO: 2, THREE: 3, FOUR: 4 });
const LARGEST_WINDOW_MS = 500;
const INT32_MAX = 2147483647;

function fail(why) {
    throw new Error(`ruleset: ${why}`);
}
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x, what) => (typeof x === "string" ? x : fail(`${what} is not a text`));
const flag = (x, what) => (typeof x === "boolean" ? x : fail(`${what} is not true or false`));
const whole = (x, what) => (Number.isInteger(x) ? x : fail(`${what} is not a whole number`));
const number = (x, what) => (typeof x === "number" ? x : fail(`${what} is not a number`));
const time = (x, what) => f32(number(x, what));
const list = (x, what) => (Array.isArray(x) ? x : fail(`${what} is not a list`));
const pair = (x, what) => {
    if (!Array.isArray(x) || x.length !== 2) fail(`${what} is not a pair of numbers`);
    return [time(x[0], what), time(x[1], what)];
};
const windowsOf = (x, what) => (x === null || x === undefined ? null : pair(x, what));

// A union value → [case, its fields]: "Case" or { "Case": fields }.
function union(x, what) {
    if (typeof x === "string") return [x, undefined];
    if (isObject(x) && Object.keys(x).length === 1) {
        const [name] = Object.keys(x);
        return [name, x[name]];
    }
    return fail(`${what} is not one of its kinds`);
}
// A case's fields as a list, one field or several.
const fields = (x, count, what) => {
    if (count === 1) return [x];
    if (!Array.isArray(x) || x.length !== count) fail(`${what} needs ${count} values`);
    return x;
};

const hex = (n) => n.toString(16).padStart(2, "0");
// [A, R, G, B] (or [R, G, B]) → "#rrggbb"
function colour(x, what) {
    if (!Array.isArray(x) || (x.length !== 4 && x.length !== 3) || !x.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) {
        fail(`${what} is not a colour`);
    }
    const [r, g, b] = x.slice(-3);
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function notePriority(x) {
    const [name, value] = union(x, "HitMechanics.NotePriority");
    if (name === "OsuMania" && (value === undefined || value === null)) return Object.freeze({ kind: "osuMania" });
    if (name === "Etterna" && (value === undefined || value === null)) return Object.freeze({ kind: "etterna" });
    if (name === "Interlude" && value !== undefined) return Object.freeze({ kind: "interlude", cbrush: time(value, "Interlude's cbrush threshold") });
    return fail(`unknown note priority ${name}`);
}

const OSU_LN = ["Window320", "Window300", "Window200", "Window100", "Window50", "Window0", "WindowOverhold200", "WindowOverhold100"];

function holdMechanicsOf(x) {
    const [name, value] = union(x, "HoldMechanics");
    if (name === "CombineHeadAndTail") {
        const [rule, ruleValue] = union(value, "CombineHeadAndTail");
        if (rule === "OsuMania") {
            if (!isObject(ruleValue)) fail("the osu!mania hold windows are not a record");
            const windows = {};
            for (const key of OSU_LN) windows[key] = time(ruleValue[key], `osu!mania ln ${key}`);
            return Object.freeze({ kind: "osuMania", windows: Object.freeze(windows) });
        }
        if (rule === "HeadJudgementOr") {
            const [early, late, ifDropped, ifOverheld] = fields(ruleValue, 4, "HeadJudgementOr");
            return Object.freeze({
                kind: "headJudgementOr", early: time(early, "HeadJudgementOr early window"), late: time(late, "HeadJudgementOr late window"),
                ifDropped: whole(ifDropped, "HeadJudgementOr judgement_if_dropped"), ifOverheld: whole(ifOverheld, "HeadJudgementOr judgement_if_overheld"),
            });
        }
        return fail(`unknown head and tail rule ${rule}`);
    }
    if (name === "OnlyRequireHold") return Object.freeze({ kind: "onlyRequireHold", window: time(value, "OnlyRequireHold window") });
    if (name === "JudgeReleasesSeparately") {
        const [windows, ifOverheld] = fields(value, 2, "JudgeReleasesSeparately");
        return Object.freeze({
            kind: "judgeReleasesSeparately",
            windows: Object.freeze(list(windows, "JudgeReleasesSeparately windows").map((w) => windowsOf(w, "a release window"))),
            ifOverheld: whole(ifOverheld, "JudgeReleasesSeparately judgement_if_overheld"),
        });
    }
    if (name === "OnlyJudgeReleases") return Object.freeze({ kind: "onlyJudgeReleases", ifDropped: whole(value, "OnlyJudgeReleases judgement_if_dropped") });
    return fail(`unknown hold mechanics ${name}`);
}

function accuracyPoints(x) {
    const [name, value] = union(x, "Accuracy");
    if (name === "WifeCurve") return Object.freeze({ kind: "wifeCurve", judge: whole(value, "WifeCurve judge") });
    if (name === "PointsPerJudgement") {
        return Object.freeze({ kind: "pointsPerJudgement", points: Object.freeze(list(value, "PointsPerJudgement").map((p) => number(p, "a judgement's points"))) });
    }
    return fail(`unknown accuracy ${name}`);
}

function lampRequirement(x, what) {
    const [name, value] = union(x, `${what} requirement`);
    if (name === "ComboBreaksAtMost") return Object.freeze({ kind: "comboBreaks", count: whole(value, `${what} combo breaks`) });
    if (name === "JudgementAtMost") {
        const [judgement, count] = fields(value, 2, `${what} JudgementAtMost`);
        return Object.freeze({ kind: "judgement", judgement: whole(judgement, `${what} judgement`), count: whole(count, `${what} count`) });
    }
    return fail(`unknown lamp requirement ${name}`);
}

function decimalPlaces(x) {
    const value = x?.DecimalPlaces ?? "TWO";
    if (typeof value === "string" && DECIMALS[value]) return DECIMALS[value];
    if (Object.values(DECIMALS).includes(value)) return value;
    return fail(`Unsupported decimal places formatting: ${value}`);
}

// LampRequirement.SortKey: the stricter a lamp, the smaller.
const sortKey = (r) => (r.kind === "comboBreaks" ? [INT32_MAX, r.count] : [r.judgement, r.count]);
const stricter = (a, b) => {
    const [x, y] = [sortKey(a), sortKey(b)];
    return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
};

// Ruleset.NoteWindows: the windows of the last judgement that has some, the widest.
function noteWindowsOf(judgements) {
    for (let i = judgements.length - 1; i >= 0; i -= 1) if (judgements[i].windows) return judgements[i].windows;
    return [0, 0];
}

// Ruleset.ReleaseWindows
function releaseWindowsOf(hold, noteWindows) {
    if (hold.kind === "onlyRequireHold") return [-hold.window, hold.window];
    if (hold.kind === "judgeReleasesSeparately") {
        for (let i = hold.windows.length - 1; i >= 0; i -= 1) if (hold.windows[i]) return hold.windows[i];
        return [0, 0];
    }
    if (hold.kind === "onlyJudgeReleases") return noteWindows;
    if (hold.kind === "osuMania") return [-hold.windows.Window0, f32(hold.windows.Window100 - 1)];
    return [hold.early, hold.late];
}

// Ruleset.Validate, with its messages: what Interlude refuses to load is refused here too.
function validate(r) {
    const n = r.judgements.length;
    const valid = (x) => Number.isFinite(x);
    if (!n) fail("Must have at least one judgement");
    let wMin = 0;
    let wMax = 0;
    for (const j of r.judgements) {
        if (!j.windows) continue;
        const [early, late] = j.windows;
        if (!valid(early)) fail(`Invalid floating point early window for '${j.name}'`);
        if (early > wMin) fail(`Early window ${early}ms for '${j.name}' must be ${wMin}ms or earlier`);
        wMin = early;
        if (!valid(late)) fail(`Invalid floating point late window for '${j.name}'`);
        if (late < wMax) fail(`Late window ${late}ms for '${j.name}' must be ${wMax}ms or later`);
        wMax = late;
    }
    let gAcc = -Infinity;
    for (const g of r.grades) {
        if (g.accuracy <= gAcc) fail(`Grade boundary ${g.accuracy} for '${g.name}' must be at least ${gAcc}`);
        gAcc = g.accuracy;
    }
    let previous = { kind: "comboBreaks", count: INT32_MAX };
    for (const l of r.lamps) {
        if (l.requirement.kind === "judgement" && l.requirement.judgement >= n) fail(`Lamp requirement for '${l.name}' refers to an invalid judgement`);
        if (!stricter(l.requirement, previous)) fail(`Lamp requirement for '${l.name}' must be stricter than the one before`);
        previous = l.requirement;
    }
    const points = r.accuracy.kind === "pointsPerJudgement";
    if (r.ghostTapJudgement !== null) {
        if (!points) fail("GhostTapJudgement must be used with PointsPerJudgement accuracy (otherwise it isn't clear what points it's worth)");
        if (r.ghostTapJudgement < 0 || r.ghostTapJudgement >= n) fail("GhostTapJudgement must be a valid judgement");
    }
    if (r.notePriority.kind === "interlude") {
        const { cbrush } = r.notePriority;
        if (cbrush < 0) fail("Interlude `cbrush_threshold` must be non-negative");
        if (cbrush > wMax || cbrush > Math.abs(wMin)) fail("Interlude `cbrush_threshold` must not exceed timing windows");
    }
    const judgement = (j) => Number.isInteger(j) && j >= 0 && j < n;
    const negative = (x) => !valid(x) || x < 0;
    const positive = (x) => !valid(x) || x > 0;
    const hold = r.holdMechanics;
    if (hold.kind === "osuMania" || hold.kind === "headJudgementOr") {
        if (!points) fail("CombineHeadAndTail rules must be used with PointsPerJudgement accuracy (otherwise it isn't clear what points you give overholds)");
    }
    if (hold.kind === "osuMania") {
        if (n !== 6) fail("osu!mania ln mechanics must be used with exactly 6 judgements");
        for (const key of OSU_LN) if (negative(hold.windows[key])) fail(`osu!mania ln ${key} must be non-negative`);
    } else if (hold.kind === "headJudgementOr") {
        if (positive(hold.early)) fail("HeadJudgementOr `early_window` must be non-positive");
        if (negative(hold.late)) fail("HeadJudgementOr `late_window` must be non-negative");
        if (!judgement(hold.ifDropped)) fail("HeadJudgementOr `judgement_if_dropped` must be a valid judgement");
        if (!judgement(hold.ifOverheld)) fail("HeadJudgementOr `judgement_if_dropped` must be a valid judgement");
    } else if (hold.kind === "onlyRequireHold") {
        if (hold.window < 0) fail("OnlyRequireHold window must be non-negative");
    } else if (hold.kind === "judgeReleasesSeparately") {
        if (hold.windows.length !== n) fail("JudgeReleasesSeparately `windows` must match judgement count");
        let rMin = 0;
        let rMax = 0;
        for (const w of hold.windows) {
            if (!w) continue;
            if (w[0] > rMin) fail(`Early release window ${w[0]}ms must be ${rMin}ms or earlier`);
            rMin = w[0];
            if (w[1] < rMax) fail(`Late release window ${w[1]}ms must be ${rMax}ms or later`);
            rMax = w[1];
        }
        if (!judgement(hold.ifOverheld)) fail("JudgeReleasesSeparately `judgement_if_dropped` must be a valid judgement");
    } else if (!judgement(hold.ifDropped)) {
        fail("OnlyJudgeReleases `judgement_if_dropped` must be a valid judgement");
    }
    if (r.accuracy.kind === "wifeCurve") {
        if (r.accuracy.judge < 2 || r.accuracy.judge > 9) fail("WifeCurve `judge` must be a valid judge value");
    } else {
        if (r.accuracy.points.length !== n) fail(`PointsPerJudgement \`points\` provides ${r.accuracy.points.length} values but there are ${n} judgements`);
        if (!r.accuracy.points.every(valid)) fail("PointsPerJudgement `points` contains invalid floating point values");
    }
    const [nEarly, nLate] = r.noteWindows;
    const [rEarly, rLate] = r.releaseWindows;
    const largest = Math.max(Math.max(Math.abs(nEarly), nLate), Math.max(Math.abs(rEarly), rLate));
    if (largest > LARGEST_WINDOW_MS) fail(`Timing window maximum is 500ms, this ruleset contains a largest window of ${largest}`);
}

const deepFreeze = (list) => Object.freeze(list.map((x) => Object.freeze(x)));

// A ruleset's JSON (the text, its bytes or the parsed object) → the ruleset, checked; throws why it cannot be used.
// → { name, description, judgements: [{ name, color, breaksCombo, windows: [early, late] | null }],
// lamps: [{ name, color, requirement }], grades: [{ name, color, accuracy }], notePriority, ghostTapJudgement,
// holdMechanics, accuracy, decimals, noteWindows, releaseWindows }. Windows in ms of real time, early ≤ 0.
export function parseRuleset(input) {
    let json = input;
    if (input instanceof Uint8Array) json = new TextDecoder("utf-8").decode(input);
    if (typeof json === "string") {
        try {
            json = JSON.parse(json.replace(/^﻿/, ""));
        } catch (e) {
            fail(`not JSON (${e.message})`);
        }
    }
    if (!isObject(json)) fail("not a record");
    const judgements = deepFreeze(list(json.Judgements, "Judgements").map((j, i) => {
        if (!isObject(j)) fail(`judgement ${i + 1} is not a record`);
        const name = text(j.Name, `judgement ${i + 1}'s name`);
        return { name, color: colour(j.Color, `${name}'s colour`), breaksCombo: flag(j.BreaksCombo, `${name}'s BreaksCombo`), windows: windowsOf(j.TimingWindows, `${name}'s windows`) };
    }));
    const lamps = deepFreeze(list(json.Lamps ?? [], "Lamps").map((l, i) => {
        if (!isObject(l)) fail(`lamp ${i + 1} is not a record`);
        const name = text(l.Name, `lamp ${i + 1}'s name`);
        return { name, color: colour(l.Color, `${name}'s colour`), requirement: lampRequirement(l.Requirement, `lamp ${name}`) };
    }));
    const grades = deepFreeze(list(json.Grades ?? [], "Grades").map((g, i) => {
        if (!isObject(g)) fail(`grade ${i + 1} is not a record`);
        const name = text(g.Name, `grade ${i + 1}'s name`);
        return { name, color: colour(g.Color, `${name}'s colour`), accuracy: number(g.Accuracy, `${name}'s accuracy`) };
    }));
    if (!isObject(json.HitMechanics)) fail("HitMechanics is not a record");
    const ghost = json.HitMechanics.GhostTapJudgement;
    const holdMechanics = holdMechanicsOf(json.HoldMechanics);
    const noteWindows = Object.freeze(noteWindowsOf(judgements));
    const ruleset = {
        name: text(json.Name, "Name"), description: typeof json.Description === "string" ? json.Description : "",
        judgements, lamps, grades,
        notePriority: notePriority(json.HitMechanics.NotePriority),
        ghostTapJudgement: ghost === null || ghost === undefined ? null : whole(ghost, "GhostTapJudgement"),
        holdMechanics, accuracy: accuracyPoints(json.Accuracy), decimals: decimalPlaces(json.Formatting),
        noteWindows, releaseWindows: Object.freeze(releaseWindowsOf(holdMechanics, noteWindows)),
    };
    validate(ruleset);
    return Object.freeze(ruleset);
}

// Ruleset.FormatAccuracy: accuracy (0..1, can be negative) as Interlude writes it.
export function formatAccuracy(ruleset, accuracy) {
    const percent = (digits) => `${(accuracy * 100).toFixed(digits)}%`;
    if (ruleset.decimals === 4) return percent(4);
    if (ruleset.decimals === 3) return accuracy === 1 ? "100.000%" : accuracy > 0.99998 ? percent(4) : percent(3);
    if (accuracy === 1) return "100.00%";
    return accuracy > 0.99998 ? percent(4) : accuracy > 0.9998 ? percent(3) : percent(2);
}

// The slot (src/replay/judge.js KINDS) of each of a ruleset's judgements, as the overlay puts them
// (src/overlay/interludeData.js mapJudgements): six fill the six in order; of another count the last is the miss and the
// others fill the slots in order, any past the fifth go in with the 50s.
export function rulesetSlots(ruleset) {
    const count = ruleset.judgements.length;
    if (count === SLOTS.length) return [...SLOTS];
    const last = count - 1;
    return ruleset.judgements.map((_, i) => (i === last && last > 0 ? "miss" : SLOTS[Math.min(i, 4)]));
}

// Interlude's default ruleset, SC J4 (Prelude's SC.create 4), for when the one picked in Interlude cannot be read.
export const SC_J4 = parseRuleset({
    Accuracy: { PointsPerJudgement: [1, 0.9, 0.5, -0.5, -1, -1] },
    Description: "The 'official' scoring system of Interlude, tuned for a balanced experience",
    Formatting: { DecimalPlaces: "TWO" },
    Grades: [
        { Accuracy: 0, Color: [255, 200, 163, 155], Name: "D" },
        { Accuracy: 0.89995, Color: [255, 194, 162, 182], Name: "C-" },
        { Accuracy: 0.90995, Color: [255, 202, 153, 183], Name: "C" },
        { Accuracy: 0.91995, Color: [255, 163, 190, 207], Name: "B-" },
        { Accuracy: 0.92995, Color: [255, 149, 193, 220], Name: "B" },
        { Accuracy: 0.93995, Color: [255, 148, 210, 180], Name: "A-" },
        { Accuracy: 0.94995, Color: [255, 134, 227, 183], Name: "A" },
        { Accuracy: 0.95995, Color: [255, 127, 231, 139], Name: "A+" },
        { Accuracy: 0.96995, Color: [255, 237, 205, 140], Name: "S-" },
        { Accuracy: 0.97995, Color: [255, 246, 234, 128], Name: "S" },
        { Accuracy: 0.98995, Color: [255, 235, 200, 220], Name: "S+" },
    ],
    HitMechanics: { GhostTapJudgement: null, NotePriority: { Interlude: 90 } },
    HoldMechanics: { CombineHeadAndTail: { HeadJudgementOr: [-180, 180, 3, 3] } },
    Judgements: [
        { BreaksCombo: false, Color: [255, 0, 255, 255], Name: "Marvellous", TimingWindows: [-22.5, 22.5] },
        { BreaksCombo: false, Color: [255, 255, 255, 0], Name: "Perfect", TimingWindows: [-45, 45] },
        { BreaksCombo: false, Color: [255, 0, 255, 100], Name: "Great", TimingWindows: [-90, 90] },
        { BreaksCombo: true, Color: [255, 0, 0, 255], Name: "Good", TimingWindows: [-135, 135] },
        { BreaksCombo: true, Color: [255, 255, 0, 255], Name: "Bad", TimingWindows: [-180, 180] },
        { BreaksCombo: true, Color: [255, 255, 0, 0], Name: "Miss", TimingWindows: null },
    ],
    Lamps: [
        { Color: [255, 255, 160, 160], Name: "SDCB", Requirement: { ComboBreaksAtMost: 9 } },
        { Color: [255, 160, 160, 160], Name: "1CB", Requirement: { ComboBreaksAtMost: 1 } },
        { Color: [255, 80, 255, 80], Name: "FC", Requirement: { ComboBreaksAtMost: 0 } },
        { Color: [255, 160, 255, 160], Name: "SDG", Requirement: { JudgementAtMost: [2, 9] } },
        { Color: [255, 200, 160, 255], Name: "1G", Requirement: { JudgementAtMost: [2, 1] } },
        { Color: [255, 255, 255, 80], Name: "PFC", Requirement: { JudgementAtMost: [2, 0] } },
        { Color: [255, 255, 255, 160], Name: "SDP", Requirement: { JudgementAtMost: [1, 9] } },
        { Color: [255, 255, 160, 255], Name: "1P", Requirement: { JudgementAtMost: [1, 1] } },
        { Color: [255, 160, 255, 255], Name: "MFC", Requirement: { JudgementAtMost: [1, 0] } },
    ],
    Name: "SC J4",
});
