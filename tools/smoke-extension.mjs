// End-to-end smoke test of the extension in a real headless Chrome or Edge (extension/DESIGN.md §6):
//   node tools/smoke-extension.mjs [--browser chrome|edge|<exe>] [--tmp <dir>] [--live] [--keep] [--timeout <s>]
// Exit 0 pass, 1 fail, 3 skip (no browser or no openssl). Builds the extension, makes a throwaway self-signed
// certificate, serves a fake osu! site (tests/extension/fixtures/site/) on 127.0.0.1 that the browser reaches as
// osu.ppy.sh, b.ppy.sh and bm1.ppy.sh, loads the unpacked build through the DevTools pipe (Extensions.loadUnpacked:
// branded Chrome ignores --load-extension) into a temporary profile, and checks the panel, the dans (equal to Node's
// analyzeChart of the same .osu), the rates, the player (preview, keys, results, Esc), the full-map download without
// and with an osu! session cookie, and a Turbo visit. Screenshots go to <tmp>/shots/. Always closes the browser and
// removes the profile (unless --keep).
// --live (opt-in, best effort): the real https://osu.ppy.sh/beatmapsets/2316993#mania/4961226 without the fake site;
// a Cloudflare challenge is a skip. It makes a handful of requests (the page and its .osu files through the
// extension, one .osu for the comparison) and never the download.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildExtension } from "./build-extension.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXIT = { PASS: 0, FAIL: 1, SKIP: 3 };
const HOSTS = ["osu.ppy.sh", "b.ppy.sh", "bm1.ppy.sh"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// what the hard timeout runs before it exits: kill the browser, stop the fake site
let emergency = () => {};

function parseArgs(argv) {
    const args = { browser: null, tmp: null, live: false, keep: false, timeout: 180 };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--browser") args.browser = argv[++i];
        else if (a === "--tmp") args.tmp = path.resolve(argv[++i]);
        else if (a === "--live") args.live = true;
        else if (a === "--keep") args.keep = true;
        else if (a === "--timeout") args.timeout = Number(argv[++i]);
        else throw new Error(`unknown argument ${a}`);
    }
    return args;
}

const CANDIDATES = {
    chrome: [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    ],
    edge: [
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable",
    ],
};
const local = (p) => (process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, p)] : []);

export function findBrowser(choice) {
    if (choice && choice !== "chrome" && choice !== "edge") return existsSync(choice) ? choice : null;
    const lists = choice ? [choice] : ["chrome", "edge"];
    for (const name of lists) {
        const extra = name === "chrome" ? local("Google/Chrome/Application/chrome.exe") : local("Microsoft/Edge/Application/msedge.exe");
        const found = [...CANDIDATES[name], ...extra].find((p) => existsSync(p));
        if (found) return found;
    }
    return null;
}

export function findOpenssl() {
    const tries = ["openssl", "C:/Program Files/Git/usr/bin/openssl.exe", "C:/Program Files/Git/mingw64/bin/openssl.exe"];
    for (const exe of tries) {
        const r = spawnSync(exe, ["version"], { encoding: "utf8", windowsHide: true });
        if (r.status === 0 && /OpenSSL/i.test(r.stdout)) return exe;
    }
    return null;
}

async function makeCert(openssl, dir) {
    await mkdir(dir, { recursive: true });
    const config = [
        "[req]", "distinguished_name = dn", "prompt = no", "x509_extensions = v3",
        "[dn]", "CN = osu.ppy.sh",
        "[v3]", `subjectAltName = ${HOSTS.map((h) => `DNS:${h}`).join(",")}`, "basicConstraints = CA:FALSE",
        "keyUsage = digitalSignature,keyEncipherment", "extendedKeyUsage = serverAuth", "",
    ].join("\n");
    await writeFile(path.join(dir, "openssl.cnf"), config);
    const r = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", path.join(dir, "openssl.cnf"),
        "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
    const { readFile } = await import("node:fs/promises");
    return { key: await readFile(path.join(dir, "key.pem")), cert: await readFile(path.join(dir, "cert.pem")) };
}

