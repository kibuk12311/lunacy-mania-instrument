// Written by tools/analyzer-fingerprints.mjs from the release commits of the "public" branch: each released
// version → its analyzer fingerprint (src/core/analyzerVersion.js), worked out with today's rules over that release's
// own files. The app adopts an older results-<version> folder and keeps an older session library's analyses when the
// version's fingerprint here is its own (app/resultsFolder.js, app/sessionLibrary.js). Only the versions up to 0.9.9
// named them by version; later ones write the fingerprint itself, so a new release needs no row here.
export const RELEASE_FINGERPRINTS = Object.freeze({
    "0.9.0": "26b7078604d32cc7", // 59b2360
    "0.9.1": "26b7078604d32cc7", // 2375d2b
    "0.9.2": "ec3496e3c0c977c0", // ae33117
    "0.9.3": "ec3496e3c0c977c0", // a1dac0e
    "0.9.4": "ec3496e3c0c977c0", // be823f6
    "0.9.5": "ec3496e3c0c977c0", // a56254d
    "0.9.6": "ec3496e3c0c977c0", // 3b9853a
    "0.9.7": "9156887177bdadb0", // d39e9ce
    "0.9.8": "9156887177bdadb0", // 578c9ac
    "0.9.9": "9156887177bdadb0", // 2a688ae
});
