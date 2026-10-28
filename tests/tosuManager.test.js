import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeTosuConfig, startTosu, TOSU_PORT } from "../app/tosuManager.js";
import { setLang } from "../src/i18n/i18n.js";

// every folder these tests make goes at the end: the fake tosu ones hold a ~90 MB copy of node.exe each
const made = [];
async function tempDir(prefix) {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    made.push(dir);
    return dir;
}
after(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))));

test("tosu config disables dashboard, autoupdate and pp", async () => {
    const dir = await tempDir("тосу ");
    const file = writeTosuConfig(dir);
    assert.equal(file, path.join(dir, "tosu.env"));
    const text = await readFile(file, "utf8");
    for (const line of [
        "OPEN_DASHBOARD_ON_STARTUP=false",
        "ENABLE_AUTOUPDATE=false",
        "CALCULATE_PP=false",
        "SERVER_IP=127.0.0.1",
        `SERVER_PORT=${TOSU_PORT}`,
        "ENABLE_INGAME_OVERLAY=false",
    ]) {
        assert.ok(text.split(/\r?\n/).includes(line), line);
    }
    assert.equal(TOSU_PORT, 24077);
});

test("missing tosu.exe reports through onExit instead of throwing", async () => {
    const dir = await tempDir("нет тосу ");
    const error = await new Promise((resolve) => {
        startTosu({ tosuDir: dir, onExit: resolve });
    });
    assert.ok(error instanceof Error);
    assert.match(error.message, /tosu/);
});

test("installTosu copies tosu out of a temp location and skips when up to date", async () => {
    const { mkdir, writeFile, readFile: read } = await import("node:fs/promises");
    const { installTosu } = await import("../app/tosuManager.js");
    const src = await tempDir("src тосу ");
    const dst = path.join(await tempDir("dst "), "tosu");
    await writeFile(path.join(src, "tosu.exe"), "v1");
    await writeFile(path.join(src, "VERSION"), "v4.26.3\n");
    await mkdir(path.join(src, "static"));
    await writeFile(path.join(src, "static", "a.txt"), "x");

    assert.equal(installTosu(src, dst), true);
    assert.equal(await read(path.join(dst, "tosu.exe"), "utf8"), "v1");
    assert.equal(await read(path.join(dst, "static", "a.txt"), "utf8"), "x");

    await writeFile(path.join(src, "tosu.exe"), "v2");
    assert.equal(installTosu(src, dst), false);
    assert.equal(await read(path.join(dst, "tosu.exe"), "utf8"), "v1");

    await writeFile(path.join(src, "VERSION"), "v4.27.0\n");
    assert.equal(installTosu(src, dst), true);
    assert.equal(await read(path.join(dst, "tosu.exe"), "utf8"), "v2");
});

async function fakeTosuDir() {
    const { copyFile } = await import("node:fs/promises");
    const dir = await tempDir("фейк тосу ");
    await copyFile(process.execPath, path.join(dir, "tosu.exe"));
    return dir;
}

test("tosu exiting on its own (even with code 0) is reported", async () => {
    const dir = await fakeTosuDir(); // node with stdin closed exits 0 at once
    const error = await new Promise((resolve) => startTosu({ tosuDir: dir, onExit: resolve }));
    assert.ok(error instanceof Error);
});

test("killOrphanTosu kills only a tosu.exe from our own folder", async () => {
    const { spawn } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const { killOrphanTosu } = await import("../app/tosuManager.js");
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

    const dir = await fakeTosuDir();
    const ours = spawn(path.join(dir, "tosu.exe"), ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
        writeFileSync(path.join(dir, "tosu.pid"), String(foreign.pid));
        assert.equal(killOrphanTosu(dir), false);
        assert.equal(alive(foreign.pid), true);

        writeFileSync(path.join(dir, "tosu.pid"), String(ours.pid));
        assert.equal(killOrphanTosu(dir), true);
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(alive(ours.pid), false);
    } finally {
        foreign.kill();
        ours.kill();
    }
});

test("isPortFree detects a busy port", async () => {
    const { createServer } = await import("node:net");
    const { isPortFree } = await import("../app/tosuManager.js");
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    assert.equal(await isPortFree(port), false);
    await new Promise((r) => server.close(r));
    assert.equal(await isPortFree(port), true);
});

test("a missing tosu.exe is reported in English when the app is in English", async () => {
    const dir = await tempDir("no tosu ");
    setLang("en");
    try {
        const error = await new Promise((resolve) => { startTosu({ tosuDir: dir, onExit: resolve }); });
        assert.equal(error.message, `tosu.exe not found: ${path.join(dir, "tosu.exe")}`);
    } finally {
        setLang("ru");
    }
});

test("a tosu failure is told again in the new language after a switch", async () => {
    const dir = await tempDir("no tosu ");
    const exe = path.join(dir, "tosu.exe");
    const error = await new Promise((resolve) => { startTosu({ tosuDir: dir, onExit: resolve }); });
    assert.equal(error.message, `tosu.exe не найден: ${exe}`);
    setLang("en");
    try {
        assert.equal(error.retell(), `tosu.exe not found: ${exe}`);
        assert.equal(error.message, `tosu.exe не найден: ${exe}`, "the message itself stays as it was made");
    } finally {
        setLang("ru");
    }
    assert.equal(error.retell(), `tosu.exe не найден: ${exe}`);
});

test("tosu exiting on its own can be told again in English", async () => {
    const dir = await fakeTosuDir(); // node with stdin closed exits 0 at once
    const error = await new Promise((resolve) => startTosu({ tosuDir: dir, onExit: resolve }));
    assert.ok(/^tosu /.test(error.message) && typeof error.retell === "function");
    setLang("en");
    try {
        assert.match(error.retell(), /^tosu (exited with code \d+|quit unexpectedly)$/);
    } finally {
        setLang("ru");
    }
});
