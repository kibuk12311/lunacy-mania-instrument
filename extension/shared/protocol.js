// Message names, port names and error codes shared by every part of the extension (extension/DESIGN.md §5).
export const MSG = Object.freeze({ ANALYZE: "lm:analyze", OSU: "lm:osu", INFO: "lm:info", CACHE_CLEAR: "lm:cache-clear" });
export const PORT_FETCH = "lm:fetch";
export const OFFSCREEN_TARGET = "lm-offscreen";
export const PLAYER_SOURCE = "lunacy-mania-player";
export const SITE_ORIGIN = "https://osu.ppy.sh";
export const PRIORITY = Object.freeze({ HIGH: "high", NORMAL: "normal", LOW: "low" });
export const ERR = Object.freeze({
    NETWORK: "network", HTTP: "http", NOT_FOUND: "not-found", RATE_LIMITED: "rate-limited",
    LOGIN: "login", LIMIT: "limit", DISABLED: "disabled", NOT_ZIP: "not-zip", TOO_BIG: "too-big", HOST: "host",
    PERMISSION: "permission", ANALYSIS: "analysis", TIMEOUT: "timeout", BAD_REQUEST: "bad-request",
    CANCELLED: "cancelled", CONTEXT: "context",
});
