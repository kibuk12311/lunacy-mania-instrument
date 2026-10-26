// Whether the play widgets are on screen, with hysteresis, so a stray tosu frame never shows or hides a window.
// osu! reports its state as it is in memory and tosu passes it on every 150 ms; going into a map and straight back,
// a score opened from the leaderboard (the results state) or a reconnect all used to flash the windows in song select.
// Now: shown only after the "play" state has lasted showAfterMs and the play is really going on (its clock moves or
// judgements come; after trustAfterMs the state alone is enough), hidden only after "no play" has lasted hideAfterMs.

export function createVisibilityGate({ showAfterMs = 400, hideAfterMs = 300, trustAfterMs = 1500 } = {}) {
    let visible = false;
    let want = false;
    let since = 0; // when `want` last changed

    return {
        // want: the state asks for the widgets; advancing: the play shows signs of life; now: ms → shown or not
        update({ want: w, advancing = false, now }) {
            if (Boolean(w) !== want) {
                want = Boolean(w);
                since = now;
            }
            const lasted = now - since;
            if (!visible && want && lasted >= showAfterMs && (advancing || lasted >= trustAfterMs)) visible = true;
            else if (visible && !want && lasted >= hideAfterMs) visible = false;
            return visible;
        },
        // ms until update() may answer differently with nothing new coming in (null: it will not)
        pending(now) {
            if (want === visible) return null;
            const lasted = now - since;
            if (!want) return Math.max(0, hideAfterMs - lasted);
            // past showAfterMs it waits for a sign of life (a frame brings it) or for trustAfterMs
            return Math.max(0, (lasted < showAfterMs ? showAfterMs : trustAfterMs) - lasted);
        },
        visible: () => visible,
        reset() {
            visible = false;
            want = false;
            since = 0;
        },
    };
}
