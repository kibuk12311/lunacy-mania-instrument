const { contextBridge, ipcRenderer } = require("electron");

// The overlay's own preload, for its widget windows and its settings window (app/overlay/overlayManager.js).
// It runs sandboxed, so it stays self-contained.
contextBridge.exposeInMainWorld("overlayApi", {
    // the same synchronous language answer the main window's preload gets
    lang: ipcRenderer.sendSync("get-lang"),
    // widget windows: { widget, style, scale, show, look, lang, options, edit, hotkey }, the play's snapshots, shown or hidden
    onConfig: (cb) => ipcRenderer.on("overlay-config", (_e, config) => cb(config)),
    onState: (cb) => ipcRenderer.on("overlay-state", (_e, state) => cb(state)),
    // whether the window is meant to be on screen: a hidden one draws nothing
    onVisible: (cb) => ipcRenderer.on("overlay-visible", (_e, on) => cb(Boolean(on))),
    setScale: (widget, scale) => ipcRenderer.send("overlay-scale", { widget, scale }),
    // the settings window: read, change (a patch), the edit mode
    get: () => ipcRenderer.invoke("overlay-get"),
    set: (patch) => ipcRenderer.invoke("overlay-set", patch),
    // the lane keys of a key count: osu!'s, the ones set by hand, which are used ({ keys, found, osu, manual, effective })
    keys: (n) => ipcRenderer.invoke("overlay-keys", n),
    setEdit: (on) => ipcRenderer.send("overlay-edit", Boolean(on)),
    openSettings: () => ipcRenderer.send("overlay-open-settings"),
    onSettings: (cb) => ipcRenderer.on("overlay-settings", (_e, payload) => cb(payload)),
});
