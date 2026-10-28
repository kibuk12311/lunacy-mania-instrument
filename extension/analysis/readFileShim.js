// Stand-in for node:fs/promises readFile as the copied src/core/model.js uses it: readFile(URL, "utf8") -> text.
// tools/build-extension.mjs points the copy's import here. In the extension it fetches the packaged file; under Node
// (the parity test runs the built copy) a file: URL is read with node:fs, imported only then.
const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

export async function readFile(url) {
    const href = url instanceof URL ? url.href : String(url);
    if (IS_NODE && href.startsWith("file:")) {
        const fs = await import("node:fs/promises");
        return fs.readFile(new URL(href), "utf8");
    }
    const response = await fetch(href);
    if (!response.ok) throw new Error(`could not read ${href.split("/").pop()} (${response.status})`);
    return response.text();
}
