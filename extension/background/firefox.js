// Firefox background: a module event page. Same router, fetchers and cache as the Chrome service worker; the
// analysis Worker is started right here (Firefox has no offscreen documents and its background page can make Workers).
// Listeners are registered synchronously at the top level, so a message that wakes the page is not lost.
import { ANALYZER } from "../lib/analyzerVersion.generated.js";
import { md5Hex } from "../shared/md5.js";
import { readOsuMeta } from "../shared/osuMeta.js";
import { createAnalysisHost, createWorkerRunner } from "./analysisHost.js";
import { createCache, idbBackend, memoryBackend } from "./cache.js";
import { createFetchers } from "./fetchers.js";
import { relabel } from "./relabel.js";
import { createRouter } from "./router.js";

const api = globalThis.browser ?? globalThis.chrome;

const permits = async (url) => {
    try {
        return await api.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
    } catch {
        return true;
    }
};

const runner = createWorkerRunner(() => new Worker(api.runtime.getURL("analysis/worker.js"), { type: "module" }));

const router = createRouter({
    fetchers: createFetchers({ md5Hex }),
    cache: createCache({ backend: globalThis.indexedDB ? idbBackend(globalThis.indexedDB) : memoryBackend() }),
    host: createAnalysisHost({ runner }),
    relabel,
    readOsuMeta,
    analyzer: ANALYZER,
    version: api.runtime.getManifest().version,
    permits,
    runtimeId: api.runtime.id,
});

api.runtime.onMessage.addListener(router.onMessage);
api.runtime.onConnect.addListener(router.onConnect);
