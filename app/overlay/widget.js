// One overlay widget window: the config comes from main (style, opacity, scale, what to show, the edit mode, and for
// the Dan widget the map's dan data — sent again whenever the map, the rate or the profile changes),
// snapshots of the play about 30 times a second while it is shown, and whether it is shown at all.
// Hidden, it draws nothing. Shown, the key lines are drawn every animation frame while a play runs (they move with its
// clock); everything else only when a snapshot or a config comes or the window's size or pixel ratio changes, and while
// a number or a graph's scale still eases (src/overlay/paintLoop.js).
// In the edit mode outside a play it shows made-up numbers, so there is something to place; they go on moving: the key
// lines every frame, the rest about 60 times a second (their numbers change every 100 ms).
import { setLang, t } from "../../src/i18n/i18n.js";
import { fakeSnapshot } from "../../src/overlay/fake.js";
import { createPaintLoop } from "../../src/overlay/paintLoop.js";
import { SCALE } from "../../src/overlay/settings.js";
import { clockAt, mountWidget } from "./render.js";

const api = window.overlayApi;
setLang(api.lang);
const widget = new URLSearchParams(location.search).get("w") || "kps";
const root = document.getElementById("widget");
const badge = document.getElementById("badge");
const grip = document.getElementById("grip");

let config = null;
let view = null;
let snapshot = null;
let receivedAt = 0;
let lastFake = 0;

function mount() {
    if (!config) return;
    document.body.classList.toggle("editing", config.edit);
    document.documentElement.style.zoom = String(config.scale);
    root.style.width = "100%";
    root.style.height = "100%";
    root.style.opacity = String(config.opacity);
    badge.textContent = `${t(`overlay.widget.${widget}`)} · ${t("overlay.edit.badge")}`;
    view = mountWidget(root, widget, { style: config.style, show: config.show, zoom: config.scale, dan: config.dan ?? null });
    if (snapshot) view.update(snapshot);
}

const faking = () => config?.edit && (!snapshot || snapshot.phase !== "playing");

// → whether something still eases
function paint(now) {
    if (!view) return false;
    if (faking()) {
        if (now - lastFake > 100) {
            view.update(fakeSnapshot(now));
            lastFake = now;
        }
        view.paint(now);
        return true;
    }
    return snapshot ? view.paint(clockAt(snapshot, receivedAt, now)) : false;
}

const loop = createPaintLoop({
    paint,
    live: () => view?.live === true && (faking() || (snapshot?.phase === "playing" && snapshot.running === true)),
    requestFrame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (id) => cancelAnimationFrame(id),
});

api.onConfig((c) => {
    config = c;
    mount();
    loop.wake();
});
api.onState((s) => {
    snapshot = s;
    receivedAt = performance.now();
    view?.update(s);
    loop.wake();
});
api.onVisible((on) => loop.setVisible(on));

// The canvases take the size they are shown at only when they are drawn (render.js sizedContext). A window resized
// (main's setBounds for a new scale or style lands after the config) or a screen of another pixel ratio (Windows'
// display scaling, another monitor) is drawn again at once: an idle widget (the results screen) would otherwise stay
// stretched or blurry until a snapshot that differs.
window.addEventListener("resize", () => loop.wake());
// the ratio can change with the size in CSS pixels the same: a query for the ratio of now, asked anew for each new one
function watchRatio() {
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => {
        loop.wake();
        watchRatio();
    }, { once: true });
}
watchRatio();

// the corner resizes: the scale follows the pointer (the window is sized by main from the scale)
grip.addEventListener("pointerdown", (event) => {
    if (!config?.edit) return;
    grip.setPointerCapture(event.pointerId);
    const start = { x: event.screenX, y: event.screenY, scale: config.scale, w: window.innerWidth, h: window.innerHeight };
    let pending = null;
    const move = (e) => {
        const grow = Math.max((start.w + e.screenX - start.x) / start.w, (start.h + e.screenY - start.y) / start.h);
        const scale = Math.min(SCALE.max, Math.max(SCALE.min, Math.round(start.scale * grow * 100) / 100));
        if (scale === pending) return;
        pending = scale;
        api.setScale(widget, scale);
    };
    const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
});
