// Written by tools/calibrate-sections.mjs (fit) from 3359 corpus charts across dans (22964 parts): the
// correction of a part's raw dan (src/analysis/sections.js calibratedDan). The hardest part against the whole map's
// dan on the held-out third (1177 charts): raw bias -0.113, MAE 0.462, RMSE 0.672;
// corrected bias -0.023, MAE 0.424, RMSE 0.59.
export const CALIBRATION = Object.freeze({
    knots: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19],
    offsets: [-0.654, -0.668, 0.024, 0.237, -0.021, -0.408, -0.61, -0.546, -0.654, -0.673],
    lengthGain: -0.293,
    supportGain: 0.527,
});
