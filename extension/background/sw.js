// Chrome/Edge background: a module service worker. It holds the router, the fetchers, the cache and the analysis
// host; the analysis itself runs in a Worker inside the offscreen document (service workers cannot import()).
// Listeners are registered synchronously at the top level, so a message that wakes the worker is not lost.
import { ANALYZER } from "../lib/analyzerVersion.generated.js";
import { md5Hex } from "../shared/md5.js";
import { readOsuMeta } from "../shared/osuMeta.js";
import { createAnalysisHost, createOffscreenRunner } from "./analysisHost.js";
import { createCache, idbBackend, memoryBackend } from "./cache.js";
import { createFetchers } from "./fetchers.js";
import { relabel } from "./relabel.js";
import { createRouter } from "./router.js";

const permits = async (url) => {
    try {
        return await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
    } catch {
        return true;
    }
};

const router = createRouter({
    fetchers: createFetchers({ md5Hex }),
    cache: createCache({ backend: globalThis.indexedDB ? idbBackend(globalThis.indexedDB) : memoryBackend() }),
    host: createAnalysisHost({ runner: createOffscreenRunner(chrome) }),
    relabel,
    readOsuMeta,
    analyzer: ANALYZER,
    version: chrome.runtime.getManifest().version,
    permits,
    runtimeId: chrome.runtime.id,
});

chrome.runtime.onMessage.addListener(router.onMessage);
chrome.runtime.onConnect.addListener(router.onConnect);
