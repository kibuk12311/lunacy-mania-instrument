const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The preload runs sandboxed and cannot require local files, so every tab's methods live here, in marked blocks:
// a tab edits only the lines inside its own block.
contextBridge.exposeInMainWorld("danApi", {
    // read once, synchronously, before any tab builds its texts; a change reloads the page
    lang: ipcRenderer.sendSync("get-lang"),
    setLang: (lang) => ipcRenderer.send("set-lang", lang),
    onView: (cb) => ipcRenderer.on("view", (_e, view) => cb(view)),
    onSettings: (cb) => ipcRenderer.on("settings", (_e, settings) => cb(settings)),
    // { client: "stable" | "lazer" | null }: which osu! tosu is reading
    onOsuClient: (cb) => ipcRenderer.on("osu-client", (_e, payload) => cb(payload)),
    toggleAlwaysOnTop: () => ipcRenderer.send("toggle-always-on-top"),
    toggleCompact: () => ipcRenderer.send("toggle-compact"),
    setTab: (tab) => ipcRenderer.send("tab", tab),
    pathForFile: (file) => webUtils.getPathForFile(file),
    // >>> shared
    profileGet: () => ipcRenderer.invoke("profile-get"),
    profileEnsure: (query) => ipcRenderer.invoke("profile-ensure", { query }),
    onProfileChanged: (cb) => ipcRenderer.on("profile-changed", (_e, p) => cb(p)),
    // <<< shared
    // >>> create
    // mapgen v3: generating answers a store id and writes nothing; export-set saves by ids
    generateMap: (request) => ipcRenderer.invoke("generate-map", request),
    onGenerateProgress: (cb) => {
        const listener = (_e, progress) => cb(progress);
        ipcRenderer.on("generate-progress", listener);
        return () => ipcRenderer.removeListener("generate-progress", listener);
    },
    detectTiming: (request) => ipcRenderer.invoke("detect-timing", request),
    exportSet: (request) => ipcRenderer.invoke("export-set", request),
    songTags: (audioPath) => ipcRenderer.invoke("song-tags", audioPath),
    remapLoad: (request) => ipcRenderer.invoke("remap-load", request),
    remapCreate: (request) => ipcRenderer.invoke("remap-create", request),
    // wave 3: what the generator can do here (engines, nn-v2 sizes, styles, critic); 👍/👎 on a variant by store id
    generatorInfo: (opts) => ipcRenderer.invoke("generator-info", opts),
    // { id, vote: 1 | -1 | 0, tags } → { ok, n }
    rateVariant: (request) => ipcRenderer.invoke("rate-variant", request),
    ratingsSummary: () => ipcRenderer.invoke("ratings-summary"),
    ratingsExport: () => ipcRenderer.invoke("ratings-export"),
    openMap: (file) => ipcRenderer.invoke("open-map", file),
    showMap: (file) => ipcRenderer.send("show-map", file),
    // <<< create
    // >>> analysis
    // details of the selected map { key, details | null }; → unsubscribe
    onAnalysisDetails: (cb) => {
        const listener = (_e, payload) => cb(payload);
        ipcRenderer.on("analysis-details", listener);
        return () => ipcRenderer.removeListener("analysis-details", listener);
    },
    analysisRate: (key, rate) => ipcRenderer.invoke("analysis-rate", { key, rate }),
    // <<< analysis
    // >>> rate
    rateInfo: () => ipcRenderer.invoke("rate-info"),
    // opts: { mirror, noLn }
    ratePreview: (rate, opts) => ipcRenderer.invoke("rate-preview", { rate, ...opts }),
    rateCreate: (request) => ipcRenderer.invoke("rate-create", request),
    rateTarget: (request) => ipcRenderer.invoke("rate-target", request),
    rateBatchDans: (request) => ipcRenderer.invoke("rate-batch-dans", request),
    rateBatchCreate: (request) => ipcRenderer.invoke("rate-batch-create", request),
    rateCancel: () => ipcRenderer.send("rate-cancel"),
    // { job, key, index, total, rate, numeric?, row? }; → unsubscribe
    onRateProgress: (cb) => {
        const listener = (_e, progress) => cb(progress);
        ipcRenderer.on("rate-progress", listener);
        return () => ipcRenderer.removeListener("rate-progress", listener);
    },
    ratePresets: () => ipcRenderer.invoke("rate-presets-get"),
    rateSavePresets: (presets) => ipcRenderer.invoke("rate-presets-save", { presets }),
    // <<< rate
    // >>> marathon
    marathonAddCurrent: () => ipcRenderer.invoke("marathon-add-current"),
    marathonAddFile: (file) => ipcRenderer.invoke("marathon-add-file", file),
    // → { label, numeric, cutMs }; label "" and numeric null: no dan
    marathonDan: (file, rate) => ipcRenderer.invoke("marathon-dan", { file, rate }),
    marathonCreate: (request) => ipcRenderer.invoke("marathon-create", request),
    marathonAuto: (request) => ipcRenderer.invoke("marathon-auto", request),
    marathonAutoCancel: () => ipcRenderer.invoke("marathon-auto-cancel"),
    // { i, n, phase, name?, received?, total? }; → unsubscribe
    onMarathonAutoProgress: (cb) => {
        const listener = (_e, progress) => cb(progress);
        ipcRenderer.on("marathon-auto-progress", listener);
        return () => ipcRenderer.removeListener("marathon-auto-progress", listener);
    },
    // <<< marathon
    // >>> picks
    recPlayer: (query) => ipcRenderer.invoke("rec-player", query),
    recMe: () => ipcRenderer.invoke("rec-me"),
    recStart: (request) => ipcRenderer.invoke("rec-start", request),
    recMore: () => ipcRenderer.invoke("rec-more"),
    recOurs: (req) => ipcRenderer.invoke("rec-ours", req),
    recOpen: (kind, beatmapId) => ipcRenderer.invoke("rec-open", { kind, beatmapId }),
    recDownload: (req) => ipcRenderer.invoke("rec-download", req),
    recShow: (file) => ipcRenderer.invoke("rec-show", file),
    onRecDownloadProgress: (cb) => ipcRenderer.on("rec-download-progress", (_e, event) => cb(event)),
    // tabs v2: the training plan, similar maps, favourites with the collection.db export, progress
    recPlan: (request) => ipcRenderer.invoke("rec-plan", request),
    recPlanSwap: (slot) => ipcRenderer.invoke("rec-plan-swap", { slot }),
    recSimilar: (request) => ipcRenderer.invoke("rec-similar", request),
    recFavList: () => ipcRenderer.invoke("rec-fav-list"),
    recFavAdd: (card) => ipcRenderer.invoke("rec-fav-add", { card }),
    recFavRemove: (beatmapId) => ipcRenderer.invoke("rec-fav-remove", { beatmapId }),
    recFavExport: (name) => ipcRenderer.invoke("rec-fav-export", { name }),
    // { done, total }; → unsubscribe
    onRecFavExportProgress: (cb) => {
        const listener = (_e, progress) => cb(progress);
        ipcRenderer.on("rec-fav-export-progress", listener);
        return () => ipcRenderer.removeListener("rec-fav-export-progress", listener);
    },
    recProgress: (days) => ipcRenderer.invoke("rec-progress", { days }),
    // <<< picks
    // >>> overlay
    // the in-game overlay's own channels (app/overlay/overlayManager.js), the same ones its settings window uses
    overlayGet: () => ipcRenderer.invoke("overlay-get"),
    overlaySet: (patch) => ipcRenderer.invoke("overlay-set", patch),
    overlaySetEdit: (on) => ipcRenderer.send("overlay-edit", Boolean(on)),
    overlayOpenSettings: () => ipcRenderer.send("overlay-open-settings"),
    // { settings, edit } on every change, wherever it was made (the tray, the hotkey, the settings window)
    onOverlaySettings: (cb) => ipcRenderer.on("overlay-settings", (_e, payload) => cb(payload)),
    // <<< overlay
});
