// .osz of a beatmap set from public osu! mirrors, saved where the app can hand it to osu! for import.
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { t } from "../i18n/i18n.js";

// Checked live: these send the .osz itself (a zip). catboy.best and nerinyan answered 403/404 at the time.
export const MIRRORS = [
    { host: "osu.direct", url: (id) => `https://osu.direct/api/d/${id}` },
    { host: "beatconnect.io", url: (id) => `https://beatconnect.io/b/${id}/` },
    { host: "dl.sayobot.cn", url: (id) => `https://dl.sayobot.cn/beatmaps/download/novideo/${id}` },
];
const USER_AGENT = "lunacy-mania (osu!mania map recommendations)";
const MAX_BYTES = 200 * 1024 * 1024;
const IDLE_MS = 30_000; // a mirror that sends nothing for this long is given up on
const PROGRESS_STEP = 256 * 1024;

const exists = (p) => access(p).then(() => true, () => false);
const safe = (s) => String(s ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();

export function oszName(beatmapsetId, artist, title) {
    const name = [safe(artist), safe(title)].filter(Boolean).join(" - ").slice(0, 120).replace(/[. ]+$/, "");
    return `${beatmapsetId}${name ? ` ${name}` : ""}.osz`;
}

export function createDownloader({ dir, fetchImpl = globalThis.fetch, mirrors = MIRRORS, maxBytes = MAX_BYTES, idleMs = IDLE_MS }) {
    const inflight = new Map(); // set id → Promise of the result, while it downloads

    async function fromMirror(mirror, id, part, onProgress) {
        const { host } = mirror;
        const controller = new AbortController();
        let idle = setTimeout(() => controller.abort(), idleMs);
        const alive = () => {
            clearTimeout(idle);
            idle = setTimeout(() => controller.abort(), idleMs);
        };
        const file = await open(part, "w");
        try {
            const res = await fetchImpl(mirror.url(id), { headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: controller.signal });
            if (!res.ok) throw new Error(t("core.download.status", { host, status: res.status }));
            const total = Number(res.headers.get("content-length")) || null;
            if (total && total > maxBytes) throw new Error(t("core.download.tooBig", { host }));
            const reader = res.body.getReader();
            let received = 0;
            let reported = 0;
            let head = Buffer.alloc(0);
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                alive();
                const chunk = Buffer.from(value);
                if (head.length < 2) {
                    head = Buffer.concat([head, chunk]).subarray(0, 2);
                    // an .osz is a zip; an HTML error page or JSON is not
                    if (head.length === 2 && head.toString("latin1") !== "PK") throw new Error(t("core.download.notOsz", { host }));
                }
                received += chunk.length;
                if (received > maxBytes) throw new Error(t("core.download.tooBig", { host }));
                await file.write(chunk);
                if (received - reported >= PROGRESS_STEP) {
                    reported = received;
                    onProgress?.({ received, total, mirror: mirror.host });
                }
            }
            if (received < 22 || head.toString("latin1") !== "PK") throw new Error(t("core.download.notOsz", { host }));
            onProgress?.({ received, total: total ?? received, mirror: mirror.host });
            return received;
        } finally {
            clearTimeout(idle);
            controller.abort(); // stops the body if we bailed out early
            await file.close();
        }
    }

    async function run({ beatmapsetId: id, artist, title, onProgress }) {
        const target = path.join(dir, oszName(id, artist, title));
        if (await exists(target)) return { file: target, mirror: null, bytes: null, reused: true };
        await mkdir(dir, { recursive: true });
        const part = `${target}.part`;
        const errors = [];
        for (const mirror of mirrors) {
            try {
                const bytes = await fromMirror(mirror, id, part, onProgress);
                await rename(part, target);
                return { file: target, mirror: mirror.host, bytes, reused: false };
            } catch (error) {
                errors.push(error?.name === "AbortError" ? t("core.download.noAnswer", { host: mirror.host }) : String(error?.message ?? error));
                await rm(part, { force: true });
            }
        }
        const error = new Error(t("core.download.allFailed"));
        error.details = errors;
        throw error;
    }

    // The same set asked for again while it downloads (two tabs at once) gets the same Promise: one download.
    // Only the first caller's onProgress hears progress; a later caller's stays silent.
    function download(request) {
        const id = request?.beatmapsetId;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return Promise.reject(new Error(t("core.download.badId")));
        if (!inflight.has(id)) {
            const job = run({ ...request, beatmapsetId: id }).finally(() => inflight.delete(id));
            inflight.set(id, job);
        }
        return inflight.get(id);
    }

    return { download };
}
