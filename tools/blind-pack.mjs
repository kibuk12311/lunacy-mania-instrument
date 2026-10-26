// Blind play test (addendum §7, plan §10 Gate 3): maps A and B for a few held-out songs across dans, made by the
// current v3 generator with the same request and seed, packed one .osz per song with the two diffs named [X] and
// [Y] at random. The key (which engine is X) is written to A:/SneezeyTrain/candidates/blind-<date>.json, never into
// a pack. Import the .osz files into osu! (double-click), play both diffs of each song, note the one you prefer, and
// only then open the key. B ships when it is preferred on 3 or more of 5 songs.
// Usage: node tools/blind-pack.mjs --picks FILE --a label=path|rules --b label=path|rules [--n 5] [--songs 0,7,12]
//        [--seed 1] [--form range|target] [--snaps auto|q4|all] [--config FILE] [--out DIR] [--key FILE]
//        [--split FILE[,FILE]] [--no-heldout-check] [--ffmpeg PATH]
// Defaults: --out A:/SneezeyTrain/candidates/blind-<date>/, --key A:/SneezeyTrain/candidates/blind-<date>.json;
// neither is ever overwritten (a -2, -3 … name is taken instead).
import { readFile, stat } from "node:fs/promises";
import { randomInt } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, configFor, SNAP_VARIANTS } from "./eval/compare.mjs";
import { loadSplitIndex, requireHeldout, defaultSplitFiles } from "./eval/heldout.mjs";
import { writeBlindPack, blindKeyPath, blindDirPath, spreadByDan, freePath } from "./eval/blind.mjs";
import { loadSong, snapsOf, buildInput, runEngine, wantsStems } from "./eval/genRun.mjs";
import { isPackLike } from "./corpus-index.mjs";

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_CORPUS = "A:/SneezeyTrain/corpus/corpus.jsonl";

function engineArg(v, fallbackLabel) {
    if (v === "rules") return { label: "rules", kind: "rules" };
    const eq = v.indexOf("=");
    return eq > 0 ? { label: v.slice(0, eq), kind: v.slice(eq + 1) === "rules" ? "rules" : "model", path: v.slice(eq + 1) } : { label: fallbackLabel, kind: "model", path: v };
}

// The song title on the blind pack: a pack chart names its song in the difficulty name ("Dan ~ REFORM ~ … Pack"
// [Song - Title 1.1x]), so the title gets " - <difficulty>" there; any other chart keeps its title.
export function blindTitle(song) {
    const version = /^Version:\s*(.*)$/m.exec(song.text ?? "")?.[1]?.trim() ?? "";
    return isPackLike(song.artist, song.title) && version ? `${song.title} - ${version}` : song.title;
}

export function parseBlindArgs(argv) {
    const o = { n: 5, seed: 1, form: "range", snaps: "auto", heldoutCheck: true, ffmpeg: "ffmpeg" };
    for (let i = 0; i < argv.length; i += 1) {
        const k = argv[i].replace(/^--/, "");
        if (k === "no-heldout-check") {
            o.heldoutCheck = false;
            continue;
        }
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`missing value for --${k}`);
        i += 1;
        if (k === "a") o.a = engineArg(v, "A");
        else if (k === "b") o.b = engineArg(v, "B");
        else if (k === "n") o.n = Number(v);
        else if (k === "seed") o.seed = Number(v);
        else if (k === "songs") o.songs = v.split(",").map(Number);
        else if (["picks", "form", "snaps", "config", "out", "key", "split", "ffmpeg"].includes(k)) o[k] = v;
        else throw new Error(`unknown option --${k}`);
    }
    if (!o.picks) throw new Error("give --picks FILE (held-out songs, e.g. a compare-mappers heldout-180.json)");
    if (!o.a || !o.b) throw new Error("give --a and --b (label=path, a model file, or rules)");
    if (o.a.label === o.b.label) throw new Error("A and B need different labels");
    if (!(o.snaps in SNAP_VARIANTS)) throw new Error(`--snaps takes ${Object.keys(SNAP_VARIANTS).join(", ")}`);
    if (!["range", "target"].includes(o.form)) throw new Error("--form is range or target");
    if (!Number.isInteger(o.n) || o.n < 1) throw new Error("--n wants a whole number ≥ 1");
    return o;
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseBlindArgs(argv);
    const cfg = parseConfig(args.config ? await readFile(args.config, "utf8") : null, { baseDir: args.config ? path.dirname(path.resolve(args.config)) : "." });
    const all = JSON.parse(await readFile(args.picks, "utf8"));
    const chosen = args.songs ? args.songs.map((i) => all[i]).filter(Boolean) : spreadByDan(all, args.n);
    if (args.heldoutCheck) {
        const files = args.split ? args.split.split(",") : defaultSplitFiles(DEFAULT_CORPUS);
        for (const f of files) if (!(await stat(f).catch(() => null))) throw new Error(`split index ${f} not found (give --split or --no-heldout-check)`);
        requireHeldout(chosen, await loadSplitIndex(files));
    }
    const date = new Date();
    const outDir = args.out ? path.resolve(args.out) : await freePath(blindDirPath(date));
    const keyFile = path.resolve(args.key ?? blindKeyPath(date));
    const songs = [];
    for (const pick of chosen) {
        const song = await loadSong(pick, { ffmpeg: args.ffmpeg, wantStems: await wantsStems([args.a, args.b], (label) => configFor(cfg, label)) });
        const title = blindTitle(song);
        const maps = {};
        for (const [side, engine] of [["A", args.a], ["B", args.b]]) {
            const ecfg = configFor(cfg, engine.label);
            const input = buildInput(song, {
                form: args.form, seed: args.seed, snaps: snapsOf(engine.kind === "rules" ? "q4" : args.snaps, song), cfg: ecfg,
                meta: { title, artist: song.artist, audioFilename: song.audioName },
            });
            const { response } = await runEngine(engine, input, { cfg: ecfg });
            maps[side] = { osuText: response.osuText, numeric: response.result?.numeric ?? null, inRange: !!response.reachable };
        }
        songs.push({
            title, artist: song.artist, audioName: song.audioName, audio: await readFile(song.audioPath), maps,
            info: { dan: pick.dan, family: song.family, primary: pick.primary ?? null, seed: args.seed, osuPath: pick.osuPath },
        });
        console.log(`made ${song.artist} - ${title} (dan ${pick.dan}): A ${maps.A.numeric}, B ${maps.B.numeric}`);
    }
    const rng = () => randomInt(0, 2 ** 32) / 2 ** 32;
    const meta = { a: args.a, b: args.b, picks: path.resolve(args.picks), form: args.form, snaps: args.snaps, config: cfg };
    const { files, keyFile: written } = await writeBlindPack({ songs, outDir, keyFile, rng, meta, date });
    console.log(`\n${files.length} packs in ${outDir}\nkey (do not open before playing): ${written}`);
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
    main().then((code) => process.exit(code), (e) => {
        console.error(e?.stack ?? e);
        process.exit(1);
    });
}
