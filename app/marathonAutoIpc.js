// The auto-marathon's main-process side: checks what the renderer asks for, takes the final dan (the shared
// profile or a manual one), turns the template into one target per map, runs one auto-marathon at a time and
// lets "Stop" reach it. Never throws; every refusal is { ok:false, message } in the current language.
import { templateById, stepTargets, CUSTOM } from "../src/rate/marathonTemplates.js";
import { patternById } from "../src/recommend/catalog.js";
import { playerDanFor } from "../src/recommend/skill.js";
import { MIN_DAN, MAX_DAN, danOf } from "./validate.js";
import { t } from "../src/i18n/i18n.js";

const EPS = 1e-9;
const MAX_PATTERNS = 3;

// The request as the auto-marathon runs it, or the reason it can't run.
function cleanRequest(req, profile) {
    if (!req || typeof req !== "object" || Array.isArray(req)) return t("marathon.err.badTemplate");
    const tpl = templateById(req.templateId);
    if (!tpl) return t("marathon.err.badTemplate");
    const ids = Array.isArray(req.patternIds) ? [...new Set(req.patternIds)] : [];
    if (!ids.length || ids.length > MAX_PATTERNS || !ids.every((id) => typeof id === "string" && patternById(id))) {
        return t("marathon.err.badPatterns");
    }
    let shape = {};
    if (tpl.id === "custom") {
        const { count, step } = req;
        if (typeof count !== "number" || !Number.isInteger(count) || count < CUSTOM.minCount || count > CUSTOM.maxCount) return t("marathon.err.badCount");
        if (typeof step !== "number" || !Number.isFinite(step) || step < CUSTOM.minStep - EPS || step > CUSTOM.maxStep + EPS) return t("marathon.err.badStep");
        shape = { count, step };
    }

    let finalDan = null;
    if (req.source === "manual") {
        const dan = danOf(req.manualDan);
        if (dan === null || dan < MIN_DAN - EPS || dan > MAX_DAN + EPS) return t("marathon.err.badDan");
        finalDan = dan;
    } else if (req.source === "profile") {
        const current = profile.current();
        if (!current?.ok) return t("marathon.err.noProfile");
        const own = playerDanFor(current.skill, ids[0]);
        if (!own) return t("marathon.err.noTileDan");
        finalDan = own.dan;
    } else {
        return t("marathon.err.badDan");
    }

    const targets = stepTargets(tpl, finalDan, shape);
    return {
        tpl, finalDan, targets,
        run: { targets, patternIds: ids, lengthId: tpl.lengthId, rankedOnly: Boolean(req.rankedOnly), skipPlayed: Boolean(req.skipPlayed) },
    };
}

// auto: createAutoMarathon(...) (src/rate/autoMarathon.js); profile: the shared profile service (current()).
export function createMarathonAutoHandlers({ auto, profile, log = () => {} }) {
    let running = null; // { cancelled } of the auto-marathon in progress

    async function start(req) {
        if (running) return { ok: false, message: t("marathon.err.autoBusy") };
        let clean;
        try {
            clean = cleanRequest(req, profile);
        } catch (error) {
            return { ok: false, message: String(error?.message || t("marathon.err.badTemplate")) };
        }
        if (typeof clean === "string") return { ok: false, message: clean };
        const token = { cancelled: false };
        running = token;
        const { tpl, finalDan, targets, run } = clean;
        try {
            log(`marathon auto ${tpl.id} → ${finalDan} [${targets.join(", ")}] ${run.patternIds.join("/")}${run.skipPlayed ? ", skip played" : ""}${run.rankedOnly ? ", ranked" : ""}`);
            const out = await auto.run(run, () => token.cancelled);
            log(`marathon auto done: ${out.entries.length}/${targets.length} maps, ${out.warnings.length} warnings${out.cancelled ? ", stopped" : ""}`);
            return {
                ok: true, entries: out.entries, warnings: out.warnings, ...(out.cancelled ? { cancelled: true } : {}),
                templateId: tpl.id, finalDan, plan: targets,
            };
        } catch (error) {
            log(`marathon auto failed: ${error?.message}`);
            return { ok: false, message: String(error?.message || error) };
        } finally {
            if (running === token) running = null;
        }
    }

    function cancel() {
        if (running) running.cancelled = true;
        return { ok: true };
    }

    return { start, cancel };
}
