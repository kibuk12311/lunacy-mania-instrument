// Builds the extension into a fresh folder for one test file and removes it afterwards.
// inWorktree: under extension/build/ (gitignored), so Node finds node_modules from there (the parity test runs the
// copied analyzer under Node, whose ONNX entry imports onnxruntime-common); else under the system temp folder.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT, buildExtension } from "../../../tools/build-extension.mjs";

export { ROOT };

export async function buildForTest(t, { targets = ["chrome", "firefox"], inWorktree = false } = {}) {
    const base = inWorktree ? path.join(ROOT, "extension", "build") : tmpdir();
    await mkdir(base, { recursive: true });
    const out = await mkdtemp(path.join(base, inWorktree ? ".test-" : "lm-ext-test-"));
    t.after(() => rm(out, { recursive: true, force: true }));
    const built = await buildExtension({ out, targets });
    return { out, ...built };
}
