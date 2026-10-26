// One JSON value in a file: read once, then kept in memory; every write goes through normalize, to a .tmp file
// first and then renamed over the old one, one write at a time.
import * as nodeFs from "node:fs/promises";
import path from "node:path";

const RENAME_TRIES = 3; // Windows can refuse a rename for a moment while something else has the file open

export function createJsonStore({ file, normalize = (x) => x, fallback = null, fs = nodeFs }) {
    let value; // the current value once read
    let loading = null;
    let queue = Promise.resolve();

    const clean = (x) => {
        try {
            return normalize(x);
        } catch {
            return normalize(fallback);
        }
    };

    function load() {
        // no file or broken JSON: the fallback
        loading ??= fs.readFile(file, "utf8").then(JSON.parse)
            .then(clean, () => normalize(fallback))
            .then((v) => { value ??= v; return value; });
        return loading;
    }

    async function rename(from, to) {
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await fs.rename(from, to);
            } catch (error) {
                if (attempt >= RENAME_TRIES || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
                await new Promise((r) => setTimeout(r, 50 * attempt));
            }
        }
    }

    async function write(next) {
        value = normalize(next);
        loading = Promise.resolve(value);
        const tmp = `${file}.tmp`;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(value), "utf8");
        await rename(tmp, file);
        return structuredClone(value);
    }

    // writes run in the order asked; a failed one does not stop the next
    const serial = (fn) => {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
    };

    return {
        get: async () => structuredClone(await load()),
        set: (next) => serial(() => write(next)),
        update: (fn) => serial(async () => write(await fn(structuredClone(await load())))),
    };
}