// The DevTools protocol over --remote-debugging-pipe: NUL-terminated JSON, commands on fd 3, answers on fd 4.
class Cdp {
    constructor(child) {
        this.out = child.stdio[3];
        this.id = 0;
        this.waiting = new Map();
        this.listeners = new Set();
        let buffer = "";
        child.stdio[4].on("data", (data) => {
            buffer += data.toString("utf8");
            let at;
            while ((at = buffer.indexOf("\0")) >= 0) {
                const message = JSON.parse(buffer.slice(0, at));
                buffer = buffer.slice(at + 1);
                if (message.id && this.waiting.has(message.id)) {
                    this.waiting.get(message.id)(message);
                    this.waiting.delete(message.id);
                } else for (const fn of this.listeners) fn(message);
            }
        });
    }
    send(method, params = {}, sessionId = undefined, timeoutMs = 30_000) {
        return new Promise((resolve, reject) => {
            const id = (this.id += 1);
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error(`CDP ${method} timed out`));
            }, timeoutMs);
            this.waiting.set(id, (message) => {
                clearTimeout(timer);
                if (message.error) reject(new Error(`CDP ${method}: ${message.error.message}`));
                else resolve(message.result);
            });
            this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
        });
    }
}

async function evaluate(cdp, session, expression) {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
}

async function waitFor(what, fn, { timeout = 30_000, every = 250 } = {}) {
    const until = Date.now() + timeout;
    let last;
    for (;;) {
        try {
            last = await fn();
            if (last) return last;
        } catch (error) {
            last = error;
        }
        if (Date.now() > until) throw new Error(`waited ${Math.round(timeout / 1000)} s for ${what}${last instanceof Error ? ` (${last.message})` : ""}`);
        await sleep(every);
    }
}

