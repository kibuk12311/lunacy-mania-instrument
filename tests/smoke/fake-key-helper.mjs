// A stand-in for native/key-reader's key-reader.exe in the overlay smoke (tests/smoke/electron-overlay.mjs --kbd):
// the same protocol v1 on stdin / stdout, the same clock (QueryPerformanceCounter ms: Node's hrtime reads it too), but
// the presses come from a schedule file instead of the keyboard, so nothing real is ever heard.
// node fake-key-helper.mjs <schedule.json> <commands.log>
//   schedule.json: [{ vk, down: <hr ms>, up: <hr ms> }] — read again on every listen;
//   commands.log: the lines it was sent (listen, stop, sync, quit) with their hr time, and its pid first.
// Like the real one it reports only the keys of the last listen, a press at its own time; it writes them out in batches
// every 25 ms (as a busy pipe would), and exits when its stdin closes.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [scheduleFile, logFile] = process.argv.slice(2);
const hr = () => Number(process.hrtime.bigint()) / 1e6;
const out = (line) => process.stdout.write(`${line}\n`);
writeFileSync(logFile, `pid ${process.pid}\n`);

let listen = new Set();
let events = []; // { vk, down, at } not sent yet
const load = () => {
    try {
        events = JSON.parse(readFileSync(scheduleFile, "utf8"))
            .flatMap((p) => [{ vk: p.vk, down: true, at: p.down }, { vk: p.vk, down: false, at: p.up }])
            .filter((e) => e.at > hr())
            .sort((a, b) => a.at - b.at);
    } catch {
        events = [];
    }
};

out(`ready 1 ${hr().toFixed(3)} fake`);
createInterface({ input: process.stdin }).on("line", (line) => {
    appendFileSync(logFile, `${hr().toFixed(3)} ${line}\n`);
    const [w, a] = line.trim().split(" ");
    if (w === "listen" && a) {
        listen = new Set(a.split(",").map(Number));
        load();
        out(`listening ${listen.size}`);
    } else if (w === "listen" || w === "stop") {
        listen = new Set();
        events = [];
        out("stopped");
    } else if (w === "sync") {
        out(`t ${a} ${hr().toFixed(3)}`);
    } else if (w === "quit") {
        process.exit(0);
    }
}).on("close", () => process.exit(0));

setInterval(() => {
    const now = hr();
    const due = [];
    while (events.length && events[0].at <= now) due.push(events.shift());
    const lines = due.filter((e) => listen.has(e.vk)).map((e) => `${e.down ? "d" : "u"} ${e.vk} ${e.at.toFixed(3)}`);
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
}, 25);
