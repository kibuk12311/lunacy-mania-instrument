// The mapper styles of a model as the create tab shows them (0.9.5). A model's `styles` is [{ key, name, maps }] with
// keys "n:<name in lower case>" or "u:<osu! user id>"; the nn-v2 models carry the same keys as XGBoost v3 but their
// `name` is the raw key. A name is real when it is there and is not the key itself.
// - namesFrom(lists): key → real name, from every list given (the XGBoost v3 list names the nn-v2 ones).
// - displayStyles(list, names): [{ key, name, user, maps }], most maps first: the style's own real name, else the one
//   from `names`, else the key without its "n:"; a "u:<id>" without a name is { name: null, user: "<id>" } (the window
//   shows «маппер #<id>»). Entries without a key are dropped, a key given twice is kept once.
const realName = (s) => (typeof s?.name === "string" && s.name.trim() && s.name !== s.key ? s.name.trim() : null);
const userOf = (key) => /^u:(.+)$/.exec(key)?.[1] ?? null;

export function namesFrom(lists = []) {
    const names = new Map();
    for (const list of lists) {
        for (const s of Array.isArray(list) ? list : []) {
            const name = realName(s);
            if (typeof s?.key === "string" && name && !names.has(s.key)) names.set(s.key, name);
        }
    }
    return names;
}

export function displayStyles(list, names = new Map()) {
    const seen = new Set();
    const out = [];
    for (const s of Array.isArray(list) ? list : []) {
        const key = s?.key;
        if (typeof key !== "string" || !key || seen.has(key)) continue;
        seen.add(key);
        const user = userOf(key);
        const name = realName(s) ?? names.get(key) ?? (key.startsWith("n:") && key.length > 2 ? key.slice(2) : user === null ? key : null);
        out.push({ key, name, user: name === null ? user : null, maps: Math.max(0, Math.round(Number(s.maps) || 0)) });
    }
    return out.sort((a, b) => b.maps - a.maps || String(a.name ?? a.user).localeCompare(String(b.name ?? b.user)));
}
