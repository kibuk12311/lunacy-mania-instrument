// Main-process side of the Settings page (app/renderer/settingsPage.js): what it shows that no other channel tells
// (the version, the app's Documents folder, tosu's port), the places it opens (that folder, the project's page, its
// license and third-party notices — fixed addresses, never taken from the window), and clearing the caches: the
// analysis results and the mapper-style lists (the session library's has its own channel, app/sessionIpc.js).
// Everything else on the page goes through the channels its own tab already uses (one source of truth).
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { t } from "../src/i18n/i18n.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
export const HOMEPAGE = String(pkg.homepage || "https://github.com/kibuk12311/lunacy-mania-instrument");
export const LINKS = Object.freeze({
    github: HOMEPAGE,
    releases: `${HOMEPAGE}/releases`,
    license: `${HOMEPAGE}/blob/main/LICENSE`,
    notices: `${HOMEPAGE}/blob/main/THIRD_PARTY_NOTICES.md`,
});
export const CACHES = ["results", "model-styles"];
const fail = (error) => ({ ok: false, message: String(error?.message ?? error) });

// shell: { openPath, openExternal }; resultCache: src/core/cache.js; styleCatalog: app/modelStyles.js; tosuPort.
export function createSettingsHandlers({ shell, paths, resultCache = null, styleCatalog = null, tosuPort = null, version = pkg.version, log = () => {} }) {
    return {
        info: () => ({ ok: true, version, docsDir: paths.docsDir, tosuPort, links: { ...LINKS } }),
        async open(request) {
            const target = request?.target;
            try {
                if (target === "docs") {
                    await mkdir(paths.docsDir, { recursive: true });
                    const error = await shell.openPath(paths.docsDir);
                    return error ? { ok: false, message: error } : { ok: true };
                }
                if (!Object.hasOwn(LINKS, target)) return { ok: false, message: t("settings.err.request") };
                await shell.openExternal(LINKS[target]);
                return { ok: true };
            } catch (error) {
                return fail(error);
            }
        },
        async clear(request) {
            const which = request?.which;
            try {
                if (which === "results" && resultCache?.clear) await resultCache.clear();
                else if (which === "model-styles" && styleCatalog?.clear) await styleCatalog.clear();
                else return { ok: false, message: t("settings.err.request") };
                log(`settings: cache ${which} cleared`);
                return { ok: true };
            } catch (error) {
                return fail(error);
            }
        },
    };
}

export function registerSettingsIpc({ ipcMain, shell, paths, resultCache, styleCatalog, tosu, log }) {
    const h = createSettingsHandlers({ shell, paths, resultCache, styleCatalog, tosuPort: tosu?.port ?? null, log });
    ipcMain.handle("settings-info", () => h.info());
    ipcMain.handle("settings-open", (_e, request) => h.open(request));
    ipcMain.handle("settings-clear-cache", (_e, request) => h.clear(request));
    return h;
}
