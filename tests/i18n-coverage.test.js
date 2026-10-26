// Guard for the English interface: user-facing Russian text may only live in src/i18n/messages.
// Comments are stripped first; a few strings that are file-system names on disk are allowed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeFiles, stripComments } from "./helpers/source.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CYR = /[А-Яа-яЁё]/;
// Folder names on disk stay as they are in both languages, so old maps keep their place; "Русский" names itself.
const ALLOWED = ["Анализатор данов", "карты", "скачанные", "коллекции", "марафон", "Русский"];

test("no Russian text outside the message files (app/ and src/)", () => {
    const leftovers = [];
    for (const file of codeFiles(root)) {
        const lines = stripComments(readFileSync(file, "utf8")).split("\n");
        lines.forEach((line, i) => {
            let rest = line;
            for (const word of ALLOWED) rest = rest.split(`"${word}"`).join("\"\"");
            if (CYR.test(rest)) leftovers.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
        });
    }
    assert.deepEqual(leftovers, [], `Russian text left in code:\n${leftovers.join("\n")}`);
});

test("every Russian text and tooltip in index.html is marked for translation", () => {
    const html = readFileSync(path.join(root, "app", "renderer", "index.html"), "utf8");
    const problems = [];
    // tags whose own text (up to the next tag) is Russian need data-i18n
    for (const m of html.matchAll(/<([a-z]+)\b([^>]*)>([^<]*)/gi)) {
        const [, tag, attrs, text] = m;
        if (CYR.test(text) && !/\bdata-i18n=/.test(attrs)) problems.push(`<${tag}> text: ${text.trim().slice(0, 60)}`);
        for (const a of attrs.matchAll(/\b(title|placeholder|value|content)="([^"]*)"/g)) {
            const kind = a[1] === "title" ? "data-i18n-title" : a[1] === "placeholder" ? "data-i18n-placeholder" : null;
            if (CYR.test(a[2]) && (!kind || !attrs.includes(`${kind}=`))) problems.push(`<${tag}> ${a[1]}: ${a[2].slice(0, 60)}`);
        }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
});
