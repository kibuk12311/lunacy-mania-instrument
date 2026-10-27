// Electron utility process: osu! lazer's database read off the main thread (app/lazerRealm.js starts one per read), so
// realm's native module and a big database never sit in the main process. lazer's own client.realm is never opened:
// it is copied into a fresh folder of our own under tmpDir, the copy is opened read-only (realm writes .lock,
// .management and .note files next to the file it opens), dumped (src/lazer/realmDump.js), closed, and the folder removed.
// Messages: ← { realmPath, tmpDir }; → { dir } once that folder exists, then { ok: true, maps, scores, removed } or
// { ok: false, message, removed }; ← { bye: true } → it exits. Realm keeps the process alive, so it always exits itself.
// Under a plain child_process.fork (process.send) it works the same, so a test can run it for real.
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { dumpLazer } from "../src/lazer/realmDump.js";

const EXIT_WAIT_MS = 5_000; // after the answer, without a bye from the parent
const port = process.parentPort ?? null;
const post = (message) => (port ? port.postMessage(message) : process.send?.(message));
const onMessage = (fn) => (port ? port.on("message", (event) => fn(event?.data)) : process.on("message", fn));

// Copy, open, dump, close, clean up → the answer. Never throws: an error is the answer.
async function readCopy({ realmPath, tmpDir }) {
    let dir = null;
    let realm = null;
    let reply;
    try {
        if (typeof realmPath !== "string" || typeof tmpDir !== "string") throw new Error("realmPath and tmpDir are needed");
        await mkdir(tmpDir, { recursive: true });
        dir = await mkdtemp(path.join(tmpDir, "realm-"));
        post({ dir });
        const copy = path.join(dir, path.basename(realmPath));
        await copyFile(realmPath, copy);
        const { default: Realm } = await import("realm");
        // the sync constructor (Realm.open never settled in a test); no schema: the file's own
        realm = new Realm({ path: copy, readOnly: true });
        reply = { ok: true, ...dumpLazer({ beatmaps: realm.objects("Beatmap"), scores: realm.objects("Score") }) };
    } catch (error) {
        reply = { ok: false, message: String(error?.message ?? error) };
    }
    try {
        realm?.close();
    } catch {
        // closing is best effort: the process ends anyway
    }
    // realm may hold its files until the process is gone: the parent removes what is left once it exits
    reply.removed = !dir || (await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).then(() => true, () => false));
    return reply;
}

let started = false;
onMessage((data) => {
    if (data?.bye === true) process.exit(0);
    if (started || !data || typeof data !== "object") return;
    started = true;
    void readCopy(data).then((reply) => {
        post(reply);
        setTimeout(() => process.exit(0), EXIT_WAIT_MS);
    });
});
// a forked worker whose parent went away has nobody to answer
if (!port) process.on("disconnect", () => process.exit(0));
