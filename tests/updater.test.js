// Updates (app/updater.js) with fakes for electron-updater, the dialog, fetch and the clock: version compare, the
// installed flow (ready → dialog → quitAndInstall / later), the portable release-page offer, quiet automatic errors
// versus told tray checks, the dev run and the automatic-check setting.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
    compareVersions, parseVersion, isPortableRun, updateMode, releasePage, createUpdater,
    LATEST_RELEASE_API, RELEASES_PAGE, AUTO_CHECK_DELAY_MS,
} from "../app/updater.js";
import { setLang, t } from "../src/i18n/i18n.js";

const flush = () => new Promise((r) => setImmediate(r));

// electron-updater's autoUpdater as far as updater.js uses it; check() decides what a checkForUpdates() does.
function fakeAutoUpdater(check) {
    const u = new EventEmitter();
    u.checks = 0;
    u.installs = [];
    u.checkForUpdates = async () => {
        u.checks += 1;
        return check(u);
    };
    u.quitAndInstall = (...args) => u.installs.push(args);
    return u;
}

// an update found, downloaded right away (events in electron-updater's order)
const findsAndDownloads = (version) => (u) => {
    u.emit("update-available", { version });
    const downloadPromise = Promise.resolve().then(() => u.emit("update-downloaded", { version }));
    return { isUpdateAvailable: true, downloadPromise };
};
const upToDate = (u) => {
    u.emit("update-not-available", { version: "0.8.0" });
    return { isUpdateAvailable: false };
};
// electron-updater emits "error" and then rejects the check
const fails = (message) => async (u) => {
    const error = new Error(message);
    u.emit("error", error);
    throw error;
};

function setup({ mode = "installed", check = upToDate, responses = [], fetchAnswer = null, autoCheck = () => true } = {}) {
    setLang("en");
    const logs = [];
    const boxes = [];
    const opened = [];
    const timers = [];
    const fetched = [];
    const autoUpdater = fakeAutoUpdater(check);
    let loaded = 0;
    const updater = createUpdater({
        mode, version: "0.8.0",
        loadAutoUpdater: async () => {
            loaded += 1;
            return autoUpdater;
        },
        dialog: {
            showMessageBox: async (...args) => {
                const options = args.at(-1);
                boxes.push(options);
                return { response: responses.shift() ?? options.cancelId ?? 0 };
            },
        },
        openExternal: async (url) => opened.push(url),
        fetch: async (url, init) => {
            fetched.push({ url, init });
            if (fetchAnswer instanceof Error) throw fetchAnswer;
            const { status = 200, body = {} } = fetchAnswer ?? {};
            return { status, ok: status >= 200 && status < 300, json: async () => body };
        },
        log: (line) => logs.push(line),
        t,
        autoCheck,
        schedule: (fn, ms) => timers.push({ fn, ms }),
    });
    return { updater, autoUpdater, logs, boxes, opened, timers, fetched, loaded: () => loaded };
}

test("versions: semver precedence with a leading v, prereleases and build metadata", () => {
    assert.deepEqual(parseVersion("v0.8.0"), { core: [0, 8, 0], pre: [] });
    assert.deepEqual(parseVersion("1.2.3-beta.11+abc"), { core: [1, 2, 3], pre: ["beta", 11] });
    for (const bad of ["", "0.8", "v0.8.0.1", "01.2.3", "latest", null, undefined]) assert.equal(parseVersion(bad), null, String(bad));
    assert.equal(compareVersions("v0.8.1", "0.8.0"), 1);
    assert.equal(compareVersions("0.8.0", "v0.8.0"), 0);
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1, "numbers, not text");
    assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
    assert.equal(compareVersions("0.8.0+build.7", "0.8.0"), 0, "build metadata doesn't count");
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i + 1 < order.length; i += 1) {
        assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
        assert.equal(compareVersions(order[i + 1], order[i]), 1, `${order[i + 1]} > ${order[i]}`);
    }
    assert.equal(compareVersions("garbage", "0.8.0"), null);
});

test("mode: dev when not packaged, portable from the portable exe's variables, installed otherwise", () => {
    assert.equal(isPortableRun({ PORTABLE_EXECUTABLE_FILE: "D:\\a.exe" }), true);
    assert.equal(isPortableRun({ PORTABLE_EXECUTABLE_DIR: "D:\\" }), true);
    assert.equal(isPortableRun({}), false);
    assert.equal(updateMode({ packaged: false, portable: true }), "dev");
    assert.equal(updateMode({ packaged: true, portable: true }), "portable");
    assert.equal(updateMode({ packaged: true, portable: false }), "installed");
});

