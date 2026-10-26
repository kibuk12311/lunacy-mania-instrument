// «Автоподбор» / "Auto" in the create tab (0.9.8): one click decides everything for the loaded song
// (src/gen/autoPlan.js), puts it into the normal controls (the dan picker, the pattern chips, the parts and their own
// patterns and ranges, the character sliders, the grids, the model picker) and makes the map with them. The summary
// line under the buttons says what was chosen; «изменить выбор» hides it and brings the controls into view, so the
// player can tweak them and press «Создать карту».
import { autoPlan, autoSummary } from "../../src/gen/autoPlan.js";
import { kindText } from "./timeline.js";
import { t } from "../../src/i18n/i18n.js";

const PROFILE_WAIT_MS = 3000; // a slow mania-tracker must not hold the click up: without an answer, no profile

const MODEL_KEYS = {
    auto: "create.auto.model.auto", xgb3: "create.auto.model.xgb3", s: "create.auto.model.s", m: "create.auto.model.m", l: "create.auto.model.l",
};
const lower = (s) => (s ? s[0].toLocaleLowerCase() + s.slice(1) : s);

// The profile in use, or null when it does not answer within PROFILE_WAIT_MS (or fails).
export async function profileFor(ensureProfile, waitMs = PROFILE_WAIT_MS) {
    if (typeof ensureProfile !== "function") return null;
    try {
        return await Promise.race([Promise.resolve().then(ensureProfile), new Promise((resolve) => setTimeout(() => resolve(null), waitMs))]);
    } catch {
        return null;
    }
}

// Puts a plan into the controls. controls: { diffList, setPatterns(Map), setMix(mix), stamina, burst (the slider
// inputs), timing (setSnaps), options (apply), timeline (setParts) } — each one optional.
export function applyPlan(plan, controls) {
    controls.diffList?.setRows([{ from: plan.from, to: plan.to }]);
    controls.setPatterns?.(new Map(plan.patterns.map((p) => [p.name, p.share])));
    controls.setMix?.("sections");
    if (controls.stamina) controls.stamina.value = String(Math.round(plan.stamina * 100));
    if (controls.burst) controls.burst.value = String(Math.round(plan.burst * 100));
    controls.timing?.setSnaps?.(plan.snaps);
    controls.options?.apply?.({ modelSize: plan.model, candidates: plan.candidates, repeats: plan.repeats });
    // the parts as the plan has them, marked as set (a timing edit then does not find them again over the top)
    if (!plan.wholeSong) controls.timeline?.setParts(plan.parts.map((p) => ({ ...p, edited: true })));
}

// The summary's lines for the window's language.
export function summaryLines(plan) {
    return autoSummary(plan, { kindName: (k) => lower(kindText(k)), modelName: (size) => t(MODEL_KEYS[size] ?? MODEL_KEYS.auto) });
}

// root = #auto-summary: the lines, then «изменить выбор» (onEdit).
export function renderSummary(root, lines, onEdit) {
    if (!root) return;
    const doc = root.ownerDocument ?? globalThis.document;
    const kids = lines.map((text, i) => {
        const line = doc.createElement("div");
        line.className = i === 0 ? "auto-line" : "auto-line muted";
        line.textContent = text;
        return line;
    });
    const edit = doc.createElement("button");
    edit.className = "small link auto-edit";
    edit.dataset.role = "auto-edit";
    edit.textContent = t("create.auto.edit");
    edit.title = t("create.auto.editHint");
    edit.addEventListener("click", () => onEdit?.());
    root.replaceChildren(...kids, edit);
    root.hidden = false;
}

// The click: the plan from the song and the profile, the controls filled, the summary shown, then generate().
// deps: { song() → { bpm, durationMs, envelope, stems } | null, parts() → the timeline's parts, ensureProfile,
// available() → genOptions.available(), controls (applyPlan), summaryRoot, onEdit, generate, setStatus, busy() }.
export async function runAuto(deps) {
    if (deps.busy?.()) return null;
    const song = deps.song();
    if (!song) {
        deps.setStatus?.(t("create.auto.noSong"));
        return null;
    }
    const profile = await profileFor(deps.ensureProfile, deps.profileWaitMs);
    const plan = autoPlan({
        song, parts: (deps.parts?.() ?? []).map(({ startMs, endMs, kind }) => ({ startMs, endMs, kind })), profile, available: deps.available?.() ?? {},
    });
    applyPlan(plan, deps.controls ?? {});
    renderSummary(deps.summaryRoot, summaryLines(plan), deps.onEdit);
    await deps.generate?.();
    return plan;
}
