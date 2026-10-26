const { contextBridge, ipcRenderer } = require("electron");

// The overlay's own preload, for its widget windows and its settings window (app/overlay/overlayManager.js).
// It runs sandboxed, so it stays self-contained.
contextBridge.exposeInMainWorld("overlayApi", {
    // the same synchronous language answer the main window's preload gets
    lang: ipcRenderer.sendSync("get-lang"),
    // widget windows: { widget, style, opacity, scale, show, edit, hotkey } and the play's snapshots
    onConfig: (cb) => ipcRenderer.on("overlay-config", (_e, config) => cb(config)),
    onState: (cb) => ipcRenderer.on("overlay-state", (_e, state) => cb(state)),
    setScale: (widget, scale) => ipcRenderer.send("overlay-scale", { widget, scale }),
    // the settings window: read, change (a patch), the edit mode
    get: () => ipcRenderer.invoke("overlay-get"),
    set: (patch) => ipcRenderer.invoke("overlay-set", patch),
    setEdit: (on) => ipcRenderer.send("overlay-edit", Boolean(on)),
    openSettings: () => ipcRenderer.send("overlay-open-settings"),
    onSettings: (cb) => ipcRenderer.on("overlay-settings", (_e, payload) => cb(payload)),
});
