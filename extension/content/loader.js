// Content script (classic): loads the page lane's ES modules from the extension (content/main.js and what it imports
// are web-accessible) and starts them once per page, however often the browser injects this file.
(() => {
    const flag = "__lunacyManiaDansLoaded";
    if (globalThis[flag]) return;
    globalThis[flag] = true;
    const api = globalThis.chrome?.runtime?.getURL ? globalThis.chrome : globalThis.browser;
    let url;
    try {
        url = api.runtime.getURL("content/main.js");
    } catch (error) {
        globalThis.console?.warn?.("[Lunacy mania] the extension is not available here:", error);
        return;
    }
    import(url)
        .then((m) => m.start())
        .catch((error) => globalThis.console?.warn?.("[Lunacy mania] could not start:", error));
})();
