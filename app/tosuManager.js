// Runs the bundled tosu hidden: no console window, no dashboard, local-only, stopped with the app.
import { spawn, execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { t } from "../src/i18n/i18n.js";

export const TOSU_PORT = 24077;

const CONFIG = {
    OPEN_DASHBOARD_ON_STARTUP: "false",
    ENABLE_AUTOUPDATE: "false",
    CALCULATE_PP: "false",
    SERVER_IP: "127.0.0.1",
    SERVER_PORT: String(TOSU_PORT),
    ENABLE_INGAME_OVERLAY: "false",
};

const readVersion = (dir) => {
    try {
        return readFileSync(path.join(dir, "VERSION"), "utf8").trim();
    } catch {
        return null;
    }
};

// tosu refuses to start from %TEMP% (where the portable exe unpacks itself), so it runs from a copy in userData.
// Returns true when files were copied.
export function installTosu(srcDir, dstDir) {
    const version = readVersion(srcDir);
    if (version !== null && version === readVersion(dstDir)) return false;
    mkdirSync(dstDir, { recursive: true });
    cpSync(srcDir, dstDir, { recursive: true, force: true, filter: (p) => !p.endsWith(".zip") });
    return true;
}

// tosu v4 reads tosu.env from the folder its executable lives in.
export function writeTosuConfig(tosuDir) {
    const file = path.join(tosuDir, "tosu.env");
    writeFileSync(file, Object.entries(CONFIG).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");
    return file;
}

// A failure whose text can be told again in the language of the moment: retell() after a live language switch.
const failure = (key, params) => Object.assign(new Error(t(key, params)), { retell: () => t(key, params) });

export function startTosu({ tosuDir, onExit }) {
    const exe = path.join(tosuDir, "tosu.exe");
    if (!existsSync(exe)) {
        setImmediate(() => onExit?.(failure("app.tosu.missing", { exe })));
        return { pid: null, stop: async () => {} };
    }
    writeTosuConfig(tosuDir);
    const child = spawn(exe, [], { cwd: tosuDir, windowsHide: true, detached: false, stdio: "ignore" });
    let reported = false;
    const report = (error) => {
        if (reported) return;
        reported = true;
        onExit?.(error);
    };
    child.on("error", (error) => report(failure("app.tosu.startFailed", { message: error.message })));
    // Any exit we did not ask for is a failure: the window must not keep waiting for a tosu that is gone.
    child.on("exit", (code) => report(code ? failure("app.tosu.exitCode", { code }) : failure("app.tosu.exited")));
    if (child.pid) writeFileSync(path.join(tosuDir, "tosu.pid"), String(child.pid), "utf8");

    return {
        pid: child.pid,
        stop: () => new Promise((resolve) => {
            reported = true;
            rmSync(path.join(tosuDir, "tosu.pid"), { force: true });
            if (child.exitCode !== null || !child.pid) return resolve();
            execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
        }),
    };
}

function executablePathOf(pid) {
    try {
        const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
            + `(Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\").ExecutablePath`;
        return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
    } catch {
        return "";
    }
}

// A tosu left behind by a crashed or killed app run. Only a process whose executable is our own copy is killed.
export function killOrphanTosu(tosuDir) {
    const pidFile = path.join(tosuDir, "tosu.pid");
    let pid;
    try {
        pid = Number(readFileSync(pidFile, "utf8").trim());
    } catch {
        return false;
    }
    rmSync(pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const ours = path.join(tosuDir, "tosu.exe").toLowerCase();
    if (executablePathOf(pid).toLowerCase() !== ours) return false;
    try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

export function isPortFree(port) {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
}
