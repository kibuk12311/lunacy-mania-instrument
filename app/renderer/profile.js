// The shared player profile in the window, for every tab: what main's profile service holds.
// getProfile() → { state: "idle"|"loading"|"ready"|"none"|"failed", player?, skill?, message? };
// onProfile(cb) → unsubscribe, cb on every change (also on "profile-changed" from main);
// ensureProfile() asks main at most once a session (after "failed", again no sooner than 60 s later).
const RETRY_MS = 60_000;
const SETTINGS_KEY = "rec-settings"; // the picks tab's settings: { source: "tracker"|"manual", query }

export function createProfileClient({
    api = () => globalThis.window?.danApi, storage = () => globalThis.localStorage, now = Date.now, retryMs = RETRY_MS,
} = {}) {
    let state = { state: "idle" };
    const subscribers = new Set();
    let listening = false;
    let asked = false;
    let failedAt = null;
    let pending = null;

    function set(next) {
        state = next;
        for (const cb of [...subscribers]) {
            try {
                cb(state);
            } catch {
                // one tab's mistake must not stop the others
            }
        }
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
        try {
            const saved = JSON.parse(storage()?.getItem(SETTINGS_KEY) ?? "null");
            const query = typeof saved?.query === "string" ? saved.query.trim().slice(0, 64) : "";
            return saved?.source !== "manual" && query ? query : undefined;
        } catch {
            return undefined;
        }
    }

    function failed(message) {
        failedAt = now();
        set({ state: "failed", message: String(message ?? "") });
    }

    function ensureProfile() {
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

    return {
        getProfile() {
            listen();
            return state;
        },
        onProfile(cb) {
            listen();
            subscribers.add(cb);
            return () => { subscribers.delete(cb); };
        },
        ensureProfile,
    };
}

const client = createProfileClient();
export const getProfile = () => client.getProfile();
export const onProfile = (cb) => client.onProfile(cb);
export const ensureProfile = () => client.ensureProfile();
