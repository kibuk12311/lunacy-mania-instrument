// Analysis results by (chart text, rate): LRU in memory, one JSON file per key on disk.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function cacheKey(osuText, rate) {
    return `${createHash("sha1").update(osuText).digest("hex")}@${Number(rate).toFixed(3)}`;
}

export function createCache({ dir, max = 500 }) {
    const memory = new Map();
    const fileFor = (key) => path.join(dir, `${key.replace(/[^a-z0-9.@-]/gi, "_")}.json`);

    function remember(key, value) {
        memory.delete(key);
        memory.set(key, value);
        while (memory.size > max) memory.delete(memory.keys().next().value);
    }

    return {
        async get(key) {
            if (memory.has(key)) {
                const value = memory.get(key);
                remember(key, value);
                return value;
            }
            try {
                const value = JSON.parse(await readFile(fileFor(key), "utf8"));
                remember(key, value);
                return value;
            } catch {
                return undefined;
            }
        },
        async set(key, value) {
            remember(key, value);
            await mkdir(dir, { recursive: true });
            await writeFile(fileFor(key), JSON.stringify(value), "utf8");
        },
        memorySize: () => memory.size,
        // everything gone (the Settings page): what is asked for next is worked out again
        async clear() {
            memory.clear();
            await rm(dir, { recursive: true, force: true });
        },
    };
}
