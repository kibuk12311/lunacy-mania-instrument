// The card's rate maps in main (src/rate/rateOrigin.js with the files around them): is the chart selected in osu! a
// rate map, and which difficulty was it made from. On osu! stable the original is looked for among the .osu files of
// the map's own folder (read only: nothing is ever written there), once tosu's path is checked to hold the very chart
// on the card; on lazer (hashed files, no folder to look in) or when it is not there, the original is made back from
// the rate map. A chart whose name is not a rate map's costs nothing (no request, no file read).
// find(text, { checksum }) → null | { rate, base, version, pitch, mirror, noLn, evidence, virtual, text, path (the
// original's file, or null), file (the rate map's, or null), client }; kept for the last few maps by osu!'s checksum.
import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { findRateOrigin, rateVersionOf } from "../src/rate/rateOrigin.js";

const KEEP = 8;
const MAX_FILES = 64; // .osu files read in one folder at most (the ones named like the original come first)
const noBom = (s) => String(s).replace(/^﻿/, "");

// beatmap() → tosu's { client, path } of the selected map (app/tosuClient.js fetchCurrentBeatmap)
export function createRateOrigins({ beatmap, readdir = fsReaddir, readFile = fsReadFile, log = () => {}, keep = KEEP, maxFiles = MAX_FILES }) {
    const known = new Map(); // checksum → answer

    function remember(checksum, answer) {
        if (!checksum) return;
        known.delete(checksum);
        known.set(checksum, answer);
        while (known.size > keep) known.delete(known.keys().next().value);
    }

    // { client, file, dir, likely, rest }: the folder is listed only when tosu's file is the chart on the card. likely:
    // the .osu files named "… [<base>].osu", as osu! names the original's file, read first; rest: the others, up to
    // maxFiles in all, read only when no likely one is the original (a set full of rate copies sorts its "[Hard 1.05x"
    // files before "[Hard]", so a cap over the folder's order would cut the original off)
    async function around(text, base) {
        let source = null;
        try {
            source = await beatmap();
        } catch {
            // no path from tosu: only the chart itself can tell
        }
        const client = source?.client ?? null;
        const none = { client, file: null, dir: null, likely: [], rest: [] };
        if (client !== "stable" || typeof source?.path !== "string" || !source.path) return none;
        const own = await readFile(source.path, "utf8").catch(() => null);
        if (own === null || noBom(own) !== noBom(text)) return none;
        const dir = path.dirname(source.path);
        const names = (await readdir(dir).catch(() => []))
            .filter((n) => n.toLowerCase().endsWith(".osu") && n !== path.basename(source.path));
        const mark = `[${base}].osu`.toLowerCase();
        const likely = names.filter((n) => n.toLowerCase().endsWith(mark)).slice(0, maxFiles);
        const rest = names.filter((n) => !n.toLowerCase().endsWith(mark)).slice(0, Math.max(0, maxFiles - likely.length));
        return { client, file: source.path, dir, likely, rest };
    }

    async function read(dir, names) {
        const siblings = [];
        for (const n of names) {
            const body = await readFile(path.join(dir, n), "utf8").catch(() => null);
            if (body !== null) siblings.push({ text: noBom(body), path: path.join(dir, n) });
        }
        return siblings;
    }

    return async function find(text, { checksum = null } = {}) {
        if (typeof text !== "string" || !rateVersionOf(text)) return null;
        if (checksum && known.has(checksum)) return known.get(checksum);
        const { client, file, dir, likely, rest } = await around(text, rateVersionOf(text).base);
        let siblings = await read(dir, likely);
        let origin = findRateOrigin(noBom(text), siblings);
        if (!(origin && origin.sibling !== null) && rest.length) {
            siblings = siblings.concat(await read(dir, rest));
            origin = findRateOrigin(noBom(text), siblings);
        }
        const answer = origin
            ? { ...origin, path: origin.sibling === null ? null : siblings[origin.sibling].path, file, client: client ?? "stable" }
            : null;
        log(answer
            ? `rate map ×${answer.rate} (${answer.evidence})${answer.path ? ` of ${path.basename(answer.path)}` : ", original made back from it"}`
            : "rate-map name without evidence: shown as it is");
        // kept once the answer is final: lazer has no folder to look in; a stable map whose file could not be checked
        // (tosu had no path yet, another map by then) is asked again next time
        if (client === "lazer" || file) remember(checksum, answer);
        return answer;
    };
}
