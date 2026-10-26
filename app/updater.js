// Updates from the GitHub Releases of kibuk12311/lunacy-mania-instrument. main.js only wires this; Electron and
// electron-updater come in as deps, so the flows run in tests with fakes.
//  - installed (NSIS) build: electron-updater checks, downloads in the background and asks once to restart; «Later»
//    installs on quit (autoInstallOnAppQuit).
//  - portable build: electron-updater can't replace a portable exe, so the latest release's tag is compared with our
//    version and a newer one offers its release page.
//  - dev run (not packaged): no automatic check.
// The automatic check (10 s after start, then again every 4 hours while the app runs, each time only if the tray
// setting is on) tells nothing unless there is an update: offline, no release yet, 404 or a rate limit only go to the
// log, and a portable release already offered by an automatic check is not offered again. A check from the tray tells
// every outcome.

export const REPO = "kibuk12311/lunacy-mania-instrument";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
export const AUTO_CHECK_DELAY_MS = 10_000;
export const RECHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

// "v0.8.0", "0.8.0-beta.2+build" → { core: [0, 8, 0], pre: ["beta", 2] }; anything else → null.
export function parseVersion(text) {
    const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
        .exec(String(text ?? "").trim());
    if (!m) return null;
    const pre = m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

// Semver precedence: -1, 0 or 1; null when either side isn't a version. A prerelease sorts below its release,
// numeric identifiers below text ones, and a longer prerelease above its prefix (1.0.0-a < 1.0.0-a.1 < 1.0.0).
export function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i += 1) {
        const [p, q] = [x.pre[i], y.pre[i]];
        if (p === q) continue;
        if (typeof p !== typeof q) return typeof p === "number" ? -1 : 1;
        return p < q ? -1 : 1;
    }
    return x.pre.length === y.pre.length ? 0 : x.pre.length < y.pre.length ? -1 : 1;
}

// electron-builder's portable exe sets these for the app it unpacks to %TEMP%.
export const isPortableRun = (env) => Boolean(env?.PORTABLE_EXECUTABLE_FILE || env?.PORTABLE_EXECUTABLE_DIR);

export function updateMode({ packaged, portable }) {
    if (!packaged) return "dev";
    return portable ? "portable" : "installed";
}

// Only an https page of our own repo on github.com is opened; anything else in the answer falls back to the fixed page.
export function releasePage(htmlUrl) {
    try {
        const url = new URL(String(htmlUrl));
        if (url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password
            && url.pathname.startsWith(`/${REPO}/`)) return url.href;
    } catch {
        // not a URL
    }
    return RELEASES_PAGE;
}

const shown = (version) => String(version).replace(/^v/, "");
const firstLine = (error) => String(error?.message ?? error ?? "unknown error").split("\n")[0].slice(0, 300);

