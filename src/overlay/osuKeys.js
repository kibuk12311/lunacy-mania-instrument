// osu! stable's mania key layouts → Windows virtual-key codes, for the keyboard reader (native/key-reader).
// osu!.<user>.cfg keeps a layout per key count, the key names in column order:
//   ManiaLayouts4K = A S OemSemicolon OemQuotes
//   ManiaLayoutSelected4K = 0
// The names are .NET key enum names (osu! writes XNA's: LeftControl, LeftWindows, OemComma; WinForms' spellings such
// as LControlKey, LWin, Oemcomma are read too). In both enums a key's value is its Windows virtual-key code, so the
// table below is name → VK. Also here: a short label per key for the settings window, the key a press in the settings
// window stands for (KeyboardEvent.keyCode is the VK on Windows; event.code tells left from right), and osu!'s own
// default layouts for a key count the cfg doesn't name.

const KEYS = new Map(); // lower-case name → VK
const NAME = new Map(); // VK → the name written back (osu!'s spelling)
function add(vk, ...names) {
    for (const n of names) KEYS.set(n.toLowerCase(), vk);
    if (!NAME.has(vk)) NAME.set(vk, names[0]);
}

for (let i = 0; i < 26; i += 1) add(65 + i, String.fromCharCode(65 + i));
for (let i = 0; i <= 9; i += 1) add(48 + i, `D${i}`);
for (let i = 0; i <= 9; i += 1) add(96 + i, `NumPad${i}`);
for (let i = 1; i <= 24; i += 1) add(111 + i, `F${i}`);
add(8, "Back");
add(9, "Tab");
add(12, "Clear");
add(13, "Enter", "Return");
add(16, "ShiftKey");
add(17, "ControlKey");
add(18, "Menu");
add(19, "Pause");
add(20, "CapsLock", "Capital");
add(21, "Kana", "HangulMode", "HanguelMode");
add(23, "JunjaMode");
add(24, "FinalMode");
add(25, "Kanji", "HanjaMode");
add(27, "Escape");
add(28, "ImeConvert", "IMEConvert");
add(29, "ImeNoConvert", "IMENonconvert");
add(30, "IMEAccept", "IMEAceept");
add(31, "IMEModeChange");
add(32, "Space");
add(33, "PageUp", "Prior");
add(34, "PageDown", "Next");
add(35, "End");
add(36, "Home");
add(37, "Left");
add(38, "Up");
add(39, "Right");
add(40, "Down");
add(41, "Select");
add(42, "Print");
add(43, "Execute");
add(44, "PrintScreen", "Snapshot");
add(45, "Insert");
add(46, "Delete");
add(47, "Help");
add(91, "LeftWindows", "LWin");
add(92, "RightWindows", "RWin");
add(93, "Apps");
add(95, "Sleep");
add(106, "Multiply");
add(107, "Add");
add(108, "Separator");
add(109, "Subtract");
add(110, "Decimal");
add(111, "Divide");
add(144, "NumLock");
add(145, "Scroll");
add(160, "LeftShift", "LShiftKey");
add(161, "RightShift", "RShiftKey");
add(162, "LeftControl", "LControlKey");
add(163, "RightControl", "RControlKey");
add(164, "LeftAlt", "LMenu");
add(165, "RightAlt", "RMenu");
add(166, "BrowserBack");
add(167, "BrowserForward");
add(168, "BrowserRefresh");
add(169, "BrowserStop");
add(170, "BrowserSearch");
add(171, "BrowserFavorites");
add(172, "BrowserHome");
add(173, "VolumeMute");
add(174, "VolumeDown");
add(175, "VolumeUp");
add(176, "MediaNextTrack");
add(177, "MediaPreviousTrack");
add(178, "MediaStop");
add(179, "MediaPlayPause");
add(180, "LaunchMail");
add(181, "SelectMedia", "LaunchMediaSelect");
add(182, "LaunchApplication1");
add(183, "LaunchApplication2");
add(186, "OemSemicolon", "Oem1");
add(187, "OemPlus", "Oemplus");
add(188, "OemComma", "Oemcomma");
add(189, "OemMinus");
add(190, "OemPeriod");
add(191, "OemQuestion", "Oem2");
add(192, "OemTilde", "Oemtilde", "Oem3");
add(219, "OemOpenBrackets", "Oem4");
add(220, "OemPipe", "Oem5");
add(221, "OemCloseBrackets", "Oem6");
add(222, "OemQuotes", "Oem7");
add(223, "Oem8");
add(226, "OemBackslash", "Oem102");
add(229, "ProcessKey");
add(231, "Packet");
add(242, "OemCopy");
add(243, "OemAuto");
add(244, "OemEnlW");
add(246, "Attn");
add(247, "Crsel");
add(248, "Exsel");
add(249, "EraseEof");
add(250, "Play");
add(251, "Zoom");
add(252, "NoName");
add(253, "Pa1");
add(254, "OemClear");

// every name the table reads, as written (for the tests)
export const KEY_NAMES = Object.freeze([...KEYS.keys()]);

// a key name (any case, either spelling) → its virtual-key code, or null ("None", a mouse button, garbage)
export function vkOf(name) {
    const vk = KEYS.get(String(name ?? "").trim().toLowerCase());
    return vk ?? null;
}

// a virtual-key code → the name kept in the settings (osu!'s spelling), or null
export const nameOfVk = (vk) => NAME.get(vk) ?? null;

