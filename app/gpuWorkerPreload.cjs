// Preload of the hidden GPU renderer (stream W): passes each MessagePort main sends ("lunacy-gpu-port") into the page,
// which serves the nn-v2 encoder on it (app/gpuWorker.js). Nothing else is exposed.
const { ipcRenderer } = require("electron");

ipcRenderer.on("lunacy-gpu-port", (event) => {
    if (event.ports?.[0]) window.postMessage("lunacy-gpu-port", "*", [event.ports[0]]);
});
