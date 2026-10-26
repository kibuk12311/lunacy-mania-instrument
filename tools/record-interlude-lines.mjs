// Records interlude-reader's JSON lines against the fake Interlude (native/interlude-reader/out/fake, built by
// build.ps1) into tests/fixtures/interlude-reader-lines.json, for the app's unit tests: attach, level select with
// chart A then B at 1.25×, a play of B (about 2.5 s, events and keys), a retry, the score screen, the game closing
// (waiting), plus a field_not_found line (the renamed fixture) and a dac_not_found line. No real game is involved.
//   node tools/record-interlude-lines.mjs
import { spawn, execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "native", "interlude-reader", "out");
const READER = path.join(OUT, "reader", "interlude-reader.exe");
const FAKE = path.join(OUT, "fake", "FakeInterlude.exe");
const FAKE_RENAMED = path.join(OUT, "fake-renamed", "FakeInterlude.exe");
for (const f of [READER, FAKE, FAKE_RENAMED]) if (!existsSync(f)) throw new Error(`missing ${f}: run native/interlude-reader/build.ps1`);
export const CHART_A = "hashA|Freedom Dive|xi|4K Another|Mapper One|4|258000|222|6.75";
export const CHART_B = "hashB|Blue Zenith|xi|4K Insane|Mapper Two|4|100000|200|5.25";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function proc(exe, args = []) {
    const p = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] });
    const lines = [];
    let buf = "";
    p.stdout.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, "");
            buf = buf.slice(i + 1);
            lines.push({ at: Date.now(), line });
        }
    });
    p.stderr.on("data", () => {});
    const waitFor = async (pred, ms = 15000) => {
        for (let w = 0; w < ms; w += 50) {
            const hit = lines.find((l) => pred(l.line));
            if (hit) return hit;
            await sleep(50);
        }
        throw new Error(`timeout waiting in ${path.basename(exe)}`);
    };
    return { p, lines, waitFor, send: (c) => p.stdin.write(`${c}\n`) };
}

async function main() {
    const fake = proc(FAKE);
    await fake.waitFor((l) => l.startsWith("ready"));
    const reader = proc(READER, ["--name", "FakeInterlude"]);
    await reader.waitFor((l) => l.includes('"attached"'));
    const cmd = async (c) => {
        const n = fake.lines.length;
        fake.send(c);
        for (let w = 0; w < 5000 && !fake.lines.slice(n).some((l) => l.line === `ok ${c}`); w += 20) await sleep(20);
    };
    await cmd("screen levelselect");
    await cmd(`select ${CHART_A}`);
    await reader.waitFor((l) => l.includes('"hashA"'));
    await sleep(400);
    await cmd(`select ${CHART_B}`);
    await reader.waitFor((l) => l.includes('"hashB"'));
    await cmd("rate 1.25");
    await reader.waitFor((l) => l.includes('"rate":1.25'));
    await cmd("mods mirror=0");
    await sleep(500);
    await cmd("play");
    await sleep(2500);
    await cmd("retry");
    await sleep(1200);
    await cmd("screen score");
    await sleep(600);
    await cmd("screen levelselect");
    await sleep(600);
    fake.p.kill();
    await reader.waitFor((l) => l.includes('"waiting"'), 8000)
        .catch((error) => { console.log(reader.lines.slice(-3).map((l) => l.line.slice(0, 300))); throw error; });
    reader.p.stdin.end();
    await sleep(300);
    reader.p.kill();

    // a renamed field: one error line, the rest still read
    const renamed = proc(FAKE_RENAMED);
    await renamed.waitFor((l) => l.startsWith("ready"));
    const r2 = proc(READER, ["--pid", String(renamed.p.pid)]);
    await r2.waitFor((l) => l.includes('"attached"'));
    renamed.send("screen levelselect");
    await sleep(200);
    renamed.send(`select ${CHART_A}`);
    const fieldError = (await r2.waitFor((l) => l.includes("field_not_found"))).line;
    let dacError = null;
    try {
        execFileSync(READER, ["--pid", String(renamed.p.pid), "--dac", "C:\\nope\\mscordaccore.dll", "--once"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
        dacError = String(error.stdout ?? "").trim().split(/\r?\n/)[0];
    }
    r2.p.stdin.end();
    renamed.p.kill();
    await sleep(300);
    r2.p.kill();

    const t0 = reader.lines[0].at;
    const out = {
        note: "Recorded by tools/record-interlude-lines.mjs from interlude-reader against the fake Interlude (no real game). at = ms since the first line.",
        session: reader.lines.filter((l) => l.line.startsWith("{")).map((l) => ({ at: l.at - t0, line: l.line })),
        fieldError,
        dacError,
    };
    const file = path.join(root, "tests", "fixtures", "interlude-reader-lines.json");
    writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`${out.session.length} lines → ${file}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
