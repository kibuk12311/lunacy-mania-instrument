// Interlude in the window: what main says of it (linked folder, the chart on the card) and the two buttons every tab
// that makes maps or lists shows once a folder is linked: "→ Interlude" for a map (an .osz shown in Explorer to drop
// onto Interlude's window, which brought to the front) and "Playlist in Interlude" for a list of maps.
import { t } from "../../src/i18n/i18n.js";

let state = { linked: false, folder: null, size: null, selected: null };
const listeners = new Set();
let started = false;

export const interludeState = () => state;
export const interludeLinked = () => Boolean(state.linked);

function setState(next) {
    state = { linked: false, ...next };
    for (const cb of [...listeners]) {
        try {
            cb(state);
        } catch {
            // one listener's problem
        }
    }
}

// cb(state) now and on every change; → unsubscribe
export function onInterludeState(cb) {
    listeners.add(cb);
    cb(state);
    return () => listeners.delete(cb);
}

export function initInterludeState(api = window.danApi) {
    if (started || !api?.interludeStatus) return;
    started = true;
    api.onInterludeState?.((s) => setState(s ?? {}));
    api.interludeStatus().then((s) => { if (s && typeof s === "object" && !("ok" in s && s.ok === false)) setState(s); }, () => {});
}

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

// A small button and its answer, shown only while an Interlude folder is linked.
// run() → the answer text and whether it went well: { ok, text }.
function linkedButton(label, title, run) {
    const box = el("span", "il-send");
    const button = el("button", "small il-button", label);
    button.type = "button";
    button.title = title;
    const answer = el("span", "il-answer muted");
    button.addEventListener("click", async () => {
        button.disabled = true;
        answer.className = "il-answer muted";
        answer.textContent = t("interlude.working");
        try {
            const r = await run();
            answer.className = `il-answer ${r.ok ? "ok" : "bad"}`;
            answer.textContent = r.text;
        } catch (error) {
            answer.className = "il-answer bad";
            answer.textContent = String(error?.message ?? error);
        } finally {
            button.disabled = false;
        }
    });
    box.append(button, answer);
    const stop = onInterludeState((s) => { box.hidden = !s.linked; });
    box.dispose = stop;
    return box;
}

// "→ Interlude" for files(): one .osz the app made or .osu files of one folder.
export function sendButton(files, api = window.danApi) {
    return linkedButton(t("interlude.send"), t("interlude.sendTitle"), async () => {
        const list = (typeof files === "function" ? files() : files) ?? [];
        const r = await api.interludeSend(Array.isArray(list) ? list : [list]);
        return { ok: Boolean(r?.ok), text: r?.ok ? r.message : t("interlude.failed", { message: r?.message ?? "" }) };
    });
}

// For a result line: the send button while a folder is linked, else nothing ([] or [button], to spread).
export const sendButtons = (files) => (interludeLinked() ? [sendButton(files)] : []);

// The answer to a playlist export in words.
export function exportText(r) {
    if (!r?.ok) {
        const base = r?.running ? r.message : t("interlude.failed", { message: r?.message ?? "" });
        return r?.missing?.length ? `${base} ${t("interlude.export.missing", { n: r.missing.length, list: r.missing.slice(0, 5).join("; ") })}` : base;
    }
    const parts = [t("interlude.export.done", { name: r.name, n: r.count })];
    if (r.missing?.length) parts.push(t("interlude.export.missing", { n: r.missing.length, list: r.missing.slice(0, 5).join("; ") }));
    return parts.join(" ");
}

// "Playlist in Interlude" for request() → { name, items: [{ beatmapId?, md5?, path?, rate?, label }] }.
export function exportButton(request, api = window.danApi) {
    return linkedButton(t("interlude.export"), t("interlude.exportTitle"), async () => {
        const req = typeof request === "function" ? request() : request;
        const r = await api.interludeExport({ kind: "playlist", ...req });
        return { ok: Boolean(r?.ok), text: exportText(r) };
    });
}
