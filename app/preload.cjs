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
    // local: the local profile's own plays and skill instead of mania-tracker's
    recProgress: (days, local = false) => ipcRenderer.invoke("rec-progress", { days, local: Boolean(local) }),
    // the session page: the player's own library, a session built from it, saved sessions and their export
    sessionLibraryStatus: () => ipcRenderer.invoke("session-library-status"),
    sessionLibraryScan: () => ipcRenderer.invoke("session-library-scan"),
    sessionLibraryPause: () => ipcRenderer.invoke("session-library-pause"),
    sessionLibraryResume: () => ipcRenderer.invoke("session-library-resume"),
    sessionLibraryPick: () => ipcRenderer.invoke("session-library-pick"),
    // { phase, paused, songsDir, interlude, counts, … } on every step of the scan
    onSessionLibrary: (cb) => ipcRenderer.on("session-library", (_e, status) => cb(status)),
    // { job, phase, i, n } while a session is built or exported
    onSessionProgress: (cb) => ipcRenderer.on("session-progress", (_e, p) => cb(p)),
    sessionBuild: (request) => ipcRenderer.invoke("session-build", request),
    sessionReroll: (index) => ipcRenderer.invoke("session-reroll", { index }),
    sessionSave: (name) => ipcRenderer.invoke("session-save", { name }),
    sessionList: () => ipcRenderer.invoke("session-list"),
    sessionOpen: (id) => ipcRenderer.invoke("session-open", { id }),
    sessionRemove: (id) => ipcRenderer.invoke("session-remove", { id }),
    sessionExportCollection: (name) => ipcRenderer.invoke("session-export-collection", { name }),
    sessionExportMarathon: (name) => ipcRenderer.invoke("session-export-marathon", { name }),
    sessionCopy: (text) => ipcRenderer.invoke("session-copy", { text }),
    // <<< picks
    // >>> interlude
    // Interlude (app/interludeIpc.js): its folder, a chart of its library on the card, maps and playlists sent to it
    interludeStatus: () => ipcRenderer.invoke("interlude-status"),
    interludePickFolder: () => ipcRenderer.invoke("interlude-pick-folder"),
    interludeDetect: () => ipcRenderer.invoke("interlude-detect"),
    interludeUnlink: () => ipcRenderer.invoke("interlude-unlink"),
    interludeSearch: (query) => ipcRenderer.invoke("interlude-search", { query }),
    interludeSelect: (hash) => ipcRenderer.invoke("interlude-select", { hash }),
    // files: one .osz the app made, or .osu files of one folder
    interludeSend: (files) => ipcRenderer.invoke("interlude-send", { files }),
    // { kind: "playlist" | "folder", name, items: [{ beatmapId?, md5?, path?, rate?, label }] }
    interludeExport: (request) => ipcRenderer.invoke("interlude-export", request),
    // { linked, folder, size, selected, message } on every change
    onInterludeState: (cb) => ipcRenderer.on("interlude-state", (_e, state) => cb(state)),
    // following the running game: { settings: { live, allowDownload, follow }, state: { status, code, … }, text }
    interludeLiveGet: () => ipcRenderer.invoke("interlude-live-get"),
    interludeLiveSet: (patch) => ipcRenderer.invoke("interlude-live-set", patch),
    onInterludeLive: (cb) => ipcRenderer.on("interlude-live", (_e, info) => cb(info)),

    // <<< interlude
    // >>> profile
    // the local profile (app/localProfileIpc.js): status, history, imports, backup, and the tracker page's extras
    localProfileStatus: () => ipcRenderer.invoke("local-profile-status"),
    localProfileHistory: (days) => ipcRenderer.invoke("local-profile-history", { days }),
    // source: "stable" | "interlude"
    localProfileImport: (source) => ipcRenderer.invoke("local-profile-import", { source }),
    localProfileImportCancel: () => ipcRenderer.invoke("local-profile-import-cancel"),
    localProfilePickOsu: () => ipcRenderer.invoke("local-profile-pick-osu"),
    localProfileRecord: (on) => ipcRenderer.invoke("local-profile-record", { on: Boolean(on) }),
    localProfileExport: () => ipcRenderer.invoke("local-profile-export"),
    localProfileImportFile: () => ipcRenderer.invoke("local-profile-import-file"),
    localProfileReset: () => ipcRenderer.invoke("local-profile-reset"),
    // { skill } after every play kept, import step and reset; → unsubscribe
    onLocalProfileChanged: (cb) => {
        const listener = (_e, payload) => cb(payload);
        ipcRenderer.on("local-profile-changed", listener);
        return () => ipcRenderer.removeListener("local-profile-changed", listener);
    },
    // { source, phase: "scan" | "analyse" | "end", done, total, added }; → unsubscribe
    onLocalProfileImport: (cb) => {
        const listener = (_e, payload) => cb(payload);
        ipcRenderer.on("local-profile-import", listener);
        return () => ipcRenderer.removeListener("local-profile-import", listener);
    },
    trackerRecent: () => ipcRenderer.invoke("tracker-recent"),
    trackerOpenSite: () => ipcRenderer.invoke("tracker-open-site"),
    // <<< profile
    // >>> skin
    // the Skin tab (app/skinIpc.js): working copies of osu! skins, the builder, the exports
    skinList: () => ipcRenderer.invoke("skin-list"),
    skinOpen: (request) => ipcRenderer.invoke("skin-open", request),
    // { file? }: an .osk / .zip dropped on the tab, or a dialog without it
    skinImport: (request) => ipcRenderer.invoke("skin-import", request),
    skinCreate: (request) => ipcRenderer.invoke("skin-create", request),
    skinBuild: (request) => ipcRenderer.invoke("skin-build", request),
    skinSave: (request) => ipcRenderer.invoke("skin-save", request),
    skinImages: (request) => ipcRenderer.invoke("skin-images", request),
    skinReplaceImage: (request) => ipcRenderer.invoke("skin-replace-image", request),
    skinExportOsk: (request) => ipcRenderer.invoke("skin-export-osk", request),
    skinSaveCopy: (request) => ipcRenderer.invoke("skin-save-copy", request),
    skinExportInterlude: (request) => ipcRenderer.invoke("skin-export-interlude", request),
    skinReopen: (request) => ipcRenderer.invoke("skin-reopen", request),
    skinRecent: () => ipcRenderer.invoke("skin-recent"),
    skinShow: (request) => ipcRenderer.invoke("skin-show", request),
    // <<< skin
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
