// Analyzers whose code changed but whose answers were shown to be the same, bit for bit: the saved results of the
// one on the right are theirs too, so they share its results folder and the Session library does not analyse again.
// A row is added only after a side-by-side run (tools/bench-analyze.mjs, and old vs new over real maps in separate
// processes) found no difference; a change that moves any number gets no row, and an update then analyses again.
export const SAME_RESULTS = Object.freeze({
    // 0.10.0: one .osu parse and no repeated estimator runs, Sunny / Daniel inner loops (3x faster), min / max that
    // take huge charts (those used to stop with an error, and errors are never saved): 1200 cases of 600 real maps
    // and the review's ~4000 adversarial ones, 0 differences
    "9178bc2ee4b37d89": "9156887177bdadb0",
    // the 2/4 chordjack (a generator flavour, src/gen/flavours.js JumpQuad): the timeline keeps looking for the flavours
    // of 0.10.3 (ANALYSIS_FLAVOUR_IDS). 0.10.3 (9178bc2ee4b37d89) against this tree in separate processes, analyzeChart
    // and the details job at 1x and 1.25x over 644 maps (the tests' .osu files, 24 synthetic, 54 generated 2/4 and
    // other chordjacks, 548 4K maps of osu! Songs, 369 of them from 75 jack and chordjack packs): 1288 cases, 0
    // differences, though over all 22 flavours the detected list of 258 of those maps would have moved
    "043490a9111ff0b5": "9156887177bdadb0",
});

// The fingerprint a cache and the Session library are named by: the earlier one with the same answers, else its own.
export const resultsIdOf = (fingerprint) => SAME_RESULTS[fingerprint] ?? fingerprint;