// what the panel shows, read from its open shadow root (the page lane's test hooks, DESIGN §5.7)
const PANEL = `(() => {
    const hosts = document.querySelectorAll("[data-lm-root]");
    const host = hosts[0];
    if (!host || !host.shadowRoot) return { hosts: hosts.length };
    const root = host.shadowRoot;
    const chip = (c) => ({ id: Number(c.getAttribute("data-beatmap-id")), state: c.getAttribute("data-state"), numeric: c.getAttribute("data-numeric"),
        label: (c.querySelector("[data-lm-label]") || c).textContent.trim(), current: c.getAttribute("aria-current") === "true" });
    const row = (r) => ({ rate: r.getAttribute("data-rate"), state: r.getAttribute("data-state"), numeric: r.getAttribute("data-numeric") });
    const card = root.querySelector("[data-lm-card]");
    return { hosts: hosts.length, setId: Number(host.getAttribute("data-set-id")), state: host.getAttribute("data-lm-state"),
        chips: [...root.querySelectorAll("[data-lm-chip]")].map(chip), card: card ? Number(card.getAttribute("data-beatmap-id")) : null,
        rows: [...root.querySelectorAll("[data-lm-rate-row]")].map(row),
        actions: [...root.querySelectorAll("[data-lm-action]")].map((b) => b.getAttribute("data-lm-action")),
        player: !!document.querySelector("iframe[data-lm-player]") };
})()`;
const clickInPanel = (selector) => `(() => { const el = document.querySelector("[data-lm-root]")?.shadowRoot?.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
const FINAL = new Set(["ok", "not-rice", "too-short", "error"]);

const KEYS = {
    Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    KeyD: { key: "d", code: "KeyD", windowsVirtualKeyCode: 68, text: "d" },
    KeyF: { key: "f", code: "KeyF", windowsVirtualKeyCode: 70, text: "f" },
    KeyJ: { key: "j", code: "KeyJ", windowsVirtualKeyCode: 74, text: "j" },
    KeyK: { key: "k", code: "KeyK", windowsVirtualKeyCode: 75, text: "k" },
};
async function press(cdp, session, name, holdMs = 30) {
    const k = KEYS[name];
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...k }, session);
    if (holdMs) await sleep(holdMs);
    const { text, ...up } = k;
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...up }, session);
}

export async function runSmoke(args) {
    const browser = findBrowser(args.browser);
    if (!browser) return { code: EXIT.SKIP, reason: "no Chrome or Edge found" };
    const openssl = args.live ? null : findOpenssl();
    if (!args.live && !openssl) return { code: EXIT.SKIP, reason: "no openssl found" };

    const tmp = args.tmp ?? (await mkdtemp(path.join(tmpdir(), "lm-smoke-")));
    await mkdir(tmp, { recursive: true });
    const profile = await mkdtemp(path.join(tmp, "profile-"));
    const shots = path.join(tmp, "shots");
    await mkdir(shots, { recursive: true });
    const results = [];
    let child = null;
    let cdp = null;
    let site = null;
    let shotNo = 0;
    let page = null;

    emergency = () => {
        try {
            child?.kill();
        } catch {
            // gone
        }
        site?.close().catch(() => {});
    };
    const check = (name, ok, detail = "") => {
        results.push({ name, ok: !!ok, detail });
        console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
        return !!ok;
    };
    const shot = async (name) => {
        if (!cdp || !page) return;
        try {
            const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, page);
            shotNo += 1;
            await writeFile(path.join(shots, `${String(shotNo).padStart(2, "0")}-${name}.png`), Buffer.from(data, "base64"));
        } catch {
            // a screenshot is a nicety
        }
    };

    const cleanup = async () => {
        try {
            if (cdp) await cdp.send("Browser.close", {}, undefined, 3000).catch(() => {});
        } catch {
            // closing anyway
        }
        if (child && child.exitCode === null) {
            await Promise.race([new Promise((r) => child.once("exit", r)), sleep(3000)]);
            try {
                child.kill();
            } catch {
                // gone
            }
        }
        await site?.close().catch(() => {});
        if (!args.keep) {
            for (let i = 0; i < 5; i += 1) {
                try {
                    await rm(profile, { recursive: true, force: true });
                    break;
                } catch {
                    await sleep(500);
                }
            }
        }
    };

    try {
        console.log(`browser: ${path.basename(browser)}; work folder: ${tmp}`);
        const built = await buildExtension({ out: path.join(tmp, "build"), targets: ["chrome"] });
        const extDir = built.targets.chrome;
        check("build", !built.warnings.length, built.warnings.join("; ") || `${built.files} files, analyzer ${built.fingerprint}`);

        const flags = ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
            "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
            "--disable-background-networking", "--disable-component-update", "--disable-sync", "--window-size=1280,900"];
        if (!args.live) {
            site = await (await import(pathToFileURL(path.join(ROOT, "tests/extension/fixtures/site/server.mjs")).href)).startFixtureSite(await makeCert(openssl, path.join(tmp, "cert")));
            const rules = [...HOSTS.map((h) => `MAP ${h} 127.0.0.1:${site.port}`), "MAP * ~NOTFOUND"].join(",");
            flags.push(`--host-resolver-rules=${rules}`, "--ignore-certificate-errors");
        }
        child = spawn(browser, [...flags, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
        child.on("error", () => {});
        cdp = new Cdp(child);
        const version = await cdp.send("Browser.getVersion");
        console.log(`${version.product}`);
        const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: extDir });
        check("extension loaded", !!extId, extId);
        const extOrigin = `chrome-extension://${extId}`;

        const { analyzeChart } = await import(pathToFileURL(path.join(ROOT, "src/core/analyze.js")).href);
        const attach = async (targetId) => (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;

        if (args.live) return await live({ cdp, attach, check, shot, analyzeChart, setPage: (s) => (page = s) }, results, cleanup);

        const [set1, set2] = site.sets;
        const diffs = set1.diffs.map((d) => d.json);
        const fourK = diffs.filter((b) => b.mode === "mania" && !b.convert && b.cs === 4).sort((a, b) => a.difficulty_rating - b.difficulty_rating);
        const [dA, dB, dLn] = fourK;
        const osuOf = (id) => [...set1.diffs, ...set2.diffs].find((d) => d.json.id === id).osu;
        const expected = new Map();
        for (const d of [dA, dB, dLn, set2.diffs[0].json]) expected.set(`${d.id}@1`, await analyzeChart(osuOf(d.id), 1));
        expected.set(`${dB.id}@1.2`, await analyzeChart(osuOf(dB.id), 1.2));

        const { targetId } = await cdp.send("Target.createTarget", { url: `https://osu.ppy.sh/beatmapsets/${set1.id}#mania/${dA.id}` });
        page = await attach(targetId);
        await cdp.send("Page.enable", {}, page);
        const panel = () => evaluate(cdp, page, PANEL);

        // 1. chips for the 4K mania diffs only, all final, dans equal to Node's
        const first = await waitFor("every chip final", async () => {
            const p = await panel();
            return p.chips?.length && p.chips.every((c) => FINAL.has(c.state)) ? p : null;
        }, { timeout: 60_000 });
        await shot("panel");
        check("chips only for the 4K mania diffs, in picker order", JSON.stringify(first.chips.map((c) => c.id)) === JSON.stringify(fourK.map((d) => d.id)),
            first.chips.map((c) => `${c.id}:${c.state}`).join(" "));
        check("panel ready", first.state === "ready" && first.setId === set1.id, `${first.state} ${first.setId}`);
        for (const d of [dA, dB]) {
            const c = first.chips.find((x) => x.id === d.id);
            const want = expected.get(`${d.id}@1`);
            check(`dan of ${d.version} equals Node's analyzeChart`, c && c.state === "ok" && Number(c.numeric) === want.numeric && c.label.includes(want.label),
                `${c?.label} ${c?.numeric} vs ${want.label} ${want.numeric}`);
        }
        const lnChip = first.chips.find((x) => x.id === dLn.id);
        check("the LN-heavy diff is not-rice", lnChip?.state === "not-rice" && expected.get(`${dLn.id}@1`).kind === "not-rice", lnChip?.state);
        check("the selected chip follows the hash", first.chips.find((c) => c.current)?.id === dA.id && first.card === dA.id, `card ${first.card}`);

        // 2. a click on the second picker anchor moves the card (replaceState, no event)
        await evaluate(cdp, page, `document.querySelectorAll("a.beatmapset-beatmap-picker__beatmap")[1].click(), true`);
        const moved = await waitFor("the card on the second diff", async () => ((await panel()).card === dB.id ? true : null), { timeout: 10_000 }).catch(() => false);
        check("picking another diff in osu!'s picker moves the card", moved, `card ${(await panel()).card}`);
        await shot("second-diff");

        // 3. rates: 15 rows, 1.2× equals Node
        await evaluate(cdp, page, clickInPanel("[data-lm-rates-toggle]"));
        const rates = await waitFor("15 final rate rows", async () => {
            const p = await panel();
            return p.rows.length === 15 && p.rows.every((r) => FINAL.has(r.state)) ? p.rows : null;
        }, { timeout: 90_000 }).catch(() => null);
        const r12 = rates?.find((r) => r.rate === "1.2");
        check("rates: 15 rows", rates?.length === 15, rates ? rates.map((r) => `${r.rate}:${r.numeric ?? r.state}`).join(" ") : "not there");
        check("rate 1.2× equals Node's analyzeChart at 1.2", r12 && Number(r12.numeric) === expected.get(`${dB.id}@1.2`).numeric,
            `${r12?.numeric} vs ${expected.get(`${dB.id}@1.2`).numeric}`);
        await shot("rates");

        // 4. the player: preview → ready → Space → keys → results → Esc
        const findPlayer = async () => (await cdp.send("Target.getTargets")).targetInfos
            .find((t) => t.type === "iframe" && t.url.startsWith(`${extOrigin}/player/player.html`));
        const openPlayer = async (action) => {
            await evaluate(cdp, page, clickInPanel(`[data-lm-action="${action}"]`));
            await waitFor("the player iframe", async () => (await panel()).player, { timeout: 10_000 });
            const target = await waitFor("the player's target", findPlayer, { timeout: 15_000 });
            return attach(target.targetId);
        };
        const playerState = (s) => evaluate(cdp, s, `({ state: document.documentElement.dataset.lmPlayer, error: document.documentElement.dataset.lmError ?? null, wait: document.documentElement.dataset.lmWait ?? null, stats: document.documentElement.dataset.lmStats ?? null })`);
        const closePlayer = async (s) => {
            await press(cdp, s, "Escape").catch(() => {});
            return waitFor("the player closed", async () => !(await panel()).player, { timeout: 8_000 }).catch(() => false);
        };

        let player = await openPlayer("play-preview");
        const ready = await waitFor("player ready", async () => ((await playerState(player)).state === "ready" ? true : null), { timeout: 30_000 }).catch(() => false);
        check("preview: the player reaches ready", ready, JSON.stringify(await playerState(player)));
        await shot("player-ready");
        await press(cdp, player, "Space");
        const playing = await waitFor("playing", async () => ((await playerState(player)).state === "playing" ? true : null), { timeout: 10_000 }).catch(() => false);
        check("Space starts the demo", playing, (await playerState(player)).state);
        const lanes = ["KeyD", "KeyF", "KeyJ", "KeyK"];
        for (let i = 0; i < 400; i += 1) {
            const s = await playerState(player);
            if (s.state !== "playing" && s.state !== "countdown") break;
            await press(cdp, player, lanes[i % 4], 20);
            await sleep(25);
            if (i === 60) await shot("playing");
        }
        const done = await waitFor("results", async () => ((await playerState(player)).state === "results" ? true : null), { timeout: 30_000 }).catch(() => false);
        const after = await playerState(player);
        const stats = after.stats ? JSON.parse(after.stats) : null;
        const judged = stats ? stats.max + stats.n300 + stats.n200 + stats.n100 + stats.n50 + stats.miss : 0;
        check("D F J K are judged", judged > 0, after.stats ?? "no stats");
        check("the demo ends on the results", done, after.state);
        await shot("results");
        check("Esc closes the player", await closePlayer(player));

        // 5. the full map without an osu! session: osu! answers with the set's page → login
        player = await openPlayer("play-full");
        await waitFor("the download offer", async () => ((await playerState(player)).wait === "download" ? true : null), { timeout: 15_000 }).catch(() => false);
        await evaluate(cdp, player, `(() => { const b = document.querySelector('[data-lm-action="download"]'); if (b) b.click(); return !!b; })()`);
        const login = await waitFor("the login error", async () => ((await playerState(player)).error === "login" ? true : null), { timeout: 20_000 }).catch(() => false);
        check("full map without login → lmError login", login, JSON.stringify(await playerState(player)));
        await shot("full-login");
        await closePlayer(player);

        // 6. with the cookie osu_session=smoke: the download is followed to bm1.ppy.sh and the player gets ready
        await cdp.send("Storage.setCookies", { cookies: [{ name: "osu_session", value: "smoke", domain: ".ppy.sh", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }] });
        player = await openPlayer("play-full");
        await waitFor("the download offer", async () => ((await playerState(player)).wait === "download" ? true : null), { timeout: 15_000 }).catch(() => false);
        await evaluate(cdp, player, `(() => { const b = document.querySelector('[data-lm-action="download"]'); if (b) b.click(); return !!b; })()`);
        const fullReady = await waitFor("ready on the full map", async () => {
            const s = await playerState(player);
            return s.state === "ready" ? true : s.state === "error" ? Promise.reject(new Error(s.error)) : null;
        }, { timeout: 40_000 }).catch((e) => e);
        check("full map with an osu! session → ready", fullReady === true, fullReady === true ? "" : String(fullReady?.message ?? fullReady));
        await shot("full-ready");
        await closePlayer(player);

        // 7. a Turbo visit: the old panel goes, the new set's chips come
        await evaluate(cdp, page, `window.fakeTurboVisit("/beatmapsets/${set2.id}")`);
        const second = await waitFor("the second set's panel", async () => {
            const p = await panel();
            return p.setId === set2.id && p.chips?.length && p.chips.every((c) => FINAL.has(c.state)) ? p : null;
        }, { timeout: 40_000 }).catch(() => null);
        const want2 = expected.get(`${set2.diffs[0].json.id}@1`);
        check("Turbo visit: one panel, the new set's chip", second && second.hosts === 1 && second.chips.length === 1 && second.chips[0].id === set2.diffs[0].json.id,
            second ? `${second.hosts} host(s), chips ${second.chips.map((c) => c.id)}` : "no panel");
        check("Turbo visit: its dan equals Node's", second && Number(second.chips[0].numeric) === want2.numeric, `${second?.chips[0]?.numeric} vs ${want2.numeric}`);
        await shot("turbo");

        // 8. the network: only osu!'s three hosts, the cookie only where it belongs
        const hosts = [...new Set(site.log.map((l) => l.host))].sort();
        check("the fake site saw only osu.ppy.sh, b.ppy.sh, bm1.ppy.sh", hosts.every((h) => HOSTS.includes(h)), hosts.join(", "));
        const osuWithCookie = site.log.filter((l) => /^\/osu\//.test(l.path) && l.cookie).length;
        const previewWithCookie = site.log.filter((l) => l.host === "b.ppy.sh" && l.cookie).length;
        check(".osu and preview requests carry no cookie", osuWithCookie === 0 && previewWithCookie === 0, `${osuWithCookie} .osu, ${previewWithCookie} preview`);
        console.log(`requests: ${site.log.length} (${site.log.filter((l) => l.path.startsWith("/osu/")).length} .osu)`);
    } catch (error) {
        check("smoke run", false, String(error?.stack ?? error));
    } finally {
        await shot("last");
        await cleanup();
    }
    const failed = results.filter((r) => !r.ok);
    return { code: failed.length ? EXIT.FAIL : EXIT.PASS, results, tmp };
}

