// Etterna as a source of charts beside osu! and Interlude, read only and inside the app (nothing is read from the running
// game). What this keeps, in userData\etterna.json:
//   - the folder: picked or found (the install with Songs\ and Program\), scanned in the background by
//     app/etternaLibrary.js after it is linked and at every start;
//   - the switch (⚙ Settings → Etterna, on by default): turned off, the whole app goes on as if no folder were linked
//     while the folder stays kept, and the library's index with it, so turning it on again reads only what changed.
import { createEtternaLibrary, etternaFolderOf, detectEtterna, etternaCandidates } from "./etternaLibrary.js";
import { t } from "../src/i18n/i18n.js";

// store: { get, set } of { folder, enabled }; cacheDir: the app's folder for the library's index and its copy of
// cache.db; makeLibrary: createEtternaLibrary (tests wrap it); candidates: where detect() looks
export function createEtternaClient({
    store, cacheDir, log = () => {}, onChange = () => {}, makeLibrary = createEtternaLibrary, candidates = etternaCandidates(),
}) {
    let folder = null;
    let enabled = true;
    let loaded = null;
    let library = null; // the library of the linked folder, while it is usable
    let scanning = null; // { done, total } while a scan runs
    let scan = Promise.resolve(); // the last scan

    const usable = () => (enabled && folder && etternaFolderOf(folder) ? folder : null);
    const save = () => store.set({ folder, enabled });

    function startScan() {
        const dir = usable();
        if (!dir) {
            library = null;
            return scan;
        }
        const lib = makeLibrary({ folder: dir, cacheDir, log });
        library = lib;
        scanning = { done: 0, total: 0 };
        onChange();
        // one scan at a time: they share the copy of cache.db and the index file; one asked for meanwhile waits its turn,
        // and a scan whose library is no longer the one in use is not run at all
        scan = scan.then(() => (library === lib ? lib.refresh({ onProgress: (p) => { if (library === lib) { scanning = p; onChange(); } } }) : null)).then(
            () => {},
            (error) => log(`etterna: scan failed: ${error?.message ?? error}`),
        ).finally(() => {
            if (library === lib) {
                scanning = null;
                onChange();
            }
        });
        return scan;
    }

    // the stored settings, once; a linked, usable folder starts its scan
    const ready = () => (loaded ??= store.get().then((s) => {
        folder = typeof s?.folder === "string" ? s.folder : null;
        enabled = s?.enabled !== false;
        startScan();
    }, () => {}));

    async function status() {
        await ready();
        if (!enabled) return { linked: false, off: true, folder };
        if (!folder) return { linked: false, folder: null };
        if (!etternaFolderOf(folder)) return { linked: false, folder, missing: true, message: t("app.etterna.folderGone", { folder }) };
        return { linked: true, folder, size: library?.size() ?? 0, scanning };
    }

    async function link(picked) {
        await ready();
        const dir = etternaFolderOf(picked);
        if (!dir) return { ok: false, message: t("app.etterna.notFolder") };
        folder = dir;
        await save();
        log(`etterna: folder ${dir}`);
        startScan();
        return { ok: true, ...(await status()) };
    }

    async function detect() {
        await ready();
        const dir = detectEtterna({ candidates });
        return dir ? link(dir) : { ok: false, message: t("app.etterna.notFound") };
    }

    async function unlink() {
        await ready();
        folder = null;
        library = null;
        scanning = null;
        await save();
        log("etterna: folder unlinked");
        onChange();
        return status();
    }

    async function setEnabled(on) {
        await ready();
        enabled = Boolean(on);
        await save();
        log(`etterna: ${enabled ? "on" : "off"}`);
        if (enabled) startScan();
        else {
            library = null;
            scanning = null;
            onChange();
        }
        return status();
    }

    return {
        status, link, detect, unlink, setEnabled,
        // the rows of the usable library (none while off, unlinked or before the first scan ends)
        search: (query, opts) => (usable() && library ? library.search(query, opts) : []),
        chart: async (id) => (usable() && library ? library.chart(id) : null),
        row: (id) => (usable() && library ? library.row(id) : null),
        // the scan under way (or the last one) has ended
        scanned: async () => {
            await ready();
            await scan;
        },
        refresh: async () => {
            await ready();
            return startScan();
        },
    };
}
