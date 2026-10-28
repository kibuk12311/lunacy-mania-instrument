// Everything the page lane knows about osu-web (extension/DESIGN.md §2, §5.4): the beatmapset page's path, its JSON
// tags, the React mount's saved state, the difficulty picker and where our panel goes. When osu-web changes its markup,
// this is the only file to touch. Data comes from json-beatmapset, not from the markup.

export const SELECTORS = Object.freeze({
    beatmapsetJson: "#json-beatmapset",
    currentUserJson: "#json-current-user",
    mount: '[data-react="beatmapset-page"]',
    page: ".osu-page--generic-compact",
    header: ".beatmapset-header",
    info: ".beatmapset-info",
    picker: ".beatmapset-beatmap-picker",
    pickerAnchor: "a.beatmapset-beatmap-picker__beatmap",
    pickerActive: ".beatmapset-beatmap-picker__beatmap--active",
});
export const PICKER_ANCHOR_CLASS = "beatmapset-beatmap-picker__beatmap";
export const PICKER_ACTIVE_CLASS = "beatmapset-beatmap-picker__beatmap--active";

const SET_PATH = /^\/beatmapsets\/(\d+)\/?$/;
const HASH_ID = /^#([a-z]+)\/(\d+)/i;
const HREF_ID = /#([a-z]+)\/(\d+)/i;

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

// "/beatmapsets/2316993" → 2316993; any other path → null
export function setIdFromPath(pathname) {
    const m = SET_PATH.exec(String(pathname ?? ""));
    return m ? positiveInt(m[1]) : null;
}

// "#mania/4961226" → 4961226; "#osu/1" → 1 (the caller decides whether it is one of ours); else null
export function hashBeatmapId(hash) {
    const m = HASH_ID.exec(String(hash ?? ""));
    return m ? positiveInt(m[2]) : null;
}

// "https://osu.ppy.sh/beatmapsets/1#mania/2" → 2
export function hrefBeatmapId(href) {
    const m = HREF_ID.exec(String(href ?? ""));
    return m ? positiveInt(m[2]) : null;
}

function parseJsonText(text) {
    try {
        return JSON.parse(String(text ?? ""));
    } catch {
        return null;
    }
}

const isSet = (value) => !!value && typeof value === "object" && Array.isArray(value.beatmaps) && positiveInt(value.id) !== null;

// The set from the page itself: #json-beatmapset (osu-web reads it without removing it), else the React mount's state
// saved on turbo:before-cache ({ beatmapId, beatmapset, playmode }). null when neither holds one.
export function readBeatmapset(doc) {
    const tag = doc?.querySelector?.(SELECTORS.beatmapsetJson);
    const fromTag = tag ? parseJsonText(tag.textContent) : null;
    if (isSet(fromTag)) return fromTag;
    const mount = doc?.querySelector?.(SELECTORS.mount);
    const state = mount?.dataset?.state ? parseJsonText(mount.dataset.state) : null;
    if (isSet(state?.beatmapset)) return state.beatmapset;
    return null;
}

