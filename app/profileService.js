// The player profile every tab shares: the mania-tracker player the recommender has loaded, remembered in
// userData/profile.json so the next start can load the same account by its exact id without a name search.
import { positiveId } from "./validate.js";

const RETRY_MS = 60_000;
const text64 = (v) => (typeof v === "string" ? v.trim().slice(0, 64) : "");

// What profile.json holds: { query, id, username }, or null without a real id.
export function normalizeProfileRecord(x) {
    const id = typeof x?.id === "number" ? positiveId(x.id) : null;
    if (!id) return null;
    return { query: text64(x.query), id, username: text64(x.username) || String(id) };
}

const answer = (p) => ({ ok: true, player: { id: p.id, username: p.username, avatarUrl: p.avatarUrl ?? null }, skill: p.skill });

export function createProfileService({ recommender, store, send = () => {}, log = () => {}, now = Date.now, retryMs = RETRY_MS }) {
    let loading = null; // Promise of the ensure answer while a load runs
    let failure = null; // { at, answer } of the last failed load

    function current() {
        const p = recommender.currentPlayer();
        return p ? answer(p) : { ok: false };
    }

    // After any successful load (here or in the picks tab): saved for the next start, and the window is told.
    async function remember(query, loaded) {
        failure = null;
        try {
            send("profile-changed", { player: answer(loaded).player, skill: loaded.skill });
            await store.set({ query: text64(query), id: loaded.id, username: loaded.username });
        } catch (error) {
            log(`profile save failed: ${error?.message}`);
        }
    }

    async function load(hint) {
        let saved = null;
        try {
            saved = normalizeProfileRecord(await store.get());
        } catch {
            saved = null; // an unreadable file is the same as none
        }
        const query = saved ? saved.query || saved.username : hint;
        if (!query) return { ok: false, reason: "none" };
        try {
            const loaded = saved
                ? await recommender.loadPlayer(saved.username, { id: saved.id, name: saved.username })
                : await recommender.loadPlayer(hint);
            log(`profile ${loaded.username} (${loaded.id}) ${saved ? "saved" : "hint"}`);
            await remember(query, loaded);
            return answer(loaded);
        } catch (error) {
            const out = { ok: false, reason: "failed", message: String(error?.message ?? error) };
            failure = { at: now(), answer: out };
            log(`profile ${saved ? `${saved.username} (${saved.id})` : `"${hint}"`} failed: ${out.message}`);
            return out;
        }
    }

    // The loaded player, else the saved one, else the hint; one load at a time, a failure is kept for retryMs.
    function ensure({ query } = {}) {
        const loaded = current();
        if (loaded.ok) return Promise.resolve(loaded);
        if (loading) return loading;
        if (failure && now() - failure.at < retryMs) return Promise.resolve(failure.answer);
        loading = load(text64(query)).finally(() => { loading = null; });
        return loading;
    }

    return { current, ensure, remember };
}

export function registerProfileIpc({ ipcMain, profile, log = () => {} }) {
    ipcMain.handle("profile-get", () => {
        try {
            return profile.current();
        } catch (error) {
            log(`profile-get failed: ${error?.message}`);
            return { ok: false };
        }
    });
    ipcMain.handle("profile-ensure", async (_e, req) => {
        try {
            return await profile.ensure({ query: req?.query });
        } catch (error) {
            return { ok: false, reason: "failed", message: String(error?.message ?? error) };
        }
    });
}