test("release page: only https pages of our repo on github.com", () => {
    const ours = "https://github.com/kibuk12311/lunacy-mania-instrument/releases/tag/v0.9.0";
    assert.equal(releasePage(ours), ours);
    for (const bad of [
        "http://github.com/kibuk12311/lunacy-mania-instrument/releases/tag/v0.9.0",
        "https://github.com.evil.io/kibuk12311/lunacy-mania-instrument/releases",
        "https://evil@github.com/kibuk12311/lunacy-mania-instrument/releases",
        "https://github.com/kibuk12311/lunacy-mania-instrument-fake/releases",
        "https://github.com/someone/else/releases/tag/v0.9.0",
        "file:///C:/Windows/notepad.exe",
        "nonsense", undefined,
    ]) assert.equal(releasePage(bad), RELEASES_PAGE, String(bad));
});

test("start: the automatic check runs 10 s after start, re-reads the setting, and never in a dev run", async () => {
    let on = true;
    const app = setup({ autoCheck: () => on });
    assert.equal(app.updater.start(), true);
    assert.equal(app.timers.length, 1);
    assert.equal(app.timers[0].ms, AUTO_CHECK_DELAY_MS);
    assert.equal(AUTO_CHECK_DELAY_MS, 10_000);
    on = false;
    app.timers[0].fn();
    await flush();
    assert.equal(app.loaded(), 0, "turned off before it fired");

    const off = setup({ autoCheck: () => false });
    assert.equal(off.updater.start(), false);
    assert.equal(off.timers.length, 0);
    assert.ok(off.logs.some((l) => /automatic check is off/.test(l)));

    const dev = setup({ mode: "dev" });
    assert.equal(dev.updater.start(), false);
    assert.equal(dev.timers.length, 0);
    assert.equal(await dev.updater.check(), "dev");
    assert.equal(dev.boxes.length, 0, "quiet");
    assert.equal(dev.loaded(), 0, "electron-updater never loaded");
    assert.equal(await dev.updater.check({ manual: true }), "dev");
    assert.equal(dev.boxes[0].message, "Updates are checked only in the built app");
});

test("installed: found → downloaded → asked once → «Restart now» runs quitAndInstall silently and restarts", async () => {
    const app = setup({ check: findsAndDownloads("0.9.0"), responses: [0] });
    app.updater.start();
    app.timers[0].fn();
    await flush();
    await flush();
    assert.equal(app.autoUpdater.autoDownload, true);
    assert.equal(app.autoUpdater.autoInstallOnAppQuit, true);
    assert.equal(app.boxes.length, 1, "the automatic check tells only the ready update");
    assert.equal(app.boxes[0].message, "Version 0.9.0 is ready");
    assert.deepEqual(app.boxes[0].buttons, ["Restart now", "Later"]);
    assert.equal(app.boxes[0].cancelId, 1);
    assert.deepEqual(app.autoUpdater.installs, [[true, true]]);
    assert.equal(app.updater.state().phase, "ready");
});

test("installed: «Later» leaves it to install on quit and isn't asked again by itself; a tray check asks again", async () => {
    const app = setup({ check: findsAndDownloads("0.9.0"), responses: [1, 0] });
    await app.updater.check();
    await flush();
    await flush();
    assert.equal(app.boxes.length, 1);
    assert.deepEqual(app.autoUpdater.installs, []);
    assert.ok(app.logs.some((l) => /0\.9\.0 installs on quit/.test(l)));
    assert.equal(await app.updater.check(), "ready");
    assert.equal(app.boxes.length, 1, "no second question from an automatic check");
    assert.equal(app.autoUpdater.checks, 1, "nothing checked or downloaded again");
    assert.equal(await app.updater.check({ manual: true }), "ready");
    assert.equal(app.boxes.length, 2);
    assert.equal(app.boxes[1].message, "Version 0.9.0 is ready");
    assert.deepEqual(app.autoUpdater.installs, [[true, true]]);
});

