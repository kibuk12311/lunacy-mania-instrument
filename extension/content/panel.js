// The panel in an open shadow root (extension/DESIGN.md §5.7): one chip per 4K difficulty, the selected one's card,
// the dan on rates and the demo buttons. It only draws a view model (main.js builds it) and reports clicks as actions;
// every text goes in through textContent, never as HTML. The data-* attributes are the smoke test's hooks.
import { PANEL_CSS } from "./styles.js";
import { errorText, countText } from "./strings.js";
import { RATES, formatRate, rateKey } from "../shared/rates.js";

// The app's General pattern names (app/renderer/patternMode.js + src/gen/search.js NAME_FAMILY): a finder name as its
// family, the shares of one family summed. A name it does not know stays as it is.
const NAME_FAMILY = {
    Stream: "Stream", Rolls: "Stream", Trills: "Stream", Minitrills: "Stream",
    Jumpstream: "Jumpstream", Chordstream: "Jumpstream", Jumptrill: "Jumpstream", "Split Trill": "Jumpstream",
    "Double Stream": "Jumpstream", "Light Chordstream": "Jumpstream",
    Handstream: "Handstream", Brackets: "Handstream", "Chord Rolls": "Handstream",
    Chordjacks: "Chordjack", Quadstream: "Chordjack", "Dense Chordstream": "Chordjack",
    Jacks: "Jack", Minijacks: "Jack", Longjacks: "Jack", Gluts: "Jack",
};
const FAMILY_LABELS = { Stream: "Stream", Jumpstream: "Jumpstream", Handstream: "Handstream", Chordjack: "Chordjacks", Jack: "Jacks", Tech: "Tech" };
export const patternLabel = (name) => (name ? FAMILY_LABELS[NAME_FAMILY[name]] ?? name : name);
export function patternShares(top3) {
    const sums = new Map();
    for (const p of top3 ?? []) {
        const label = patternLabel(p?.name);
        if (!label) continue;
        sums.set(label, (sums.get(label) ?? 0) + (Number(p.share) || 0));
    }
    return [...sums].map(([name, share]) => ({ name, share })).sort((a, b) => b.share - a.share);
}

export function formatDuration(sec) {
    const total = Math.round(sec);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const fixed1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "—");

// An AnalyzeResponse (or undefined while it is coming) → the chip's / row's state.
export function stateOf(response) {
    if (!response) return "pending";
    if (!response.ok) return "error";
    const kind = response.result?.kind;
    return kind === "ok" || kind === "not-rice" || kind === "too-short" ? kind : "error";
}

// Why a result has no dan, in words, or null for "ok".
export function reasonText(t, response) {
    const state = stateOf(response);
    if (state === "pending") return t("card.counting");
    if (state === "ok") return null;
    if (state === "too-short") return t("card.tooShort");
    if (state === "not-rice") {
        const r = response.result;
        if (r.reason === "ln") return t("card.ln");
        if (r.reason === "mode") return t("card.notMania");
        return t("card.notFourKey", { keys: r.keys ?? "?" });
    }
    const message = response.ok ? response.result?.message || t("card.errorUnknown") : errorText(t, response.error);
    return t("card.error", { message });
}

function chipDanText(t, response) {
    const state = stateOf(response);
    if (state === "pending") return t("chip.counting");
    if (state === "too-short") return t("chip.tooShort");
    if (state === "error") return t("chip.error");
    if (state === "not-rice") {
        const r = response.result;
        if (r.reason === "ln") return t("chip.ln");
        if (r.reason === "mode") return t("chip.notMania");
        return t("chip.keys", { keys: r.keys ?? "?" });
    }
    return null;
}

