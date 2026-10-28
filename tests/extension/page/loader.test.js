import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../../extension/content/loader.js", import.meta.url), "utf8");
const dynamicImports = vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER;

// Runs loader.js as the browser would (a classic script in a fresh global) with a fake chrome.runtime.
function run(context) {
    vm.runInContext(SOURCE, context, { importModuleDynamically: dynamicImports });
}

test("loader: a classic script (no import/export statements), no eval", () => {
    assert.doesNotMatch(SOURCE, /^\s*(import|export)\s/m);
    assert.doesNotMatch(SOURCE, /\beval\s*\(|new Function/);
});

test("loader imports content/main.js from the extension and starts it once", { skip: !dynamicImports && "vm dynamic import unsupported" }, async () => {
    globalThis.__lmLoaderStarts = 0;
    const asked = [];
    const module = "data:text/javascript,export function start(){ globalThis.__lmLoaderStarts++; }";
    const context = vm.createContext({ console, chrome: { runtime: { getURL: (p) => { asked.push(p); return module; } } } });
    run(context);
    run(context); // injected twice: the guard keeps it to one start
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(asked, ["content/main.js"]);
    assert.equal(globalThis.__lmLoaderStarts, 1);
    delete globalThis.__lmLoaderStarts;
});

test("loader warns when main.js cannot be loaded, and when there is no runtime", { skip: !dynamicImports && "vm dynamic import unsupported" }, async () => {
    const warnings = [];
    const quiet = { warn: (...args) => warnings.push(args.join(" ")) };
    run(vm.createContext({ console: quiet, chrome: { runtime: { getURL: () => "data:text/javascript,throw new Error('broken')" } } }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not start/);
    run(vm.createContext({ console: quiet }));
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /not available/);
});

test("loader uses browser.runtime where chrome is missing (Firefox)", { skip: !dynamicImports && "vm dynamic import unsupported" }, async () => {
    const asked = [];
    run(vm.createContext({ console, browser: { runtime: { getURL: (p) => { asked.push(p); return "data:text/javascript,export function start(){}"; } } } }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(asked, ["content/main.js"]);
});
