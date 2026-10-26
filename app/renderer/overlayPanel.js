// The in-game overlay from the main window: its block on the Settings page (app/renderer/settingsPage.js) with the
// overlay on/off, a checkbox per widget, the move mode (the same as the hotkey) and a link to the overlay's settings window.
// The state is the overlay's own (userData\overlay.json, app/overlay/overlayManager.js): every change made here, in
// the tray, by the hotkey or in the settings window comes back as { settings, edit } and redraws the panel.
// It also tells main the player's skill of the profile in use (the picks tab's source: mania-tracker, hand-set or
// the local profile), for the Dan widget's "for you"; null while there is none.
import { t } from "../../src/i18n/i18n.js";
import { WIDGETS, hotkeyLabel } from "../../src/overlay/settings.js";
import { getProfile, onProfile } from "./profile.js";

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

function check(text, onChange) {
    const label = el("label");
    const box = el("input");
    box.type = "checkbox";
    box.addEventListener("change", () => onChange(box.checked));
    label.append(box, el("span", "", text));
    return { label, box };
}

// the profile's skill as main takes it: { skill } while one is ready, else { skill: null }
export const profileForOverlay = (p) => ({ skill: p?.state === "ready" && p.skill && typeof p.skill === "object" ? p.skill : null });

export function initOverlayPanel({ panel, api = window.danApi, profile = { getProfile, onProfile } }) {
    if (!panel || !api?.overlayGet) return null;
    let state = null;
    const tellProfile = (p) => {
        try {
            api.overlayProfile?.(profileForOverlay(p));
        } catch {
            // the overlay goes without "for you"
        }
    };
    tellProfile(profile.getProfile());
    profile.onProfile(tellProfile);

    const enabled = check(t("overlay.main.enabled"), (on) => api.overlaySet({ enabled: on }).then(render));
    const widgetBox = el("div", "ov-widgets");
    const widgets = WIDGETS.map((widget) => {
        const c = check(t(`overlay.widget.${widget}`), (on) => api.overlaySet({ widgets: { [widget]: { enabled: on } } }).then(render));
        c.box.dataset.widget = widget;
        widgetBox.append(c.label);
        return { widget, box: c.box };
    });
    const move = el("button", "ov-move");
    move.type = "button";
    move.addEventListener("click", () => api.overlaySetEdit(!state?.edit));
    const more = el("a", "ov-more", t("overlay.main.settings"));
    more.href = "#";
    more.addEventListener("click", (e) => {
        e.preventDefault();
        api.overlayOpenSettings();
    });
    const actions = el("div", "ov-actions");
    actions.append(move, more);
    panel.replaceChildren(enabled.label, widgetBox, actions);

    function render(payload) {
        if (!payload?.settings) return;
        state = payload;
        const s = payload.settings;
        enabled.box.checked = s.enabled;
        for (const { widget, box } of widgets) box.checked = s.widgets[widget].enabled;
        widgetBox.classList.toggle("off", !s.enabled);
        move.textContent = payload.edit ? t("overlay.main.moveDone") : t("overlay.main.move", { hotkey: hotkeyLabel() });
        move.classList.toggle("on", payload.edit);
    }

    api.onOverlaySettings(render);
    api.overlayGet().then(render);
    return { render, state: () => state };
}
