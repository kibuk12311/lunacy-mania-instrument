// Interlude's own plays in the Replay tab, the main side (app/replayIpc.js hands them here). Interlude keeps no
// judgements, only each play's key presses (Data\scores.db), and judges them again by its ruleset whenever it shows a
// score; so does this: by the ruleset Interlude judges by (the one the live reader saw on its last play while it runs,
// else options.json's), or any other of its rulesets the tab asks for, with the same judging (src/interlude/judge.js
// through src/replay/analyzeInterlude.js). Without a ruleset that can be read it judges by SC J4, Interlude's default,
// built in, and says so. Charts, plays, rulesets: all read through the
// library (app/interludeLibrary.js), which copies Interlude's databases and never writes into its folder.
// A play's id is interlude:<ChartId>:<Timestamp>, as the local profile's import names it (app/localProfileService.js).
// Times: ms of the chart (absolute, the notes' clock, as played: after the mods), as on the osu! path.
// After a play in Interlude (app/interludeLive.js sees it end) its new row of scores.db is looked for: see ended().
// Interlude turned off in ⚙ Settings (app/interludeClient.js) is as if no folder were linked: no plays listed or opened,
// none waited for after a play.
import path from "node:path";
import { stat, readFile } from "node:fs/promises";
import { interludeFolderOf, SCORES_DB, DEFAULT_RULESET } from "./interludeLibrary.js";
import { parseIlMods, applyIlMods, readIlReplay, ilNotes, ilPresses } from "../src/interlude/replay.js";
import { SC_J4, rulesetSlots } from "../src/interlude/ruleset.js";
import { judgeIlReplay } from "../src/interlude/judge.js";
import { analyzeIlReplay } from "../src/replay/analyzeInterlude.js";
import { noteTimes, splitSections } from "../src/analysis/sections.js";
import { handsOf, validFingers } from "../src/replay/fingers.js";
import { t } from "../src/i18n/i18n.js";

export const IL_LIST_MAX = 40;
export const IL_EARLIER_MAX = 12; // earlier plays of the chart worked out for the comparison, newest first
const EARLIER_READ_MAX = 240; // earlier plays counted (only their rows are read, not their replays)
export const BUILTIN_RULESET = DEFAULT_RULESET; // the id SC J4 has in Interlude, for the built-in one
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const JUDGED_KEEP = 600; // list items' accuracies kept
// After a play: how long its row of scores.db is looked for. Interlude saves a play as it ends, before the score screen
// opens, and its Timestamp is that moment (Prelude's Stats.HandleScore takes TimePlayed less the chart's length for when
// the play began), so a finished play's row is there at once or nearly; a play quit for level select gets none (Interlude
// keeps no play cut short), and is looked for only as briefly as a quit osu! play. So is one whose score screen opened
// before its end (app/interludeLive.js): a quit out saves nothing or, with "Save and show score", saves at once, and a
// play failed partway is saved at once too, so a row that comes still makes it a pass or a fail.
export const IL_ENDED_WAIT_MS = { finished: 30_000, quit: 1_500 };
// The row is saved at the play's end, so after its start as the reader saw it; this much earlier still counts, for the
// two clocks (Interlude's and ours, both this machine's) read at slightly different moments.
export const IL_ENDED_SLACK_MS = 500;
const IL_ENDED_STEP_MS = 400; // only scores.db's size and time are looked at this often: it is copied only when changed
const IL_WAIT_NOTE_MS = 3_000; // a row this quick needs no note that it is on its way

const f32 = Math.fround;
// A play's rate as the tab shows it: scores.db keeps it as a float32 (1.1 is 1.100000023841858), which the judging
// takes as it is; the list, an open play and its earlier plays give the decimal it stands for, as osu!'s rates are,
// each the same way so that plays at one rate compare equal.
export const rateShown = (rate) => Number(f32(rate).toPrecision(7));
const PLAY_ID = /^interlude:([0-9A-Za-z]+):(-?\d+)$/;

