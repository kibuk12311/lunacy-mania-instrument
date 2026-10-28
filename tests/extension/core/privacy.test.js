// Privacy and safety of what ships: in the extension's code files the only URL hosts are osu!'s own (osu.ppy.sh,
// b.ppy.sh, *.ppy.sh), there is no eval / new Function / remote script; in the whole build output (every file, the
// copied analyzer and its wasm included) no local absolute path, no e-mail address, no user name of this machine.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { ROOT, buildForTest } from "./buildHelper.js";

async function walk(dir, skip = () => false) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (skip(full, entry)) continue;
        if (entry.isDirectory()) out.push(...(await walk(full, skip)));
        else out.push(full);
    }
    return out;
}

const ALLOWED_HOSTS = new Set(["osu.ppy.sh", "b.ppy.sh", "*.ppy.sh"]);
const CODE = /\.(?:m?js|json|html|css)$/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the extension's code talks only to osu!'s hosts and runs no code it did not ship", async () => {
    const ext = path.join(ROOT, "extension");
    const files = (await walk(ext, (full) => full.startsWith(path.join(ext, "build")))).filter((f) => CODE.test(f));
    assert.ok(files.length >= 20, `${files.length} code files`);
    const problems = [];
    for (const file of files) {
        const rel = path.relative(ext, file).split(path.sep).join("/");
        const source = await readFile(file, "utf8");
        for (const m of source.matchAll(/\b(?:https?|wss?|ftp):\/\/([^/"'`\s)<>]+)/gi)) {
            const host = m[1].replace(/:\d+$/, "").toLowerCase();
            if (!ALLOWED_HOSTS.has(host)) problems.push(`${rel}: URL host ${host}`);
        }
        if (/(?<![\w$.])eval\s*\(/.test(source)) problems.push(`${rel}: eval(`);
        if (/\bnew\s+Function\s*\(/.test(source)) problems.push(`${rel}: new Function(`);
        if (/\b(?:setTimeout|setInterval)\s*\(\s*["'`]/.test(source)) problems.push(`${rel}: timer with a code string`);
        if (/<script[^>]+src\s*=\s*["']?(?:https?:)?\/\//i.test(source)) problems.push(`${rel}: remote <script src>`);
        if (/\bimportScripts\s*\(\s*["'`]https?:/i.test(source)) problems.push(`${rel}: remote importScripts`);
        if (/\bimport\s*\(\s*["'`]https?:/i.test(source)) problems.push(`${rel}: remote import()`);
    }
    assert.deepEqual(problems, []);
});

test("no local paths, e-mail addresses or this machine's user name anywhere in the build output", async (t) => {
    const built = await buildForTest(t);
    const user = userInfo().username;
    const scratch = path.resolve(tmpdir());
    const roots = [ROOT, scratch, path.resolve(ROOT, "..")].flatMap((p) => [p, p.split(path.sep).join("/")]);
    const patterns = [
        [/[A-Za-z]:\\Users\\/i, "a Windows user folder"],
        [/[A-Za-z]:\/Users\//i, "a Windows user folder"],
        [/\/Users\/[A-Za-z]/, "a macOS user folder"],
        // Emscripten's own virtual file system has /home/web_user (MinaCalc, ONNX Runtime): nobody's folder
        [/\/home\/(?!web_user\b)[a-z_]/, "a Linux home folder"],
        [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|ru|io|dev|de|uk|me|app)\b/, "an e-mail address"],
        ...roots.map((r) => [new RegExp(escapeRe(r), "i"), "a folder of this machine"]),
        ...(user && user.length >= 3 ? [[new RegExp(escapeRe(user), "i"), "this machine's user name"]] : []),
    ];
    const problems = [];
    let scanned = 0;
    for (const dir of Object.values(built.targets)) {
        for (const file of await walk(dir)) {
            const bytes = await readFile(file);
            const texts = [bytes.toString("utf8"), bytes.toString("latin1")];
            scanned += 1;
            for (const [re, what] of patterns) {
                const hit = texts.map((s) => re.exec(s)).find(Boolean);
                if (hit) problems.push(`${path.relative(dir, file)}: ${what} (${JSON.stringify(hit[0].slice(0, 40))})`);
            }
        }
    }
    assert.ok(scanned > 200, `${scanned} files`);
    assert.deepEqual(problems, []);
});
