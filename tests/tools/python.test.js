// Runs the Python tests of the training tools (tests/py/*.py: train_mapper, dataset3, fun-labels; tests/tools/test_*.py:
// train_critic; tools/nn/test_*.py: the nn-v2 data pack and model, needs torch) with the project's .venv when it exists
// (in a git worktree: the main checkout's .venv); skipped without it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const exe = process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python");

function findPython() {
    if (process.env.LUNACY_PYTHON) return process.env.LUNACY_PYTHON;
    const roots = [ROOT];
    const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
    if (common.status === 0 && common.stdout.trim()) roots.push(path.dirname(common.stdout.trim()));
    for (const r of roots) {
        const p = path.join(r, ".venv", exe);
        if (existsSync(p)) return p;
    }
    return null;
}

const python = findPython();
const DIRS = ["tests/py", "tests/tools", "tools/nn"];
const files = DIRS.flatMap((dir) => readdirSync(path.join(ROOT, dir)).filter((f) => /^test_.*\.py$/.test(f)).map((f) => path.join(dir, f)));

// the nn-v2 tests need torch (requirements-nn.txt), which a light .venv may lack
const hasTorch = python ? spawnSync(python, ["-I", "-c", "import torch"], { windowsHide: true, timeout: 60_000 }).status === 0 : false;
const skipOf = (f) => (!python ? "no .venv python" : f.startsWith(path.join("tools", "nn")) && !hasTorch ? "no torch in the .venv" : false);

for (const f of files) {
    test(`python ${f}`, { skip: skipOf(f), timeout: 180_000 }, () => {
        const r = spawnSync(python, ["-I", path.join(ROOT, f)], { encoding: "utf8", windowsHide: true, timeout: 170_000 });
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-4000));
        assert.match(r.stdout, /passed/);
    });
}
