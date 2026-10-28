// Interface language of the extension: the osu! site's language (<html lang>), else the browser's; ru or en.
export const LANGS = Object.freeze(["ru", "en"]);
export const langForLocale = (locale) => (/^(ru|uk|be|kk)\b/i.test(String(locale ?? "")) ? "ru" : "en");
export function siteLang(doc = globalThis.document, nav = globalThis.navigator) {
    const marked = doc?.documentElement?.getAttribute?.("lang");
    return langForLocale(marked || nav?.language || "en");
}
// dict: { key: { ru, en } } (a value may be a function of params); t("k", { n: 3 }) fills {n}; unknown keys show themselves
export function makeT(dict, lang) {
    return (key, params = {}) => {
        const entry = dict[key];
        if (!entry) return key;
        const value = entry[lang] ?? entry.en;
        const text = typeof value === "function" ? value(params) : String(value);
        return text.replace(/\{(\w+)\}/g, (slot, name) => (name in params ? String(params[name]) : slot));
    };
}
// ru takes [one, few, many], en [one, other]
export function plural(n, { ru, en }, lang) {
    const c = Math.abs(Math.trunc(Number(n) || 0));
    if (lang === "en") return c === 1 ? en[0] : en[1];
    const m100 = c % 100, m10 = c % 10;
    if (m100 >= 11 && m100 <= 14) return ru[2];
    if (m10 === 1) return ru[0];
    return m10 >= 2 && m10 <= 4 ? ru[1] : ru[2];
}
