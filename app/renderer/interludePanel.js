// Interlude's block on the Settings page (app/renderer/settingsPage.js): its folder (picked, found or unlinked) and its library,
// searched by artist, title, difficulty name or creator; a click puts the chart on the card (dan, patterns, MSD,
// rates), and the rate tab then works on it. Above the library: following the running game (the card shows what is
// selected in Interlude, the overlay its plays, through app/interludeReader.js) with its state in words, and the
// setting that lets the reader download .NET's DAC file once when none matches (off by default). The IL button under
// the card (there only while a folder is linked) shows the live state and opens this block, for the library.
import { t } from "../../src/i18n/i18n.js";
import { onInterludeState } from "./interlude.js";

const SEARCH_DELAY_MS = 200;

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

// button: the IL button under the card (or null); onOpen(): it was clicked; visible() → the block can be seen now
export function initInterludePanel({ button = null, panel, api = window.danApi, onOpen = () => {}, visible = () => true }) {
    if (!panel || !api?.interludeStatus) return null;
    const statusLine = el("div", "il-status");
    const folderLine = el("div", "il-folder muted");
    const pick = el("button", "small", t("interlude.panel.pick"));
    const detect = el("button", "small", t("interlude.panel.detect"));
    const unlink = el("button", "small", t("interlude.panel.unlink"));
    for (const b of [pick, detect, unlink]) b.type = "button";
    const actions = el("div", "ov-actions il-actions");
    actions.append(pick, detect, unlink);
    const answer = el("div", "il-answer muted");
    const search = el("input", "il-search");
    search.type = "search";
    search.placeholder = t("interlude.panel.searchPlaceholder");
    search.spellcheck = false;
    const results = el("div", "il-results");
    const libraryBox = el("div", "il-library");
    libraryBox.append(search, results);
    const note = el("div", "il-note muted", t("interlude.panel.note"));
    // following the running game
    const check = (label, title) => {
        const box = el("label", "il-check");
        const input = el("input");
        input.type = "checkbox";
        box.title = title;
        box.append(input, el("span", "", label));
        return { box, input };
    };
    const liveCheck = check(t("interlude.panel.live"), t("interlude.panel.liveTitle"));
    const downloadCheck = check(t("interlude.panel.allowDownload"), t("interlude.panel.allowDownloadTitle"));
    const liveLine = el("div", "il-live muted");
    const liveBox = el("div", "il-live-box");
    liveBox.append(liveCheck.box, liveLine, downloadCheck.box);
    panel.replaceChildren(statusLine, folderLine, actions, answer, liveBox, libraryBox, note);

    let state = null;
    let token = 0;
    let timer = null;

    const say = (text, cls = "muted") => {
        answer.className = `il-answer ${cls}`;
        answer.textContent = text ?? "";
    };

    async function runSearch() {
        const my = ++token;
        const r = await api.interludeSearch(search.value);
        if (my !== token) return;
        if (!r?.ok) {
            results.replaceChildren(el("div", "bad", t("interlude.failed", { message: r?.message ?? "" })));
            return;
        }
        const rows = r.items.map((c) => {
            const row = el("button", "il-row");
            row.type = "button";
            row.append(el("span", "il-name", `${c.artist} - ${c.title} [${c.version}]`),
                el("span", "il-meta muted", [c.bpm ? `${c.bpm} BPM` : "", mmss(c.lengthMs), c.creator].filter(Boolean).join(" · ")));
            row.addEventListener("click", async () => {
                say(t("interlude.panel.loading"));
                const s = await api.interludeSelect(c.hash);
                if (!s?.ok) return say(t("interlude.failed", { message: s?.message ?? "" }), "bad");
                say(t(s.audio ? "interlude.panel.selected" : "interlude.panel.selectedNoAudio", { name: s.label }), "ok");
                // the card shows it: back to the analysis tab's card
                window.dispatchEvent(new CustomEvent("open-tab", { detail: { tab: "analysis" } }));
                return undefined;
            });
            return row;
        });
        const head = el("div", "il-count muted", r.total > r.items.length
            ? t("interlude.panel.countMore", { n: r.items.length, total: r.total })
            : t("interlude.panel.count", { n: r.total }));
        results.replaceChildren(head, ...rows);
    }

    function render(s) {
        state = s;
        const linked = Boolean(s?.linked);
        if (button) {
            button.hidden = !linked;
            button.classList.toggle("live", linked);
            button.title = linked ? t("settings.il.openTitle") : t("interlude.badge.title");
        }
        statusLine.className = `il-status ${linked ? "ok" : "muted"}`;
        statusLine.textContent = linked
            ? (Number.isFinite(s.size) ? t("interlude.panel.linked", { n: s.size }) : t("interlude.panel.linkedNoCount"))
            : t("interlude.panel.notLinked");
        folderLine.textContent = s?.folder ?? "";
        folderLine.hidden = !s?.folder;
        if (s?.message) say(s.message, "bad");
        unlink.hidden = !s?.folder;
        libraryBox.hidden = !linked;
        if (linked && visible()) runSearch();
    }

    const act = (fn) => async () => {
        say(t("interlude.working"));
        const r = await fn();
        if (r?.cancelled) return say("");
        if (!r?.ok) return say(r?.message ?? "", "bad");
        say("");
        render(await api.interludeStatus());
        return undefined;
    };
    pick.addEventListener("click", act(() => api.interludePickFolder()));
    detect.addEventListener("click", act(() => api.interludeDetect()));
    unlink.addEventListener("click", act(() => api.interludeUnlink()));
    search.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(runSearch, SEARCH_DELAY_MS);
    });

    // the block came into view (the Settings page opened): the library is searched afresh
    const shown = ({ focus = false } = {}) => {
        if (!state?.linked) return;
        runSearch();
        if (focus) search.focus();
    };
    button?.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpen();
    });
    function renderLive(info) {
        if (!info?.ok) return;
        const s = info.state ?? {};
        liveCheck.input.checked = Boolean(info.settings?.follow);
        downloadCheck.input.checked = Boolean(info.settings?.allowDownload);
        liveLine.textContent = info.text ?? "";
        const bad = s.status === "error" || s.status === "missing" || s.status === "crashed" || s.warn;
        liveLine.className = `il-live ${bad ? "bad" : s.status === "attached" ? "ok" : "muted"}`;
        button?.classList.toggle("attached", s.status === "attached");
        button?.classList.toggle("warn", Boolean(bad));
    }
    const setLive = (patch) => async () => {
        liveCheck.input.disabled = true;
        downloadCheck.input.disabled = true;
        try {
            renderLive(await api.interludeLiveSet(patch()));
        } finally {
            liveCheck.input.disabled = false;
            downloadCheck.input.disabled = false;
        }
    };
    liveCheck.input.addEventListener("change", setLive(() => ({ live: liveCheck.input.checked })));
    downloadCheck.input.addEventListener("change", setLive(() => ({ allowDownload: downloadCheck.input.checked })));
    api.onInterludeLive?.(renderLive);
    api.interludeLiveGet?.().then(renderLive, () => {});

    onInterludeState(render);
    return { render, shown, renderLive };

}
