// The in-game overlay from the main window: the OV button in the card's footer opens a small panel with the overlay
// on/off, a checkbox per widget, the move mode (the same as the hotkey) and a link to the overlay's settings window.
// The state is the overlay's own (userData\overlay.json, app/overlay/overlayManager.js): every change made here, in
// the tray, by the hotkey or in the settings window comes back as { settings, edit } and redraws the panel.
import { t } from "../../src/i18n/i18n.js";
import { WIDGETS, hotkeyLabel } from "../../src/overlay/settings.js";

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

export function initOverlayPanel({ button, panel, api = window.danApi }) {
    if (!button || !panel || !api?.overlayGet) return null;
    let state = null;

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
    panel.replaceChildren(el("h4", "", t("overlay.set.heading")), enabled.label, widgetBox, actions);

    function render(payload) {
        if (!payload?.settings) return;
        state = payload;
        const s = payload.settings;
        enabled.box.checked = s.enabled;
        for (const { widget, box } of widgets) box.checked = s.widgets[widget].enabled;
        widgetBox.classList.toggle("off", !s.enabled);
        move.textContent = payload.edit ? t("overlay.main.moveDone") : t("overlay.main.move", { hotkey: hotkeyLabel() });
        move.classList.toggle("on", payload.edit);
        button.classList.toggle("live", s.enabled);
        button.classList.toggle("on", !panel.hidden || payload.edit);
    }

    const open = (on) => {
        panel.hidden = !on;
        button.setAttribute("aria-expanded", String(on));
        button.classList.toggle("on", on || Boolean(state?.edit));
    };
    button.addEventListener("click", (e) => {
        e.stopPropagation();
        open(panel.hidden);
    });
    // a click elsewhere closes it
    document.addEventListener("click", (e) => {
        if (!panel.hidden && !panel.contains(e.target) && e.target !== button) open(false);
    });
    api.onOverlaySettings(render);
    api.overlayGet().then(render);
    return { render, open };
}
