// Interface language: Russian or English. Texts live in ./messages, one file per area, each key with both languages.
// The language is module state: main sets it from the saved setting, the worker per request, the renderer at start.
import { AREAS } from "./messages/index.js";

export const LANGS = ["ru", "en"];
export const LANG_NAMES = { ru: "Русский", en: "English" };

const dict = Object.assign({}, ...Object.values(AREAS));
let lang = "ru";

export function setLang(value) {
    lang = LANGS.includes(value) ? value : "ru";
    return lang;
}

export const getLang = () => lang;

// Windows/Chromium locale ("ru", "ru-RU", "en-US", …) → the language a new install starts in.
export const langForLocale = (locale) => (/^(ru|uk|be|kk)\b/i.test(String(locale ?? "")) ? "ru" : "en");

// t("rec.found", { n: 3 }) → the text in the current language; an unknown key shows itself instead of nothing.
export function t(key, params = {}) {
    const entry = dict[key];
    if (!entry) return key;
    const value = entry[lang] ?? entry.ru;
    const text = typeof value === "function" ? value(params) : String(value);
    return text.replace(/\{(\w+)\}/g, (slot, name) => (name in params ? String(params[name]) : slot));
}

// Plural word for n: ru takes [one, few, many] (1 карта, 2 карты, 5 карт), en takes [one, other].
export function plural(n, { ru, en }) {
    const count = Math.abs(Math.trunc(Number(n) || 0));
    if (lang === "en") return count === 1 ? en[0] : en[1];
    const mod100 = count % 100;
    const mod10 = count % 10;
    if (mod100 >= 11 && mod100 <= 14) return ru[2];
    if (mod10 === 1) return ru[0];
    if (mod10 >= 2 && mod10 <= 4) return ru[1];
    return ru[2];
}

// Static markup: data-i18n → text, data-i18n-title → tooltip, data-i18n-placeholder → placeholder.
export function applyI18n(root) {
    for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const node of root.querySelectorAll("[data-i18n-title]")) node.title = t(node.dataset.i18nTitle);
    for (const node of root.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = t(node.dataset.i18nPlaceholder);
}

export const allKeys = () => Object.keys(dict);