export function createPanel({ doc = globalThis.document, t, lang = "en", onAction = () => {} } = {}) {
    const host = doc.createElement("section");
    host.setAttribute("data-lm-root", "");
    host.setAttribute("data-lm-state", "loading");
    const root = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = PANEL_CSS;
    const body = doc.createElement("div");
    body.className = "lm";
    root.append(style, body);

    // element helper: el("div", { class: "x", "data-a": "" }, child | "text" …); attribute values are set as text
    const el = (tag, attrs = {}, ...children) => {
        const node = doc.createElement(tag);
        for (const [name, value] of Object.entries(attrs)) {
            if (value === null || value === undefined || value === false) continue;
            if (name === "class") node.className = value;
            else node.setAttribute(name, value === true ? "" : String(value));
        }
        for (const child of children.flat()) {
            if (child === null || child === undefined || child === false) continue;
            if (typeof child === "string" || typeof child === "number") {
                const span = doc.createElement("span");
                span.textContent = String(child);
                node.append(span);
            } else node.append(child);
        }
        return node;
    };
    const text = (tag, attrs, value) => {
        const node = el(tag, attrs);
        node.textContent = String(value ?? "");
        return node;
    };

    function onClick(event) {
        const target = event?.target;
        const hit = target?.closest?.("[data-lm-chip],[data-lm-action],[data-lm-rates-toggle],[data-lm-rate-row]");
        if (!hit || hit.disabled || hit.hasAttribute?.("disabled")) return;
        event.preventDefault?.();
        if (hit.hasAttribute("data-lm-chip")) onAction({ type: "select", id: Number(hit.getAttribute("data-beatmap-id")) });
        else if (hit.hasAttribute("data-lm-rates-toggle")) onAction({ type: "toggle-rates" });
        else if (hit.hasAttribute("data-lm-rate-row")) onAction({ type: "rate", rate: Number(hit.getAttribute("data-rate")) });
        else {
            const action = hit.getAttribute("data-lm-action");
            const rate = hit.hasAttribute("data-rate") ? { rate: Number(hit.getAttribute("data-rate")) } : {};
            onAction({ type: action, id: Number(hit.getAttribute("data-beatmap-id")) || null, ...rate });
        }
    }
    root.addEventListener("click", onClick);

    function chip(diff, response, selected) {
        const state = stateOf(response);
        const r = response?.ok ? response.result : null;
        const okDan = state === "ok";
        const confidence = okDan && r.confidence ? ` — ${t("card.confidence", { confidence: r.confidence, spread: fixed1(r.halfWidth) })}` : "";
        const dan = okDan
            ? el("span", { class: "dan" }, text("span", { class: "lbl", "data-lm-label": "" }, r.label), text("span", { class: "num", "data-lm-num": "" }, fixed1(r.numeric)))
            : text("span", { class: "dan" }, chipDanText(t, response));
        return el("button", {
            type: "button",
            class: "chip",
            "data-lm-chip": true,
            "data-beatmap-id": diff.id,
            "data-state": state,
            "data-numeric": okDan && Number.isFinite(r.numeric) ? String(r.numeric) : null,
            "data-label": okDan ? r.label : null,
            "aria-current": selected ? "true" : null,
            title: `${diff.version}${confidence}`,
        }, text("span", { class: "ver" }, diff.version), dan);
    }

    function card(vm, diff, response) {
        const state = stateOf(response);
        const node = el("div", { class: "box card", "data-lm-card": true, "data-beatmap-id": diff.id, "data-state": state });
        node.append(text("div", { class: "ver" }, diff.version));
        if (state !== "ok") {
            node.append(text("div", { class: state === "error" ? "msg bad" : "msg" }, reasonText(t, response)));
            if (state === "error") node.append(text("button", { type: "button", class: "btn", "data-lm-action": "retry", "data-beatmap-id": diff.id }, t("card.retry")));
            return node;
        }
        const r = response.result;
        node.append(el("div", { class: "big" }, text("span", { class: "lbl" }, r.label), text("span", { class: "num" }, fixed1(r.numeric))));
        if (Number.isFinite(r.halfWidth)) {
            node.append(text("div", { class: "line" }, t("card.confidence", { confidence: r.confidence ?? "", spread: r.halfWidth.toFixed(1) })));
        }
        const stars = [
            Number.isFinite(r.msd?.overall) ? `MSD ${r.msd.overall.toFixed(2)}` : null,
            Number.isFinite(r.sunny) ? `Sunny ★${r.sunny.toFixed(2)}` : null,
        ].filter(Boolean);
        if (stars.length) node.append(text("div", { class: "line" }, stars.join(" · ")));
        node.append(text("div", { class: "primary", title: t("card.pattern") }, patternLabel(r.primary) ?? "—"));
        for (const { name, share } of patternShares(r.top3)) {
            const pct = Math.max(0, Math.min(100, Math.round(share * 100)));
            const bar = el("div", { class: "bar" });
            const fill = doc.createElement("i");
            fill.style.width = `${pct}%`;
            bar.append(fill);
            node.append(el("div", { class: "bar-row" }, text("span", {}, name), text("span", {}, `${pct}%`)), bar);
        }
        const tags = [
            r.tech ? "Tech" : null,
            Number.isFinite(r.bpm) ? `${Math.round(r.bpm)} BPM` : null,
            Number.isFinite(r.durationSec) ? formatDuration(r.durationSec) : null,
            Number.isFinite(diff.stars) && diff.stars > 0 ? t("card.stars", { stars: diff.stars.toFixed(2) }) : null,
        ].filter(Boolean);
        if (tags.length) node.append(el("div", { class: "tags" }, tags.map((tag) => text("span", { class: "tag" }, tag))));
        const calcs = r.calcs ? [["Mixed", r.calcs.mixed], ["Daniel", r.calcs.daniel], ["Azusa", r.calcs.azusa], ["Roxy", r.calcs.roxy], ["Companella", r.calcs.companella]]
            .filter(([, v]) => Number.isFinite(v)).map(([n, v]) => `${n} ${v.toFixed(1)}`) : [];
        if (calcs.length) node.append(text("div", { class: "line", title: t("card.calcs") }, calcs.join(" · ")));
        return node;
    }

    function rates(vm, response) {
        const open = !!vm.ratesOpen;
        const box = el("div", { class: "box" });
        box.append(text("button", {
            type: "button", class: "toggle", "data-lm-rates-toggle": true, "aria-expanded": open ? "true" : "false",
        }, `${t("rates.title")} ${open ? "▾" : "▸"}`));
        if (!open) return box;
        const mainState = stateOf(response);
        if (mainState === "pending") {
            box.append(text("div", { class: "note" }, t("rates.wait")));
            return box;
        }
        if (mainState !== "ok") {
            box.append(text("div", { class: "note" }, t("rates.none")));
            return box;
        }
        const base = response.result.numeric;
        const list = el("div", { class: "rates" });
        for (const rate of RATES) {
            const key = rateKey(rate);
            const answer = key === 1 ? response : vm.rates?.get(key);
            const state = stateOf(answer);
            const r = state === "ok" ? answer.result : null;
            const current = rateKey(vm.demoRate ?? 1) === key;
            const delta = r && Number.isFinite(r.numeric) && Number.isFinite(base) ? r.numeric - base : null;
            const deltaText = delta === null || key === 1 ? "" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}`;
            const words = state === "ok" ? r.label : state === "pending" ? t("rates.counting") : reasonText(t, answer);
            const row = el("button", {
                type: "button", class: "rate", "data-lm-rate-row": true, "data-rate": formatRate(rate), "data-state": state,
                "data-numeric": r && Number.isFinite(r.numeric) ? String(r.numeric) : null, "data-current": current,
                title: t("rates.hint"),
            }, text("span", { class: "r" }, `${formatRate(rate)}×`), text("span", { class: "lbl" }, words),
            text("span", { class: "num" }, r ? fixed1(r.numeric) : ""), text("span", { class: "d" }, deltaText),
            text("span", { class: "now" }, current ? t("rates.now") : ""));
            if (state === "error" && key !== 1) {
                // a failed rate: its row (still picks the demo rate) and a small «Ещё раз» beside it
                row.setAttribute("title", `${words}
${t("rates.hint")}`);
                list.append(el("div", { class: "rate-line", "data-state": "error" }, row, text("button", {
                    type: "button", class: "rate-retry", "data-lm-action": "retry-rate", "data-rate": formatRate(rate), "data-beatmap-id": vm.selectedId,
                }, t("card.retry"))));
            } else list.append(row);
        }
        box.append(list);
        return box;
    }

    function play(vm, diff) {
        const box = el("div", { class: "box play" });
        box.append(text("div", { class: "title" }, t("play.title")));
        const rate = formatRate(vm.demoRate ?? 1);
        const preview = vm.preview ?? {};
        const full = vm.full ?? {};
        const note = (value, warn = false) => text("span", { class: warn ? "note warn" : "note" }, value);
        const button = (action, label, disabled, notes, main = false) => {
            const b = el("button", { type: "button", class: main ? "btn main" : "btn", "data-lm-action": action, "data-beatmap-id": diff.id, disabled: !!disabled });
            b.append(text("span", {}, label), ...notes);
            return b;
        };
        box.append(button("play-preview", t("play.preview"), preview.disabled, [
            note(preview.disabled ? t("play.previewNone") : `${t("play.previewNote")} · ${t("play.rate", { rate })}`, false),
            preview.warn && !preview.disabled ? note(t("play.previewWarn"), true) : null,
        ].filter(Boolean), true));
        box.append(button("play-full", t("play.full"), full.disabled, [
            note(full.disabled ? t("play.fullDisabled") : t("play.fullNote")),
            !full.disabled && full.login === false ? note(t("play.fullLoggedOut"), true) : null,
        ].filter(Boolean)));
        box.append(button("play-file", t("play.file"), false, [note(t("play.fileNote"))]));
        box.append(text("div", { class: "note" }, t("play.keys")));
        return box;
    }

    // which control had focus, so a re-render can give it back
    function focusKey() {
        const active = root.activeElement;
        if (!active?.getAttribute) return null;
        for (const attr of ["data-lm-chip", "data-lm-rates-toggle"]) {
            if (active.hasAttribute(attr)) return `[${attr}]${attr === "data-lm-chip" ? `[data-beatmap-id="${active.getAttribute("data-beatmap-id")}"]` : ""}`;
        }
        if (active.hasAttribute("data-lm-rate-row")) return `[data-lm-rate-row][data-rate="${active.getAttribute("data-rate")}"]`;
        if (active.hasAttribute("data-lm-action")) {
            const rate = active.getAttribute("data-rate");
            return `[data-lm-action="${active.getAttribute("data-lm-action")}"]${rate ? `[data-rate="${rate}"]` : ""}`;
        }
        return null;
    }

    function render(vm) {
        const key = focusKey();
        const diffs = vm.diffs ?? [];
        const selected = diffs.find((d) => d.id === vm.selectedId) ?? diffs[0];
        const results = vm.results ?? new Map();
        const allFinal = diffs.every((d) => stateOf(results.get(d.id)) !== "pending");
        host.setAttribute("data-set-id", String(vm.setId ?? ""));
        host.setAttribute("data-lm-state", allFinal ? "ready" : "loading");
        host.setAttribute("lang", lang);
        host.setAttribute("aria-label", t("panel.aria"));

        const head = el("div", { class: "head" }, text("span", { class: "title" }, t("panel.title")), text("span", { class: "count" }, countText(t, diffs.length, lang)));
        const foreign = !!vm.foreign;
        const chips = el("div", { class: "chips", role: "group", "aria-label": t("panel.subtitle") }, diffs.map((d) => chip(d, results.get(d.id), !foreign && d === selected)));
        const parts = [head, chips];
        if (foreign) {
            // osu-web's picker is on a 7K / osu! / convert difficulty: no card, a short line instead
            parts.push(text("div", { class: "box foreign", "data-lm-foreign": true }, t("panel.notFourK")));
        } else if (selected) {
            const response = results.get(selected.id);
            parts.push(el("div", { class: "grid" }, card(vm, selected, response), el("div", { class: "side" }, rates(vm, response), play(vm, selected))));
        }
        const foot = el("div", { class: "foot" }, text("span", {}, vm.appVersion ? t("panel.footer", { version: vm.appVersion }) : "Lunacy mania"), text("span", {}, t("panel.footerHint")));
        parts.push(foot);
        body.replaceChildren(...parts);
        if (key) root.querySelector(key)?.focus?.();
    }

    function destroy() {
        root.removeEventListener("click", onClick);
        host.remove();
    }

    return { host, root, render, destroy };
}
