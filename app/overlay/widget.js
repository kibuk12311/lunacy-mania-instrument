// One overlay widget window: the config comes from main (style, opacity, scale, what to show, the edit mode),
// snapshots of the play about 30 times a second; the canvases are drawn every animation frame in between.
// In the edit mode outside a play it shows made-up numbers, so there is something to place.
import { setLang, t } from "../../src/i18n/i18n.js";
import { fakeSnapshot } from "../../src/overlay/fake.js";
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
    view = mountWidget(root, widget, { style: config.style, show: config.show, zoom: config.scale });
    if (snapshot) view.update(snapshot);
}

api.onConfig((c) => {
    config = c;
    mount();
});
api.onState((s) => {
    snapshot = s;
    receivedAt = performance.now();
    view?.update(s);
});

const faking = () => config?.edit && (!snapshot || snapshot.phase !== "playing");

function frame(now) {
    if (view) {
        if (faking()) {
            if (now - lastFake > 100) {
                view.update(fakeSnapshot(now));
                lastFake = now;
            }
            view.paint(now);
        } else if (snapshot) {
            view.paint(clockAt(snapshot, receivedAt, now));
        }
    }
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

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
