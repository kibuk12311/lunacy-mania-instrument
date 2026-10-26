// Reading the LeoBlack benchmark manifest (samples/data.csv) and locating its .osu files.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

function normalizeName(name) {
    return name.toLowerCase().replace(/\s+/g, " ").trim();
}

// Same song at any rate / with any remark → same group, so CV never splits one chart across folds.
export function groupKey(row) {
    return normalizeName(
        row.name
            .replace(/\s*x\d+(\.\d+)?\s*$/i, "")
            .replace(/\([^)]*\)/g, " "),
    );
}

export async function readBenchRows(csvPath) {
    const lines = (await readFile(csvPath, "utf8")).split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(",");
    return lines.slice(1).map((line) => {
        const cells = line.split(",");
        const raw = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
        const row = {
            bid: raw.bid,
            name: raw.name,
            pattern: raw.pattern,
            subPattern: raw.subPattern,
            expected: Number(raw.expected),
        };
        return { ...row, group: groupKey(row) };
    });
}

const dirCache = new Map();

async function listOsu(dir) {
    if (!dirCache.has(dir)) {
        dirCache.set(dir, readdir(dir).then((files) => files.filter((f) => f.toLowerCase().endsWith(".osu"))).catch(() => []));
    }
    return dirCache.get(dir);
}

// Matching priority from the benchmark's runner guide §6.2: exact → normalized → "Name(...)" vs "Name (...)".
export async function findOsuFile(samplesRoot, pattern, name) {
    const dir = path.join(samplesRoot, pattern);
    const files = await listOsu(dir);
    const exact = `${name}.osu`;
    if (files.includes(exact)) return path.join(dir, exact);

    const wanted = normalizeName(name);
    const normalized = files.find((f) => normalizeName(f.slice(0, -4)) === wanted);
    if (normalized) return path.join(dir, normalized);

    const spaced = (s) => normalizeName(s.replace(/\s*\(/g, " ("));
    const tolerant = files.find((f) => spaced(f.slice(0, -4)) === spaced(name));
    return tolerant ? path.join(dir, tolerant) : null;
}