test("installed: a tray check tells «up to date» and «downloading»; an automatic one tells neither", async () => {
    const quiet = setup({ check: upToDate });
    assert.equal(await quiet.updater.check(), "latest");
    assert.equal(quiet.boxes.length, 0);

    const told = setup({ check: upToDate });
    assert.equal(await told.updater.check({ manual: true }), "latest");
    assert.equal(told.boxes.length, 1);
    assert.equal(told.boxes[0].message, "You have the latest version (0.8.0)");

    // found, download still running
    const slow = setup({ check: (u) => { u.emit("update-available", { version: "0.9.0" }); return { downloadPromise: new Promise(() => {}) }; } });
    assert.equal(await slow.updater.check({ manual: true }), "downloading");
    await flush();
    assert.match(slow.boxes[0].message, /^Found version 0\.9\.0, it's downloading in the background/);
    assert.equal(await slow.updater.check({ manual: true }), "downloading", "a second tray click says the same");
    assert.equal(slow.boxes.length, 2);
    assert.equal(slow.autoUpdater.checks, 1);
});

test("installed: errors of the automatic check only go to the log; a tray check tells them once", async () => {
    for (const message of ["net::ERR_INTERNET_DISCONNECTED", "No published versions on GitHub", "HttpError: 404", "HttpError: 403 rate limit exceeded"]) {
        const app = setup({ check: fails(message) });
        assert.equal(await app.updater.check(), "error");
        assert.equal(app.boxes.length, 0, message);
        assert.ok(app.logs.some((l) => l.includes(message)), message);
    }
    const app = setup({ check: fails("HttpError: 404\nlong response headers") });
    assert.equal(await app.updater.check({ manual: true }), "error");
    await flush();
    assert.equal(app.boxes.length, 1, "event and rejection tell it once");
    assert.equal(app.boxes[0].message, "Couldn't check for updates");
    assert.equal(app.boxes[0].detail, "HttpError: 404");
    assert.equal(app.updater.state().phase, "idle", "the next check can try again");
});

test("installed: a failed download is logged quietly and the next check starts over", async () => {
    let first = true;
    const app = setup({
        check: (u) => {
            if (!first) return upToDate(u);
            first = false;
            u.emit("update-available", { version: "0.9.0" });
            const downloadPromise = Promise.resolve().then(() => {
                const error = new Error("sha512 checksum mismatch");
                u.emit("error", error);
                throw error;
            });
            return { downloadPromise };
        },
    });
    await app.updater.check();
    await flush();
    await flush();
    assert.equal(app.boxes.length, 0);
    assert.ok(app.logs.some((l) => /checksum mismatch/.test(l)));
    assert.equal(await app.updater.check(), "latest");
    assert.equal(app.autoUpdater.checks, 2);
});

test("portable: a newer release offers its page; «Open» opens exactly that GitHub page", async () => {
    const html = "https://github.com/kibuk12311/lunacy-mania-instrument/releases/tag/v0.9.0";
    const app = setup({ mode: "portable", fetchAnswer: { body: { tag_name: "v0.9.0", html_url: html, draft: false, prerelease: false } }, responses: [0] });
    assert.equal(await app.updater.check(), "available");
    assert.equal(app.fetched[0].url, LATEST_RELEASE_API);
    assert.equal(app.fetched[0].init.headers.accept, "application/vnd.github+json");
    assert.equal(app.boxes[0].message, "Version 0.9.0 is out");
    assert.deepEqual(app.boxes[0].buttons, ["Open the download page", "Later"]);
    assert.deepEqual(app.opened, [html]);
    assert.equal(app.loaded(), 0, "electron-updater isn't used for the portable exe");
    // the automatic check doesn't ask again this run, a tray check does
    assert.equal(await app.updater.check(), "available");
    assert.equal(app.boxes.length, 1);
    assert.equal(await app.updater.check({ manual: true }), "available");
    assert.equal(app.boxes.length, 2);
});

test("portable: a foreign html_url falls back to our releases page; «Later» opens nothing", async () => {
    const foreign = setup({ mode: "portable", fetchAnswer: { body: { tag_name: "v1.0.0", html_url: "https://evil.example/download" } }, responses: [0] });
    await foreign.updater.check();
    assert.deepEqual(foreign.opened, [RELEASES_PAGE]);
    const later = setup({ mode: "portable", fetchAnswer: { body: { tag_name: "v1.0.0", html_url: RELEASES_PAGE } }, responses: [1] });
    await later.updater.check();
    assert.deepEqual(later.opened, []);
});

test("portable: same or older version, drafts, prereleases and bad tags count as up to date", async () => {
    for (const body of [
        { tag_name: "v0.8.0" }, { tag_name: "v0.7.5" }, { tag_name: "v0.9.0", draft: true },
        { tag_name: "v0.9.0", prerelease: true }, { tag_name: "nightly" }, {},
    ]) {
        const quiet = setup({ mode: "portable", fetchAnswer: { body } });
        assert.equal(await quiet.updater.check(), "latest", JSON.stringify(body));
        assert.equal(quiet.boxes.length, 0);
        const told = setup({ mode: "portable", fetchAnswer: { body } });
        assert.equal(await told.updater.check({ manual: true }), "latest");
        assert.equal(told.boxes[0].message, "You have the latest version (0.8.0)");
    }
});

test("portable: no release yet (404), rate limit and offline stay in the log unless asked from the tray", async () => {
    const none = setup({ mode: "portable", fetchAnswer: { status: 404 } });
    assert.equal(await none.updater.check(), "latest");
    assert.equal(none.boxes.length, 0);
    assert.ok(none.logs.some((l) => /no release on GitHub yet/.test(l)));

    for (const fetchAnswer of [{ status: 403 }, new TypeError("fetch failed")]) {
        const quiet = setup({ mode: "portable", fetchAnswer });
        assert.equal(await quiet.updater.check(), "error");
        assert.equal(quiet.boxes.length, 0);
        assert.ok(quiet.logs.some((l) => /portable check failed/.test(l)));
        const told = setup({ mode: "portable", fetchAnswer });
        assert.equal(await told.updater.check({ manual: true }), "error");
        assert.equal(told.boxes[0].message, "Couldn't check for updates");
    }
});

test("texts follow the language", async () => {
    const app = setup({ check: upToDate });
    setLang("ru");
    await app.updater.check({ manual: true });
    assert.equal(app.boxes[0].message, "У тебя последняя версия (0.8.0)");
    assert.equal(app.boxes[0].title, "Обновление");
});