async function live({ cdp, attach, check, shot, analyzeChart, setPage }, results, cleanup) {
    const SET = 2316993;
    const MAP = 4961226;
    try {
        const { targetId } = await cdp.send("Target.createTarget", { url: `https://osu.ppy.sh/beatmapsets/${SET}#mania/${MAP}` });
        const page = await attach(targetId);
        setPage(page);
        await sleep(4000);
        const title = await evaluate(cdp, page, "document.title");
        const challenged = /just a moment|attention required/i.test(title) || await evaluate(cdp, page, `!!document.querySelector("#challenge-form, #cf-challenge-running, [name='cf-turnstile-response']")`);
        if (challenged) {
            console.log(`live: Cloudflare challenge ("${title}") — skipped`);
            return { code: EXIT.SKIP, reason: "Cloudflare challenge", results };
        }
        const chip = await waitFor(`the chip of ${MAP}`, async () => {
            const p = await evaluate(cdp, page, PANEL);
            const c = p.chips?.find((x) => x.id === MAP);
            return c && FINAL.has(c.state) ? c : null;
        }, { timeout: 90_000 });
        await shot("live");
        const response = await fetch(`https://osu.ppy.sh/osu/${MAP}`);
        const want = await analyzeChart(await response.text(), 1);
        check(`live: ${MAP} equals Node's analyzeChart`, Number(chip.numeric) === want.numeric && chip.label.includes(want.label), `${chip.label} ${chip.numeric} vs ${want.label} ${want.numeric}`);
    } catch (error) {
        check("live run", false, String(error?.message ?? error));
    } finally {
        await cleanup();
    }
    return { code: results.some((r) => !r.ok) ? EXIT.FAIL : EXIT.PASS, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exit(EXIT.FAIL);
    }
    const hard = setTimeout(() => {
        console.error(`smoke: hard timeout of ${args.timeout} s`);
        emergency();
        setTimeout(() => process.exit(EXIT.FAIL), 1000);
    }, args.timeout * 1000);
    const outcome = await runSmoke(args).catch((error) => ({ code: EXIT.FAIL, reason: String(error?.stack ?? error) }));
    clearTimeout(hard);
    if (outcome.reason) console.log(`smoke: ${outcome.code === EXIT.SKIP ? "skip" : "fail"} — ${outcome.reason}`);
    const passed = outcome.results?.filter((r) => r.ok).length ?? 0;
    const total = outcome.results?.length ?? 0;
    console.log(`smoke: ${outcome.code === EXIT.PASS ? "PASS" : outcome.code === EXIT.SKIP ? "SKIP" : "FAIL"} (${passed}/${total} checks)`);
    process.exit(outcome.code);
}
