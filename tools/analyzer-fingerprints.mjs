// The analyzer fingerprint of every released version (src/core/analyzerVersion.js), worked out with today's rules over
// each release's own files as git has them (its import graph as it was), so the app can tell which older result
// folders (results-<version>) and session libraries hold answers it would give itself. Only reads git: the release
// commits of a branch ("release 0.9.9: …"), their files through `git cat-file --batch`; nothing is checked out.
// Run it again when the rules in src/core/analyzerVersion.js change (ROOTS, DATA_FILES, FORMAT, how files are hashed).
//
// Usage: node tools/analyzer-fingerprints.mjs [--branch public] [--write]
//   --write  writes src/core/analyzerReleases.js (the table the app ships)
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzerFingerprint } from "../src/core/analyzerVersion.js";

const SELF = fileURLToPath(import.meta.url);
const REPO = path.join(path.dirname(SELF), "..");
const OUT = path.join(REPO, "src", "core", "analyzerReleases.js");

// `git log --format="%h %s"` → [{ version, commit }], oldest first; one commit per version (the newest of its name).
export function releaseCommits(logText) {
    const seen = new Map();
    for (const line of String(logText).split(/\r?\n/)) {
        const m = /^([0-9a-f]{7,40}) release (\d+\.\d+\.\d+)\b/.exec(line.trim());
        if (m && !seen.has(m[2])) seen.set(m[2], m[1]);
    }
    return [...seen].map(([version, commit]) => ({ version, commit })).reverse();
}

// One `git cat-file --batch` for every file asked: read("<commit>:<path>") → Buffer | null, one request at a time.
export function gitBlobs({ cwd = REPO, spawnGit = () => spawn("git", ["cat-file", "--batch"], { cwd }) } = {}) {
    const git = spawnGit();
    let buffer = Buffer.alloc(0);
    let waiting = null;
    let line = Promise.resolve();

    function settle() {
        if (!waiting) return;
        const eol = buffer.indexOf(10);
        if (eol < 0) return;
        const head = buffer.subarray(0, eol).toString("utf8");
        if (/ missing$| ambiguous$/.test(head)) {
            buffer = buffer.subarray(eol + 1);
            const done = waiting;
            waiting = null;
            done(null);
            return;
        }
        const size = Number(head.split(" ")[2]);
        if (buffer.length < eol + 1 + size + 1) return;
        const body = Buffer.from(buffer.subarray(eol + 1, eol + 1 + size));
        buffer = buffer.subarray(eol + 1 + size + 1);
        const done = waiting;
        waiting = null;
        done(head.split(" ")[1] === "blob" ? body : null);
    }

    git.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        settle();
    });
    const read = (spec) => {
        const next = line.then(() => new Promise((resolve) => {
            waiting = resolve;
            git.stdin.write(`${spec}\n`);
            settle();
        }));
        line = next.catch(() => {});
        return next;
    };
    return { read, close: () => git.stdin.end() };
}

// The table as the app ships it.
export function tableSource(rows, branch) {
    const entries = rows.map((r) => `    "${r.version}": "${r.fingerprint}", // ${r.commit}`).join("\n");
    return `// Written by tools/analyzer-fingerprints.mjs from the release commits of the "${branch}" branch: each released
// version → its analyzer fingerprint (src/core/analyzerVersion.js), worked out with today's rules over that release's
// own files. The app adopts an older results-<version> folder and keeps an older session library's analyses when the
// version's fingerprint here is its own (app/resultsFolder.js, app/sessionLibrary.js). Only the versions up to 0.9.9
// named them by version; later ones write the fingerprint itself, so a new release needs no row here.
export const RELEASE_FINGERPRINTS = Object.freeze({
${entries}
});
`;
}

async function main() {
    const at = process.argv.indexOf("--branch");
    const branch = at > 0 ? process.argv[at + 1] : "public";
    const log = execFileSync("git", ["log", branch, "--format=%h %s"], { cwd: REPO, encoding: "utf8" });
    const blobs = gitBlobs();
    const rows = [];
    try {
        for (const { version, commit } of releaseCommits(log)) {
            const r = await analyzerFingerprint({ read: (rel) => blobs.read(`${commit}:${rel}`) });
            rows.push({ version, commit, fingerprint: r.fingerprint });
            const missing = r.missing.length ? ` missing ${r.missing.join(", ")}` : "";
            const counts = `${r.code.length} code files, ${r.texts.length} texts, ${r.data.length} data`;
            console.log(`${version} ${commit} ${r.fingerprint} (${counts})${missing}`);
        }
    } finally {
        blobs.close();
    }
    if (process.argv.includes("--write")) {
        writeFileSync(OUT, tableSource(rows, branch));
        console.log(`written ${OUT}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
