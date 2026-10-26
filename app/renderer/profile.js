// The shared player profile in the window, for every tab: what main's profile service holds, or the profile set by
// hand in the picks tab while its source is "manual" (no mania-tracker needed).
// getProfile() → { state: "idle"|"loading"|"ready"|"none"|"failed", player?, skill?, message?, manual? };
// a hand-set one is { state: "ready", manual: true, player: { id: null, username }, skill (manualSkill), profile };
// the local profile (source "local", learnt from the player's own plays in main: app/localProfileService.js) is
// { state: "ready", local: true, player: { id: null, username }, skill }, or { state: "none", local: true, skill }
// while it has no dan yet (too few plays), { state: "loading", local: true } before main answered.
// onProfile(cb) → unsubscribe, cb on every change (also on "profile-changed" from main and on manualChanged());
// ensureProfile() asks main at most once a session (after "failed", again no sooner than 60 s later), and not at
// all while the hand-set profile is the one in use; getTrackerProfile() / ensureTrackerProfile() are mania-tracker's
// alone (plays and progress exist only there).
import { manualProfileOf, manualSkill } from "../../src/recommend/manualProfile.js";
import { t } from "../../src/i18n/i18n.js";

const RETRY_MS = 60_000;
// the picks tab's settings: { source: "tracker"|"manual"|"local", query, manualProfile: { name, speed, jack, stamina, tech } }
const SETTINGS_KEY = "rec-settings";

export function createProfileClient({
    api = () => globalThis.window?.danApi, storage = () => globalThis.localStorage, now = Date.now, retryMs = RETRY_MS,
} = {}) {
    let state = { state: "idle" };
    const subscribers = new Set();
    let listening = false;
    let asked = false;
    let failedAt = null;
    let pending = null;
    let local = null; // { skill } of the local profile once main told it
    let localPending = null;

    function saved() {
        try {
            const data = JSON.parse(storage()?.getItem(SETTINGS_KEY) ?? "null");
            return data && typeof data === "object" ? data : null;
        } catch {
            return null;
        }
    }

    // the hand-set profile while the picks tab's source is "manual", else null
    function manualState() {
        const s = saved();
        if (s?.source !== "manual") return null;
        const profile = manualProfileOf(s);
        const skill = manualSkill(profile);
        if (!skill) return null;
        return { state: "ready", manual: true, player: { id: null, username: profile.name || t("recommend.manual.defaultName"), avatarUrl: null }, skill, profile };
    }

    // the local profile while the picks tab's source is "local", else null
    function localState() {
        if (saved()?.source !== "local") return null;
        if (!local) return { state: "loading", local: true };
        const player = { id: null, username: t("profile.local.name"), avatarUrl: null };
        if (!local.skill?.ready) return { state: "none", local: true, player, skill: local.skill ?? null, message: t("profile.local.notEnough") };
        return { state: "ready", local: true, player, skill: local.skill };
    }

    function ensureLocal() {
        if (local) return Promise.resolve();
        if (localPending) return localPending;
        const danApi = api();
        if (typeof danApi?.localProfileStatus !== "function") {
            local = { skill: null };
            return Promise.resolve();
        }
        localPending = Promise.resolve()
            .then(() => danApi.localProfileStatus())
            .then((r) => { local = { skill: r?.ok ? r.skill : null }; }, () => { local = { skill: null }; })
            .finally(() => {
                localPending = null;
                notify();
            });
        return localPending;
    }

    const effective = () => manualState() ?? localState() ?? state;

    function notify() {
        const now = effective();
        for (const cb of [...subscribers]) {
            try {
                cb(now);
            } catch {
                // one tab's mistake must not stop the others
            }
        }
    }

    function set(next) {
        state = next;
        notify();
    }

    // main tells about any later load (the picks tab, another ensure)
    function listen() {
        if (listening) return;
        listening = true;
        try {
            api()?.onProfileChanged?.((p) => { if (p?.player) set({ state: "ready", player: p.player, skill: p.skill }); });
            // every play the local profile keeps, every import step
            api()?.onLocalProfileChanged?.((p) => {
                local = { skill: p?.skill ?? null };
                notify();
            });
        } catch {
            // no event: ensureProfile still works
        }
    }

    // the nick typed in the picks tab, unless it is in manual mode
    function hint() {
        const s = saved();
        const query = typeof s?.query === "string" ? s.query.trim().slice(0, 64) : "";
        return s?.source !== "manual" && query ? query : undefined;
    }

    function failed(message) {
        failedAt = now();
        set({ state: "failed", message: String(message ?? "") });
    }

    function ensureTrackerProfile() {
        listen();
        if (pending) return pending;
        if (state.state === "ready") return Promise.resolve(state);
        if (state.state === "failed" ? now() - failedAt < retryMs : asked) return Promise.resolve(state);
        asked = true;
        const danApi = api();
        if (typeof danApi?.profileEnsure !== "function") {
            set({ state: "none" });
            return Promise.resolve(state);
        }
        set({ state: "loading" });
        pending = Promise.resolve()
            .then(() => danApi.profileEnsure(hint()))
            .then((r) => {
                if (r?.ok) set({ state: "ready", player: r.player, skill: r.skill });
                else if (state.state === "ready") return; // profile-changed came first
                else if (r?.reason === "failed") failed(r.message);
                else set({ state: "none" });
            }, (error) => {
                if (state.state !== "ready") failed(error?.message ?? error);
            })
            .then(() => state)
            .finally(() => { pending = null; });
        return pending;
    }

    // the profile in use: a hand-set one needs nothing from main
    function ensureProfile() {
        const manual = manualState();
        if (manual) {
            listen();
            return Promise.resolve(manual);
        }
        if (saved()?.source === "local") {
            listen();
            return ensureLocal().then(() => effective());
        }
        return ensureTrackerProfile().then(() => effective());
    }

    return {
        getProfile() {
            listen();
            if (saved()?.source === "local" && !local) void ensureLocal();
            return effective();
        },
        getTrackerProfile() {
            listen();
            return state;
        },
        onProfile(cb) {
            listen();
            subscribers.add(cb);
            return () => { subscribers.delete(cb); };
        },
        ensureProfile,
        ensureTrackerProfile,
        // the picks tab saved another source or hand-set profile: every tab hears the profile now in use
        manualChanged: notify,
        // the local profile as main last told it (whatever the source), and a fresh read of it
        getLocalSkill: () => local?.skill ?? null,
        refreshLocal: () => {
            local = null;
            return ensureLocal();
        },
        // a mania-tracker player loaded elsewhere (the profile tab): the shared state takes it at once
        trackerLoaded: (player, skill) => set({ state: "ready", player, skill }),
    };
}

const client = createProfileClient();
export const getProfile = () => client.getProfile();
export const getTrackerProfile = () => client.getTrackerProfile();
export const onProfile = (cb) => client.onProfile(cb);
export const ensureProfile = () => client.ensureProfile();
export const ensureTrackerProfile = () => client.ensureTrackerProfile();
export const manualChanged = () => client.manualChanged();
export const getLocalSkill = () => client.getLocalSkill();
export const refreshLocal = () => client.refreshLocal();
export const trackerLoaded = (player, skill) => client.trackerLoaded(player, skill);