const decodeEntities = (s) => s.replace(/&(quot|amp|lt|gt|#39|#x27);/g, (_, e) => ({ quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'", "#x27": "'" })[e]);

// The set from a page's HTML text (the last resort: a same-origin re-read of the page): the json-beatmapset tag, else
// null. Only <script> tags with that id are looked at.
export function beatmapsetFromHtml(html) {
    const text = String(html ?? "");
    const tag = /<script\b[^>]*\bid\s*=\s*["']?json-beatmapset["']?[^>]*>([\s\S]*?)<\/script>/i.exec(text);
    if (tag) {
        const value = parseJsonText(tag[1]);
        if (isSet(value)) return value;
    }
    // a saved React state in the mount (data-state="{&quot;beatmapset&quot;:…}")
    const mount = /data-react\s*=\s*["']beatmapset-page["'][^>]*\bdata-state\s*=\s*"([^"]*)"/i.exec(text);
    if (mount) {
        const state = parseJsonText(decodeEntities(mount[1]));
        if (isSet(state?.beatmapset)) return state.beatmapset;
    }
    return null;
}

// The set for this page: from the page, else one same-origin fetch of the page's HTML (only when `fetch` is given).
// A set whose id is not the path's is refused. → set or null; never throws.
export async function loadBeatmapset(doc, { setId, pathname, fetch = null } = {}) {
    const fromPage = readBeatmapset(doc);
    if (fromPage && (!setId || positiveInt(fromPage.id) === setId)) return fromPage;
    if (typeof fetch !== "function" || !pathname) return null;
    try {
        const response = await fetch(pathname, { credentials: "same-origin", headers: { Accept: "text/html" } });
        if (!response?.ok) return null;
        const fetched = beatmapsetFromHtml(await response.text());
        return fetched && (!setId || positiveInt(fetched.id) === setId) ? fetched : null;
    } catch {
        return null;
    }
}

// The set's osu!mania 4K difficulties (no converts, no other key counts or modes), in the picker's order:
// difficulty_rating ascending, then id. → [{ id, setId, version, checksum, od, stars, length }]
export function fourKDiffs(beatmapset) {
    const list = Array.isArray(beatmapset?.beatmaps) ? beatmapset.beatmaps : [];
    return list
        .filter((b) => b && b.mode === "mania" && !b.convert && Math.round(Number(b.cs)) === 4 && positiveInt(b.id) !== null)
        .map((b) => ({
            id: positiveInt(b.id),
            setId: positiveInt(b.beatmapset_id) ?? positiveInt(beatmapset.id),
            version: String(b.version ?? ""),
            checksum: typeof b.checksum === "string" && /^[0-9a-f]{32}$/i.test(b.checksum) ? b.checksum.toLowerCase() : null,
            od: Number.isFinite(Number(b.accuracy)) ? Number(b.accuracy) : null,
            stars: Number.isFinite(Number(b.difficulty_rating)) ? Number(b.difficulty_rating) : 0,
            length: Number.isFinite(Number(b.total_length)) ? Number(b.total_length) : null,
        }))
        .sort((a, b) => a.stars - b.stars || a.id - b.id);
}

// Whether osu! lets this set be downloaded ({ disabled, info }); info is osu!'s own link or note, if any.
export function downloadAvailability(beatmapset) {
    const a = beatmapset?.availability ?? {};
    return { disabled: !!a.download_disabled, info: typeof a.more_information === "string" ? a.more_information : null };
}

export const pickerAnchors = (doc) => [...(doc?.querySelectorAll?.(SELECTORS.pickerAnchor) ?? [])];

// The id of the picker's active difficulty, or null.
export function activePickerId(doc) {
    const active = doc?.querySelector?.(SELECTORS.pickerActive);
    return active ? hrefBeatmapId(active.getAttribute("href")) : null;
}

// osu-web's picker anchor for a difficulty, or null.
export function pickerAnchorFor(doc, beatmapId) {
    return pickerAnchors(doc).find((a) => hrefBeatmapId(a.getAttribute("href")) === beatmapId) ?? null;
}

// The selected 4K difficulty: the hash's (#mania/<id>), else the picker's active one, else the first 4K diff. An id
// that is not one of `diffs` is passed over. null when there are no diffs.
export function selectedBeatmapId(doc, hash, diffs) {
    const ids = new Set((diffs ?? []).map((d) => d.id));
    const fromHash = hashBeatmapId(hash);
    if (ids.has(fromHash)) return fromHash;
    const active = activePickerId(doc);
    if (ids.has(active)) return active;
    return diffs?.[0]?.id ?? null;
}

// Is someone logged in on osu!? #json-current-user: an object with an id → true, {} → false, no tag / unreadable → null.
export function loginHint(doc) {
    const tag = doc?.querySelector?.(SELECTORS.currentUserJson);
    if (!tag) return null;
    const user = parseJsonText(tag.textContent);
    if (!user || typeof user !== "object") return null;
    return positiveInt(user.id) !== null;
}

// Where the panel goes, best first: after .beatmapset-header, before .beatmapset-info, first in the compact page, else
// floating (fixed, bottom right). → { where, anchor, position } (anchor null for floating)
export function hostPlacement(doc) {
    const header = doc?.querySelector?.(SELECTORS.header);
    if (header?.parentNode) return { where: "header", anchor: header, position: "afterend" };
    const info = doc?.querySelector?.(SELECTORS.info);
    if (info?.parentNode) return { where: "info", anchor: info, position: "beforebegin" };
    const page = doc?.querySelector?.(SELECTORS.page);
    if (page) return { where: "page", anchor: page, position: "afterbegin" };
    return { where: "floating", anchor: null, position: null };
}

function isPlaced(host, { anchor, position }, doc) {
    if (!host.isConnected) return false;
    if (position === "afterend") return anchor.nextElementSibling === host;
    if (position === "beforebegin") return anchor.previousElementSibling === host;
    if (position === "afterbegin") return anchor.firstElementChild === host;
    return host.parentNode === (doc.body ?? doc.documentElement);
}

// Puts (or moves) our host at the best place there is now; nothing moves when it is already there. Never writes into
// osu-web's own nodes: the host only becomes their sibling (or the compact page's first child). → where it is
export function placeHost(doc, host) {
    const placement = hostPlacement(doc);
    const floating = placement.where === "floating";
    if (floating) host.setAttribute("data-lm-floating", "");
    else host.removeAttribute("data-lm-floating");
    if (isPlaced(host, placement, doc)) return placement.where;
    if (floating) (doc.body ?? doc.documentElement).append(host);
    else placement.anchor.insertAdjacentElement(placement.position, host);
    return placement.where;
}
