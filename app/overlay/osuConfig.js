// osu! stable's per-user settings file, read (never written) for its mania key layouts (src/overlay/osuKeys.js).
// It is osu!.<name>.cfg in the game folder (tosu's folders.game). osu! names it after the Windows user it runs as;
// tosu's profile name is tried next, then the most recently written osu!.*.cfg of the folder. No name is ever
// hard-coded, and the cfg's text is kept only in memory, parsed, for as long as the file doesn't change.
import { readdir, readFile, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { parseManiaLayouts } from "../../src/overlay/osuKeys.js";

const CFG = /^osu!\.(.+)\.cfg$/i;

const osUser = () => {
    try {
        return userInfo().username;
    } catch {
        return null;
    }
};

// the cfg files of the game folder, the one in use first: { file, name, mtimeMs }[]
export async function cfgCandidates(gameDir, { profile = null, user = osUser(), fs = { readdir, stat } } = {}) {
    if (!gameDir) return [];
    let names;
    try {
        names = await fs.readdir(gameDir);
    } catch {
        return [];
    }
    const found = [];
    for (const name of names) {
        const m = String(name).match(CFG);
        if (!m) continue;
        try {
            const st = await fs.stat(path.join(gameDir, name));
            if (st.isFile?.() === false) continue;
            found.push({ file: path.join(gameDir, name), name, who: m[1], mtimeMs: st.mtimeMs ?? 0 });
        } catch {
            // gone meanwhile
        }
    }
    const rank = (c) => {
        const who = c.who.toLowerCase();
        if (user && who === String(user).toLowerCase()) return 0;
        if (profile && who === String(profile).toLowerCase()) return 1;
        return 2;
    };
    return found.sort((a, b) => rank(a) - rank(b) || b.mtimeMs - a.mtimeMs);
}

// → reader({ gameDir, profile }) → { file, layouts } | null, the cfg parsed once per change of the file
export function createOsuConfigReader({ fs = { readdir, stat, readFile }, user = osUser } = {}) {
    let cache = null; // { file, mtimeMs, layouts }
    return async function readOsuConfig({ gameDir, profile = null } = {}) {
        const [best] = await cfgCandidates(gameDir, { profile, user: user(), fs });
        if (!best) return null;
        if (cache && cache.file === best.file && cache.mtimeMs === best.mtimeMs) return { file: cache.file, layouts: cache.layouts };
        try {
            const layouts = parseManiaLayouts(await fs.readFile(best.file, "utf8"));
            cache = { file: best.file, mtimeMs: best.mtimeMs, layouts };
            return { file: best.file, layouts };
        } catch {
            return null;
        }
    };
}
