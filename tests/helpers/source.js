// Source-reading helpers for the guard tests: code files of the app and a comment stripper.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

// Drops // and /* */ comments while leaving string and template literals alone.
export function stripComments(src) {
    let out = "";
    let i = 0;
    let quote = null;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (quote) {
            out += c;
            if (c === "\\") { out += next ?? ""; i += 2; continue; }
            if (c === quote) quote = null;
            i += 1;
            continue;
        }
        if (c === "/" && next === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
        if (c === "/" && next === "*") { i = src.indexOf("*/", i + 2); i = i < 0 ? src.length : i + 2; continue; }
        if (c === "\"" || c === "'" || c === "`") quote = c;
        out += c;
        i += 1;
    }
    return out;
}

function walk(dir, skip) {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) return full === skip ? [] : walk(full, skip);
        return /\.(m?js|cjs)$/.test(name) ? [full] : [];
    });
}

// Every .js/.mjs/.cjs file in app/ and src/, without the message files (src/i18n/messages); absolute paths.
export function codeFiles(root) {
    const skip = path.join(root, "src", "i18n", "messages");
    return [...walk(path.join(root, "app"), skip), ...walk(path.join(root, "src"), skip)];
}
