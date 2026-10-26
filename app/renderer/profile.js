// The shared player profile in the window, for every tab: what main's profile service holds, or the profile set by
// hand in the picks tab while its source is "manual" (no mania-tracker needed).
// getProfile() → { state: "idle"|"loading"|"ready"|"none"|"failed", player?, skill?, message?, manual? };
// a hand-set one is { state: "ready", manual: true, player: { id: null, username }, skill (manualSkill), profile }.
// onProfile(cb) → unsubscribe, cb on every change (also on "profile-changed" from main and on manualChanged());
// ensureProfile() asks main at most once a session (after "failed", again no sooner than 60 s later), and not at
// all while the hand-set profile is the one in use; getTrackerProfile() / ensureTrackerProfile() are mania-tracker's
// alone (plays and progress exist only there).
import { manualProfileOf, manualSkill } from "../../src/recommend/manualProfile.js";
import { t } from "../../src/i18n/i18n.js";

const RETRY_MS = 60_000;
// the picks tab's settings: { source: "tracker"|"manual", query, manualProfile: { name, speed, jack, stamina, tech } }
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

    const effective = () => manualState() ?? state;

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
        return ensureTrackerProfile().then(() => effective());
    }

    return {
        getProfile() {
            listen();
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
    };
}

const client = createProfileClient();
export const getProfile = () => client.getProfile();
export const getTrackerProfile = () => client.getTrackerProfile();
export const onProfile = (cb) => client.onProfile(cb);
export const ensureProfile = () => client.ensureProfile();
export const ensureTrackerProfile = () => client.ensureTrackerProfile();
export const manualChanged = () => client.manualChanged();
