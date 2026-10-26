// The Documents folder (app/docsFolder.js): an older version's folder is kept, a new user gets the current name.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pickDocsDir, DOCS_FOLDER, OLD_DOCS_FOLDERS } from "../app/docsFolder.js";

const DOCS = path.join("C:", "Users", "u", "Documents");
const only = (...names) => (dir) => names.some((n) => dir === path.join(DOCS, n));

test("a new user gets the folder of the current name", () => {
    assert.equal(DOCS_FOLDER, "Lunacy mania");
    assert.equal(pickDocsDir(DOCS, () => false), path.join(DOCS, "Lunacy mania"));
    assert.equal(pickDocsDir(DOCS, only("Lunacy mania")), path.join(DOCS, "Lunacy mania"));
});

test("a folder from an older version is kept, the oldest first", () => {
    assert.deepEqual(OLD_DOCS_FOLDERS, ["Анализатор данов", "Sneezey's dan calculator"]);
    assert.equal(pickDocsDir(DOCS, only("Sneezey's dan calculator")), path.join(DOCS, "Sneezey's dan calculator"));
    assert.equal(pickDocsDir(DOCS, only("Анализатор данов")), path.join(DOCS, "Анализатор данов"));
    assert.equal(pickDocsDir(DOCS, only("Анализатор данов", "Sneezey's dan calculator", "Lunacy mania")),
        path.join(DOCS, "Анализатор данов"));
    assert.equal(pickDocsDir(DOCS, only("Sneezey's dan calculator", "Lunacy mania")),
        path.join(DOCS, "Sneezey's dan calculator"));
});
