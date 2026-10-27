// When an overlay page draws its canvases (the widget windows, the settings window's previews).
// A page that is not on screen draws nothing: a hidden widget window (background throttling off) would otherwise go on
// painting at the screen's refresh rate, 500 times a second on a 500 Hz monitor, for nothing.
// On screen it draws every animation frame only while live() says the picture moves by itself (a play's key lines on
// the play's clock, the edit mode's made-up numbers). Otherwise it draws one frame per wake() (a new snapshot or
// config) and, while paint() says something is still easing (a big number, a graph's scale), one more about every
// EASE_MS, then rests.
// requestFrame / cancelFrame: requestAnimationFrame and cancelAnimationFrame; setTimer / clearTimer: the timers.
export const EASE_MS = 16; // the easing frames between two snapshots: about 60 a second, whatever the screen's rate

export function createPaintLoop({
    paint, live = () => false, requestFrame, cancelFrame, setTimer = setTimeout, clearTimer = clearTimeout, easeMs = EASE_MS,
}) {
    let visible = false;
    let frameId = null; // the animation frame asked for
    let timer = null; // the next easing frame, waiting

    function frame(now) {
        frameId = null;
        if (!visible) return;
        const moving = paint(now);
        if (live()) wake();
        else if (moving && timer === null) {
            timer = setTimer(() => {
                timer = null;
                wake();
            }, easeMs);
        }
    }

    // something new to draw: one frame, at the screen's next refresh
    function wake() {
        if (!visible || frameId !== null) return;
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
        frameId = requestFrame(frame);
    }

    function stop() {
        if (frameId !== null) cancelFrame(frameId);
        if (timer !== null) clearTimer(timer);
        frameId = null;
        timer = null;
    }

    return {
        wake,
        // shown: drawn at once, with what it has; hidden: nothing more until shown again
        setVisible(on) {
            visible = Boolean(on);
            if (visible) wake();
            else stop();
        },
        visible: () => visible,
        // a frame or an easing frame is coming
        busy: () => frameId !== null || timer !== null,
    };
}