// the name in osu!'s spelling, or null when it is no key we know
export const canonicalName = (name) => nameOfVk(vkOf(name));

const LABELS = {
    186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\", 221: "]", 222: "'", 226: "\\",
    32: "Space", 13: "Enter", 8: "Bksp", 9: "Tab", 20: "Caps", 27: "Esc", 12: "Clear",
    33: "PgUp", 34: "PgDn", 35: "End", 36: "Home", 45: "Ins", 46: "Del", 37: "←", 38: "↑", 39: "→", 40: "↓",
    16: "Shift", 17: "Ctrl", 18: "Alt", 160: "LShift", 161: "RShift", 162: "LCtrl", 163: "RCtrl", 164: "LAlt", 165: "RAlt",
    91: "LWin", 92: "RWin", 93: "Menu", 106: "Num*", 107: "Num+", 109: "Num-", 110: "Num.", 111: "Num/",
    144: "NumLock", 145: "ScrLk", 19: "Pause", 44: "PrtSc",
};

// a key name → what the settings window shows: "A", ";", "'", "Space", "LCtrl", "Num7", "5"; unknown → "?"
export function keyLabel(name) {
    const vk = vkOf(name);
    if (vk === null) return "?";
    if (LABELS[vk]) return LABELS[vk];
    if (vk >= 48 && vk <= 57) return String(vk - 48);
    if (vk >= 96 && vk <= 105) return `Num${vk - 96}`;
    return nameOfVk(vk);
}

// osu! stable's own layouts for a key count its cfg doesn't name (only those known for sure)
export const OSU_DEFAULT_LAYOUTS = Object.freeze({
    1: ["Space"],
    2: ["F", "J"],
    3: ["F", "Space", "J"],
    4: ["D", "F", "J", "K"],
    5: ["D", "F", "Space", "J", "K"],
    6: ["S", "D", "F", "J", "K", "L"],
    7: ["S", "D", "F", "Space", "J", "K", "L"],
    9: ["A", "S", "D", "F", "Space", "J", "K", "L", "OemSemicolon"],
});
export const MAX_KEYS = 18;

// osu!.<user>.cfg text → { [keyCount]: { layouts: [[name…]…], selected } } for every ManiaLayouts<N>K line.
// The value is the layout's key names separated by spaces; should osu! keep several layouts for one key count, they
// are told apart by "|", or by a value N, 2N, … names long.
export function parseManiaLayouts(text) {
    const out = {};
    const selected = {};
    for (const raw of String(text ?? "").replace(/^﻿/, "").split(/\r?\n/)) {
        const m = raw.match(/^\s*ManiaLayout(s|Selected)(\d{1,2})K\s*=\s*(.*?)\s*$/i);
        if (!m) continue;
        const keys = Number(m[2]);
        if (keys < 1 || keys > MAX_KEYS) continue;
        if (m[1].toLowerCase() === "selected") {
            const n = Number.parseInt(m[3], 10);
            selected[keys] = Number.isInteger(n) && n >= 0 ? n : 0;
            continue;
        }
        const layouts = [];
        for (const part of m[3].split("|")) {
            const names = part.trim().split(/\s+/).filter(Boolean);
            if (!names.length || names.length % keys !== 0) continue;
            for (let i = 0; i < names.length; i += keys) layouts.push(names.slice(i, i + keys));
        }
        if (layouts.length) out[keys] = { layouts, selected: 0 };
    }
    for (const [k, n] of Object.entries(selected)) if (out[k]) out[k].selected = n;
    return out;
}

// the layout in use for a key count: the selected one (the first if that index is gone), a lane whose name is no key
// we can hear (osu!'s "None" for an unbound lane) null: osu! plays the other lanes with their keys all the same, so
// those are listened to. null when the cfg has no layout for it or none of its keys is one we can hear
export function selectedLayout(parsed, keys) {
    const entry = parsed?.[keys];
    if (!entry) return null;
    const layout = entry.layouts[entry.selected] ?? entry.layouts[0];
    if (!layout || layout.length !== keys) return null;
    const names = layout.map(canonicalName);
    return names.some(Boolean) ? names : null;
}

// a lane per name → its VK, null for a lane with no key (or no key we can hear); null if no lane has one
export function laneVks(names) {
    const vks = (names ?? []).map((n) => (n ? vkOf(n) : null));
    return vks.some((v) => v !== null) ? vks : null;
}

// a press in the settings window (a KeyboardEvent's keyCode and code) → the key name kept, or null (Escape cancels,
// a key we can't hear). keyCode is the Windows VK of the key as the layout has it, as osu! sees it.
export function nameOfKeyEvent({ keyCode, code } = {}) {
    let vk = Number(keyCode);
    const side = String(code ?? "");
    if (vk === 16) vk = side === "ShiftRight" ? 161 : 160;
    else if (vk === 17) vk = side === "ControlRight" ? 163 : 162;
    else if (vk === 18) vk = side === "AltRight" ? 165 : 164;
    else if (vk === 91 || vk === 92) vk = side === "MetaRight" ? 92 : 91;
    if (!Number.isInteger(vk) || vk === 27 || vk <= 7) return null;
    return nameOfVk(vk);
}

// names → their VKs; null if any is not a key
export function vksOf(names) {
    const vks = (names ?? []).map(vkOf);
    return vks.length && vks.every((v) => v !== null) ? vks : null;
}