// deps: mode ("installed" | "portable" | "dev", see updateMode), version (ours), loadAutoUpdater: async () → the
// electron-updater autoUpdater (loaded on first use, so dev and portable runs never load it), dialog (Electron's),
// window: () → the window to put dialogs over or null, openExternal(url), fetch, log, t, autoCheck: () → the tray setting,
// schedule (setTimeout), delayMs, repeat (setInterval), everyMs.
// → { start, check, state }; check({ manual }) resolves to what came out: "dev" | "latest" | "checking" | "downloading" |
// "ready" | "available" | "error".
export function createUpdater({
    mode, version, loadAutoUpdater, dialog, window = () => null, openExternal, fetch, log, t,
    autoCheck = () => true, schedule = setTimeout, delayMs = AUTO_CHECK_DELAY_MS, repeat = setInterval, everyMs = RECHECK_EVERY_MS,
}) {
    let phase = "idle"; // installed: idle → checking → downloading → ready
    let manual = false; // the running check was asked for from the tray, so its outcome is told
    let found = null; // the version being downloaded or downloaded
    let asked = false; // the restart question was put once by itself
    let updater = null;
    let portableBusy = false;
    const offered = new Set(); // portable: release tags already offered by an automatic check this run

    async function box(options) {
        const parent = window();
        const full = { title: t("app.update.title"), noLink: true, ...options };
        const { response } = await (parent && !parent.isDestroyed?.() ? dialog.showMessageBox(parent, full) : dialog.showMessageBox(full));
        return response;
    }
    const tell = (message, { type = "info", detail } = {}) => box({ type, message, detail, buttons: [t("app.update.ok")] })
        .catch((error) => log(`updater: dialog failed: ${firstLine(error)}`));
    const failed = (error) => tell(t("app.update.failed"), { type: "warning", detail: firstLine(error) });
    // true once per tray check: the first outcome to arrive (event or rejection) tells it, the rest stay quiet
    const takeManual = () => {
        const was = manual;
        manual = false;
        return was;
    };

    async function askRestart() {
        const response = await box({
            type: "info",
            message: t("app.update.ready", { version: shown(found) }),
            detail: t("app.update.readyDetail"),
            buttons: [t("app.update.restart"), t("app.update.later")],
            defaultId: 0, cancelId: 1,
        }).catch((error) => {
            log(`updater: dialog failed: ${firstLine(error)}`);
            return 1;
        });
        if (response === 0) {
            log(`updater: restarting to install ${found}`);
            updater.quitAndInstall(true, true); // silent, and the app starts again after it
        } else {
            log(`updater: ${found} installs on quit`);
        }
    }

    async function wire() {
        if (updater) return updater;
        const u = await loadAutoUpdater();
        u.autoDownload = true;
        u.autoInstallOnAppQuit = true;
        u.logger = {
            info: (m) => log(`updater: ${m}`), warn: (m) => log(`updater warn: ${m}`),
            error: (m) => log(`updater error: ${firstLine(m)}`), debug: () => {},
        };
        u.on("update-available", (info) => {
            phase = "downloading";
            found = info?.version ?? found;
            if (takeManual()) void tell(t("app.update.downloading", { version: shown(found) }));
        });
        u.on("update-not-available", () => {
            phase = "idle";
            if (takeManual()) void tell(t("app.update.upToDate", { version }));
        });
        u.on("update-downloaded", (info) => {
            phase = "ready";
            found = info?.version ?? found;
            takeManual();
            if (asked) return;
            asked = true;
            void askRestart();
        });
        u.on("error", (error) => {
            phase = phase === "ready" ? "ready" : "idle";
            log(`updater: ${firstLine(error)}`);
            if (takeManual()) void failed(error);
        });
        updater = u;
        return u;
    }

    async function checkInstalled(fromTray) {
        if (phase === "ready") {
            if (fromTray) await askRestart();
            return "ready";
        }
        if (phase === "downloading") {
            if (fromTray) await tell(t("app.update.downloading", { version: shown(found) }));
            return "downloading";
        }
        if (phase === "checking") {
            manual ||= fromTray;
            return "checking";
        }
        phase = "checking";
        manual = fromTray;
        try {
            const u = await wire();
            const result = await u.checkForUpdates();
            result?.downloadPromise?.catch(() => {}); // a failed download comes as an "error" event
            if (phase === "checking") phase = "idle"; // null result: the updater is off
            return phase === "idle" ? "latest" : phase;
        } catch (error) {
            if (phase === "checking") phase = "idle";
            log(`updater: check failed: ${firstLine(error)}`);
            if (takeManual()) await failed(error);
            return "error";
        }
    }

    async function checkPortable(fromTray) {
        if (portableBusy) return "checking";
        portableBusy = true;
        try {
            const res = await fetch(LATEST_RELEASE_API, {
                headers: { accept: "application/vnd.github+json", "user-agent": `lunacy-mania/${version}` },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            // no release yet: what we have is the latest there is
            if (res.status === 404) {
                log("updater: no release on GitHub yet");
                if (fromTray) await tell(t("app.update.upToDate", { version }));
                return "latest";
            }
            if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
            const release = await res.json();
            const tag = release && !release.draft && !release.prerelease ? release.tag_name : null;
            if (!(compareVersions(tag, version) > 0)) {
                log(`updater: latest release ${tag ?? "none"}, we are ${version}`);
                if (fromTray) await tell(t("app.update.upToDate", { version }));
                return "latest";
            }
            log(`updater: ${tag} is out (portable, offering the page)`);
            if (!fromTray && offered.has(tag)) return "available";
            offered.add(tag);
            const response = await box({
                type: "info",
                message: t("app.update.available", { version: shown(tag) }),
                detail: t("app.update.portableDetail"),
                buttons: [t("app.update.openPage"), t("app.update.later")],
                defaultId: 0, cancelId: 1,
            });
            if (response === 0) await openExternal(releasePage(release.html_url));
            return "available";
        } catch (error) {
            log(`updater: portable check failed: ${firstLine(error)}`);
            if (fromTray) await failed(error);
            return "error";
        } finally {
            portableBusy = false;
        }
    }

    async function check({ manual: fromTray = false } = {}) {
        if (mode === "dev") {
            log("updater: dev run, not checking");
            if (fromTray) await tell(t("app.update.devOnly"));
            return "dev";
        }
        return mode === "portable" ? checkPortable(fromTray) : checkInstalled(fromTray);
    }

    // The automatic checks: once 10 s after start, then every 4 hours while the app runs (installed and portable
    // alike). The setting is read again each time one fires, so turning it off (or on) in the tray takes effect at the
    // next one; the 4-hour checks run even when the setting was off at start. start() → whether the first one is set.
    let recheck = null;
    function start() {
        if (mode === "dev") {
            log("updater: dev run, no automatic check");
            return false;
        }
        if (!recheck) {
            recheck = repeat(() => {
                if (autoCheck()) void check();
            }, everyMs);
            recheck?.unref?.();
        }
        if (!autoCheck()) {
            log("updater: automatic check is off");
            return false;
        }
        schedule(() => {
            if (autoCheck()) void check();
        }, delayMs);
        return true;
    }

    return { start, check, state: () => ({ mode, phase, found }) };
}