export const playIdOf = (chart, at) => `interlude:${chart}:${at}`;
// the name Interlude shows for one mod in its state
const modLabel = (id, state) => parseIlMods(JSON.stringify({ [id]: state })).labels[0];
// interlude:<chart>:<at> → { chart, at }, or null for anything else
export function parsePlayId(play) {
    const m = PLAY_ID.exec(String(play ?? ""));
    return m && Number.isSafeInteger(Number(m[2])) ? { chart: m[1], at: Number(m[2]) } : null;
}

// interlude: app/interludeClient.js's client ({ ready, enabled, folder, library }), or null when the app has none.
// liveRuleset() → the name of the ruleset Interlude judged its last play by, as the live reader saw it
// (app/interludeLive.js), or null when Interlude is not followed or no play was seen since it started.
export function createIlReplays({
    interlude = null, liveRuleset = () => null, log = () => {}, now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
    const library = interlude?.library ?? null;
    const judged = new Map(); // list items' { accuracy, miss, reason }, by the play, its row and the ruleset: see itemJudged

    // Whether Interlude's folder can be read: { linked, ok, reason: null | "unlinked" | "missing" | "off" } ("off":
    // Interlude turned off in Settings, its folder kept).
    async function place() {
        if (!library) return { linked: false, ok: false, reason: "unlinked" };
        await interlude.ready?.();
        if (interlude.enabled && !(await interlude.enabled())) return { linked: false, ok: false, reason: "off" };
        const dir = interlude.folder?.() ?? null;
        if (!dir) return { linked: false, ok: false, reason: "unlinked" };
        if (!(await interludeFolderOf(dir))) return { linked: true, ok: false, reason: "missing" };
        return { linked: true, ok: true, reason: null };
    }

    // The id of the ruleset Interlude judges by now: by the name the live reader last saw on a play (liveName), when one of
    // the rulesets has it, the one options.json names first; else options.json's (written only as Interlude closes, so a
    // ruleset switched to while it runs is not in it yet); null when neither says.
    async function chosenRuleset(liveName) {
        const chosen = await library.selectedRuleset().catch(() => null);
        if (typeof liveName !== "string" || !liveName) return chosen;
        const named = (await library.rulesets().catch(() => [])).filter((r) => r.name === liveName);
        const id = (named.find((r) => r.id === chosen) ?? named[0])?.id ?? (liveName === SC_J4.name ? BUILTIN_RULESET : null);
        return id ?? chosen;
    }

    // The ruleset to judge by: the one asked for, else the one Interlude judges by (chosenRuleset); SC J4 built in when
    // that one cannot be read, said as a fallback unless it is SC J4 itself, which Interlude has built in too.
    // → { id, name, fallback, ruleset (parseRuleset's), key (which file and version of it) }
    async function rulesetFor(asked = null, liveName = liveRuleset()) {
        const id = asked ?? (await chosenRuleset(liveName));
        const own = id ? await library.ruleset(id).catch(() => null) : null;
        if (own) return { id: own.id, name: own.ruleset.name, fallback: false, ruleset: own.ruleset, key: own.key };
        if (id && id !== BUILTIN_RULESET) log(`interlude: ruleset ${id} not found, judged by the built-in SC J4`);
        return { id: BUILTIN_RULESET, name: SC_J4.name, fallback: id !== BUILTIN_RULESET, ruleset: SC_J4, key: "built-in" };
    }

    // A play (the library's row, with its replay) and its chart as charts.db has it → what is needed to judge it:
    // { chart (as played: after the mods), frames, labels } or { reason, mods (the names of the mods not followed) }.
    // A play that is not 4K is "keys", Mods that are no mods or a replay that cannot be read "badReplay".
    function prepare(row, raw) {
        if (row.keys !== 4 || raw.keys !== 4) return { reason: "keys" };
        let parsed;
        try {
            parsed = parseIlMods(row.mods);
        } catch {
            return { reason: "badReplay" };
        }
        if (parsed.unsupported.length) return { reason: "mods", mods: parsed.unsupported.map((id) => modLabel(id, parsed.mods[id])) };
        let frames;
        try {
            frames = readIlReplay(row.replay ?? Buffer.alloc(0));
        } catch {
            return { reason: "badReplay" };
        }
        return { chart: applyIlMods(raw, parsed.mods), frames, labels: parsed.labels };
    }
    const labelsOf = (mods) => {
        try {
            return parseIlMods(mods).labels;
        } catch {
            return [];
        }
    };

    // A listed play's accuracy and misses by the ruleset → { accuracy (percent, null when nothing was judged), miss,
    // reason }; a failed play judged as far as it went, as its analysis is.
    function judgeItem(row, raw, ruleset) {
        const ready = prepare(row, raw);
        if (ready.reason) return { accuracy: null, miss: null, reason: ready.reason };
        const { chart, frames } = ready;
        if (!chart.notes.length || !frames.times.length) return { accuracy: null, miss: null, reason: "empty" };
        const j = judgeIlReplay({ ruleset, chart, frames, rate: row.rate, untilLastFrame: row.failed });
        const slots = rulesetSlots(ruleset);
        const miss = j.counts.reduce((sum, count, i) => sum + (slots[i] === "miss" ? count : 0), 0);
        return { accuracy: j.maxPossiblePoints > 0 ? j.accuracy * 100 : null, miss, reason: null };
    }

    // The same, worked out once for a play (its row as stored: a play deleted and saved again is another) and a version
    // of a ruleset. A chart missing from the library is not kept: it may be imported again. Only what the play itself
    // gives is kept: the library's own errors (a database busy past its retry, a copy that failed) go up to the list, so
    // a good play is never kept as a broken one.
    async function itemJudged(row, rs, charts) {
        const key = [playIdOf(row.chart, row.at), row.id, row.size, row.mods, row.rate, row.failed, row.keys, rs.key].join("|");
        if (judged.has(key)) return judged.get(key);
        if (!charts.has(row.chart)) charts.set(row.chart, await library.chart(row.chart));
        const raw = charts.get(row.chart);
        if (!raw) return { accuracy: null, miss: null, reason: "nochart" };
        const full = await library.replay(row.chart, row.at);
        if (!full) return { accuracy: null, miss: null, reason: "badReplay" };
        let out;
        try {
            out = judgeItem(full, raw, rs.ruleset);
        } catch (error) {
            log(`interlude: play ${playIdOf(row.chart, row.at)} not judged: ${error?.message}`);
            out = { accuracy: null, miss: null, reason: "badReplay" };
        }
        judged.set(key, out);
        if (judged.size > JUDGED_KEEP) judged.delete(judged.keys().next().value);
        return out;
    }

    // Interlude's newest plays: { interlude: { linked, ok, reason }, items: [{ kind: "interlude", play, chart, at, rate,
    // modNames, accuracy, miss, failed, artist, title, version, found, reason }] } newest first, accuracy and misses by
    // the ruleset chosen in Interlude. Never throws: what went wrong is the reason ("dbFailed": the databases could not
    // be read), and there are no items.
    async function list({ limit = IL_LIST_MAX } = {}) {
        const where = await place();
        if (!where.ok) return { interlude: where, items: [] };
        try {
            let rows;
            try {
                rows = await library.replays({ limit });
            } catch (error) {
                if (error?.code === "NO_DB") return { interlude: where, items: [] }; // nothing played yet
                throw error;
            }
            const rs = await rulesetFor();
            const charts = new Map();
            const items = [];
            for (const row of rows) {
                const meta = await library.meta(row.chart).catch(() => null);
                const own = await itemJudged(row, rs, charts);
                items.push({
                    kind: "interlude", play: playIdOf(row.chart, row.at), chart: row.chart, at: row.at, rate: rateShown(row.rate),
                    modNames: labelsOf(row.mods), accuracy: own.accuracy, miss: own.miss, failed: row.failed,
                    artist: meta?.artist ?? null, title: meta?.title ?? null, version: meta?.version ?? null, found: Boolean(meta), reason: own.reason,
                });
            }
            return { interlude: where, items };
        } catch (error) {
            log(`interlude: plays not read: ${error?.message}`);
            return { interlude: { ...where, ok: false, reason: "dbFailed" }, items: [] };
        }
    }

    const fileThere = async (file) => Boolean(file && (await stat(file).catch(() => null))?.isFile());

    // One play opened → { answer, state }: answer the reply of replay-open without its id ({ ok: false, message } when
    // the play cannot be found), state what the service keeps of it while it is open (null when it has no chart). The
    // answer is the .osr one's, with replay.source "interlude", replay.play, replay.failed, rulesets: [{ id, name }] and
    // ruleset: { id, name, fallback }; reasons "nochart", "keys", "mods" (with mods: their names), "badReplay", "empty".
    async function open({ play, ruleset: asked = null } = {}) {
        const id = parsePlayId(play);
        if (!id) return { answer: { ok: false, message: t("replay.err.noPlay") }, state: null };
        const where = await place();
        if (!where.ok) return { answer: { ok: false, message: where.reason === "off" ? t("app.interlude.off") : t("app.interlude.noFolder") }, state: null };
        // the library failing (scores.db gone: no play; a copy or a read that failed twice) is said in words, without paths
        const refused = (error) => {
            log(`interlude: play ${play} not opened: ${error?.message}`);
            const message = error?.code === "NO_DB" ? t("replay.err.noPlay") : t("app.interlude.dbFailed", { message: error?.syscall ? error.code : error?.message ?? "" });
            return { answer: { ok: false, message }, state: null };
        };
        let row;
        try {
            row = await library.replay(id.chart, id.at);
        } catch (error) {
            return refused(error);
        }
        if (!row) return { answer: { ok: false, message: t("replay.err.noPlay") }, state: null };
        const rs = await rulesetFor(typeof asked === "string" && asked ? asked : null);
        const replay = {
            source: "interlude", play: playIdOf(row.chart, row.at), chart: row.chart, at: row.at, rate: rateShown(row.rate),
            modNames: labelsOf(row.mods), failed: row.failed, counts: null, maxCombo: null, player: null, md5: null, score: null, file: null,
        };
        const base = {
            ok: true, replay, map: null, presses: null, analysis: null, reason: null, lastMs: 0,
            rulesets: await library.rulesets().catch(() => []), ruleset: { id: rs.id, name: rs.name, fallback: rs.fallback },
        };
        let raw;
        let osu;
        try {
            [raw, osu] = await Promise.all([library.chart(row.chart), library.osuFor(row.chart)]);
        } catch (error) {
            if (error?.code !== "NO_DB") return refused(error);
            raw = null; // charts.db gone since: no chart
        }
        if (!raw || !osu) return { answer: { ...base, reason: "nochart" }, state: null };
        const ready = prepare(row, raw);
        const chart = ready.chart ?? raw;
        const notes = ilNotes(chart);
        const audioFile = (await fileThere(osu.audio)) ? osu.audio : null;
        const map = {
            artist: osu.meta.artist, title: osu.meta.title, version: osu.meta.version, od: null, keys: chart.keys, audio: Boolean(audioFile), notes,
        };
        const state = {
            play: replay.play, chart: row.chart, at: row.at, rate: row.rate, text: osu.text, notes, keys: chart.keys, raw, audioFile,
            ruleset: rs, analysis: null,
        };
        if (ready.reason) {
            log(`interlude: play ${replay.play}: ${ready.reason}`);
            return { answer: { ...base, map, reason: ready.reason, ...(ready.mods ? { mods: ready.mods } : {}) }, state };
        }
        const { frames } = ready;
        const first = chart.notes.length ? chart.notes[0].time : 0;
        const presses = ilPresses(frames, chart.keys, first);
        const parts = splitSections(noteTimes(osu.text), { rate: row.rate }).map(({ fromMs, toMs }) => ({ fromMs, toMs }));
        const analysis = analyzeIlReplay({ ruleset: rs.ruleset, chart, notes, frames, rate: row.rate, failed: row.failed, parts });
        const good = analysis.reason ? null : analysis;
        if (good) {
            replay.counts = { ...good.counts, accuracy: good.accuracy };
            replay.maxCombo = good.combo.max;
        }
        state.analysis = good;
        log(`interlude: play ${replay.play} by ${rs.id}${rs.fallback ? " (built in)" : ""}: ${notes.length} notes, ${analysis.reason ?? `manip ${good.manip.percent}%`}`);
        return {
            answer: {
                ...base, map, presses, analysis: good, reason: analysis.reason ?? null,
                lastMs: frames.times.length ? f32(first + frames.times[frames.times.length - 1]) : 0,
            },
            state,
        };
    }

    // The chart's audio of a play open (state: open's): { ok, data } or { ok: false, message }.
    async function audio(state) {
        const file = state?.audioFile ?? null;
        const s = file ? await stat(file).catch(() => null) : null;
        if (!s?.isFile() || s.size > MAX_AUDIO_BYTES) return { ok: false, message: t("replay.err.noAudio") };
        return { ok: true, data: await readFile(file) };
    }

    // The earlier plays of the chart of a play open (state: open's), each judged by the same ruleset and worked out like
    // it: { plays: [{ at, rate, modNames, failed, accuracy, misses, maxCombo, ur, manip, pairs, whole, exact }] newest
    // first, up to IL_EARLIER_MAX, total }, the shape the osu! ones have; null when the play was closed meanwhile
    // (stillOpen). fingers: the tab's, which decide the hands.
    async function earlier(state, { fingers = null, stillOpen = () => true } = {}) {
        const rows = await library.replays({ chart: state.chart, before: state.at, limit: EARLIER_READ_MAX }).catch(() => []);
        const hands = handsOf(validFingers(fingers));
        const plays = [];
        for (const row of rows.slice(0, IL_EARLIER_MAX)) {
            await sleep(0); // a long list must not hold up the window's other calls
            if (!stillOpen()) return null;
            try {
                const full = await library.replay(row.chart, row.at);
                const ready = full ? prepare(full, state.raw) : { reason: "badReplay" };
                if (ready.reason) continue;
                const a = analyzeIlReplay({ ruleset: state.ruleset.ruleset, chart: ready.chart, frames: ready.frames, rate: full.rate, failed: full.failed, hands });
                if (a.reason) continue;
                plays.push({
                    at: full.at, rate: rateShown(full.rate), modNames: ready.labels, failed: full.failed, accuracy: a.accuracy, misses: a.counts.miss, maxCombo: a.combo.max,
                    ur: a.ur, manip: a.manip.percent, pairs: a.manip.pairs, whole: a.played >= a.notes, exact: true,
                });
            } catch (error) {
                log(`interlude: earlier play ${playIdOf(row.chart, row.at)} left out: ${error?.message}`);
            }
        }
        if (!stillOpen()) return null;
        return { plays, total: rows.length };
    }

    // scores.db's size and time, and its -wal's: what changes when Interlude saves a play; null with no folder to read
    // (Interlude turned off, or its folder unlinked).
    async function scoresKey() {
        const dir = interlude.folder();
        if (!dir) return null;
        const file = path.join(dir, SCORES_DB);
        const [db, wal] = await Promise.all([stat(file).catch(() => null), stat(`${file}-wal`).catch(() => null)]);
        return `${file}|${db?.size ?? -1}|${db?.mtimeMs ?? -1}|${wal?.size ?? -1}|${wal?.mtimeMs ?? -1}`;
    }

    // The row saved for a play that just ended: its chart's newest, saved since the play began; null when none is (yet).
    async function savedRow(play) {
        try {
            return (await library.replays({ chart: play.chart, since: play.startedAt - IL_ENDED_SLACK_MS, limit: 1 }))[0] ?? null;
        } catch (error) {
            if (error?.code === "NO_DB") return null; // nothing saved yet at all
            throw error;
        }
    }

    // What the window is told of a row found: its id, time, rate, accuracy by the ruleset Interlude judged the play by
    // (liveName: its name as the reader saw it on the play; percent to two decimals, null when it cannot be judged) and
    // the chart's names.
    async function foundOf(row, liveName) {
        let accuracy = null;
        try {
            const own = await itemJudged(row, await rulesetFor(null, liveName), new Map());
            accuracy = own.accuracy === null ? null : Math.round(own.accuracy * 100) / 100;
        } catch (error) {
            log(`interlude: play ${playIdOf(row.chart, row.at)} not judged: ${error?.message}`);
        }
        const meta = await library.meta(row.chart).catch(() => null);
        return {
            play: playIdOf(row.chart, row.at), at: row.at, rate: rateShown(row.rate), failed: row.failed, accuracy,
            artist: meta?.artist ?? null, title: meta?.title ?? null, version: meta?.version ?? null,
        };
    }

    // A play that just ended in Interlude (app/interludeLive.js's { chart, rate, startedAt, endedAt, outcome: "finished" |
    // "quit", ruleset (the name of the one it was judged by, or null) }) → its row, looked for in scores.db until it comes
    // or the wait for its outcome is up:
    // { found: foundOf's }, { reason: "none" } when none came, { reason: "noFolder" } when Interlude's folder cannot be
    // read; null as soon as stillWanted() says no (a newer play ended, the switch was turned off) and while Interlude is
    // turned off in ⚙ Settings (or its folder unlinked meanwhile), but once waiting() was told the wait is closed so the
    // window's note that the row is on its way does not stay: { reason: "off" } when it is turned off, { reason: "noFolder" }
    // when its folder is unlinked. Between two reads only scores.db's size
    // and time are looked at, so its copy (it holds every replay: a real one runs to 100 MB) is made only when it changed.
    // waiting(): once, when a finished play's row takes its time.
    async function ended(play, { stillWanted = async () => true, waiting = () => {} } = {}) {
        const where = await place();
        if (where.reason === "off") return null;
        if (!where.ok) return (await stillWanted()) ? { reason: "noFolder" } : null;
        const from = now();
        const until = from + (IL_ENDED_WAIT_MS[play.outcome] ?? IL_ENDED_WAIT_MS.quit);
        let seen = null; // scores.db as it was when it was read last
        let noted = play.outcome !== "finished";
        let told = false; // waiting() was told
        for (;;) {
            const key = await scoresKey();
            if (key === null) {
                // the folder went (turned off or unlinked): after waiting() the window's note is closed, by "off" or as a
                // folder that cannot be read
                if (!told || !(await stillWanted())) return null;
                return { reason: (await place()).reason === "off" ? "off" : "noFolder" };
            }
            let row = null;
            if (key !== seen) {
                try {
                    row = await savedRow(play);
                    seen = key;
                } catch (error) {
                    log(`interlude: scores.db not read after a play: ${error?.message}`); // read again at the next look
                }
            }
            if (!(await stillWanted())) return null;
            if (row) return { found: await foundOf(row, typeof play.ruleset === "string" && play.ruleset ? play.ruleset : liveRuleset()) };
            if (now() >= until) return { reason: "none" };
            if (!noted && now() - from >= IL_WAIT_NOTE_MS) {
                noted = true;
                told = true;
                waiting();
            }
            await sleep(IL_ENDED_STEP_MS);
            if (!(await stillWanted())) return null;
        }
    }

    return { place, list, open, audio, earlier, ended };
}
