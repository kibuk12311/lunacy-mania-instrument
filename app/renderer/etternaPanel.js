// Etterna's block on the Settings page (app/renderer/settingsPage.js). First the switch for Etterna as a whole (main
// keeps it, app/etternaClient.js): turned off, the app goes on as if no folder were linked, and the block shows only the
// switch, the folder kept and a note. Then its folder (picked, found or unlinked), and its charts: searched by pack,
// song, artist or difficulty, each with Etterna's own MSD at the chosen rate (0.7x–2.0x) and its dan, worked out on the
// background line for the rows shown; a click puts the chart on the card at that rate.
import { t } from "../../src/i18n/i18n.js";

const SEARCH_DELAY_MS = 200;
const RATES = Array.from({ length: 27 }, (_, i) => (0.7 + i * 0.05).toFixed(2));

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

const mmss = (ms) => {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// visible() → the block can be seen now (the Settings page is open)
export function initEtternaPanel({ panel, api = window.danApi, visible = () => true }) {
    if (!panel || !api?.etternaStatus) return null;
    const enable = el("label", "et-enable");
    const enableBox = el("input");
    enableBox.type = "checkbox";
    enable.title = t("etterna.panel.enableTitle");
    enable.append(enableBox, el("span", "", t("etterna.panel.enable")));
    const statusLine = el("div", "et-status");
    const folderLine = el("div", "et-folder muted");
    const pick = el("button", "small", t("etterna.panel.pick"));
    const detect = el("button", "small", t("etterna.panel.detect"));
    const unlink = el("button", "small", t("etterna.panel.unlink"));
    for (const b of [pick, detect, unlink]) b.type = "button";
    const actions = el("div", "ov-actions et-actions");
    actions.append(pick, detect, unlink);
    const answer = el("div", "et-answer muted");
    const offNote = el("div", "et-off-note muted");
    const search = el("input", "et-search");
    search.type = "search";
    search.placeholder = t("etterna.panel.searchPlaceholder");
    search.spellcheck = false;
    const rateSelect = el("select");
    for (const r of RATES) {
        const option = el("option", "", `${Number(r)}x`);
        option.value = r;
        rateSelect.append(option);
    }
    rateSelect.value = "1.00";
    const rateBox = el("label", "et-rate");
    rateBox.title = t("etterna.panel.rateTitle");
    rateBox.append(el("span", "muted", t("etterna.panel.rate")), rateSelect);
    const results = el("div", "et-results");
    const library = el("div", "et-library");
    library.append(search, rateBox, results);
    const note = el("div", "et-note muted", t("etterna.panel.note"));
    panel.replaceChildren(enable, statusLine, folderLine, actions, answer, offNote, library, note);

    let state = null;
    let token = 0;
    let timer = null;
    const rate = () => Number(rateSelect.value) || 1;
    const say = (text, cls = "muted") => {
        answer.className = `et-answer ${cls}`;
        answer.textContent = text ?? "";
    };

    async function runSearch() {
        const my = ++token;
        const at = rate();
        const r = await api.etternaSearch(search.value, at);
        if (my !== token) return;
        if (!r?.ok) {
            results.replaceChildren(el("div", "bad", t("etterna.panel.failed", { message: r?.message ?? "" })));
            return;
        }
        const danOf = new Map();
        const rows = r.rows.map((c) => {
            const row = el("button", "et-row");
            row.type = "button";
            const dan = el("span", "et-dan muted", c.skip ? t("etterna.panel.notRated", { reason: c.skip }) : t("etterna.panel.danPending"));
            danOf.set(c.id, dan);
            const meta = [c.pack, mmss(c.lengthMs), Number.isFinite(c.msdAtRate) ? t("etterna.panel.msd", { value: c.msdAtRate.toFixed(2) }) : ""].filter(Boolean).join(" · ");
            row.append(el("span", "et-name", `${c.artist} - ${c.title} [${c.version}]`), el("span", "et-meta muted", meta), dan);
            row.addEventListener("click", async () => {
                say(t("etterna.panel.working"));
                const s = await api.etternaSelect(c.id, rate());
                if (!s?.ok) return say(t("etterna.panel.failed", { message: s?.message ?? "" }), "bad");
                say(t("etterna.panel.selected", { name: s.label }), "ok");
                window.dispatchEvent(new CustomEvent("open-tab", { detail: { tab: "analysis" } }));
                return undefined;
            });
            return row;
        });
        const head = el("div", "et-count muted", rows.length >= 200 ? t("etterna.panel.countMore", { n: rows.length }) : t("etterna.panel.count", { n: rows.length }));
        results.replaceChildren(head, ...rows);
        // the dans of the rows shown, on the background line
        const ids = r.rows.map((c) => c.id);
        for (let i = 0; i < ids.length; i += 50) {
            const d = await api.etternaDans(ids.slice(i, i + 50), at, my);
            if (my !== token) return;
            if (!d?.ok) continue;
            for (const [id, v] of Object.entries(d.dans)) {
                const span = danOf.get(id);
                if (!span) continue;
                span.className = `et-dan ${v.numeric === null ? "muted" : "ok"}`;
                span.textContent = v.numeric === null ? t("etterna.panel.notRated", { reason: v.why ?? "" }) : v.label;
            }
        }
    }

    function render(s) {
        state = s;
        const linked = Boolean(s?.linked);
        const off = Boolean(s?.off);
        enableBox.checked = !off;
        for (const part of [statusLine, actions, note]) part.hidden = off;
        offNote.hidden = !off;
        offNote.textContent = s?.folder ? t("etterna.panel.offNote") : t("etterna.panel.offNoteNoFolder");
        statusLine.className = `et-status ${linked ? "ok" : "muted"}`;
        statusLine.textContent = !linked
            ? t("etterna.panel.notLinked")
            : s.scanning ? t("etterna.panel.scanning", { done: s.scanning.done, total: s.scanning.total }) : t("etterna.panel.linked", { n: s.size ?? 0 });
        folderLine.textContent = s?.folder ?? "";
        folderLine.hidden = !s?.folder;
        if (s?.message) say(s.message, "bad");
        unlink.hidden = !s?.folder;
        library.hidden = !linked;
        if (linked && !s.scanning && visible()) runSearch();
    }

    const act = (fn) => async () => {
        say(t("etterna.panel.working"));
        const r = await fn();
        if (r?.cancelled) return say("");
        if (!r?.ok) return say(r?.message ?? "", "bad");
        say("");
        render(await api.etternaStatus());
        return undefined;
    };
    enableBox.addEventListener("change", async () => {
        enableBox.disabled = true;
        try {
            const r = await api.etternaSetEnabled(enableBox.checked);
            if (!r?.ok) say(r?.message ?? "", "bad");
            else say("");
            render(await api.etternaStatus());
        } finally {
            enableBox.disabled = false;
        }
    });
    pick.addEventListener("click", act(() => api.etternaPickFolder()));
    detect.addEventListener("click", act(() => api.etternaDetect()));
    unlink.addEventListener("click", act(() => api.etternaUnlink()));
    search.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(runSearch, SEARCH_DELAY_MS);
    });
    rateSelect.addEventListener("change", () => { if (state?.linked) runSearch(); });

    // the block came into view (the Settings page opened): the list is searched afresh
    const shown = () => { if (state?.linked && !state.scanning) runSearch(); };
    api.onEtternaState?.(render);
    api.etternaStatus().then(render, () => {});
    return { render, shown };
}
