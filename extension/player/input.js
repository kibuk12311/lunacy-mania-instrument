// Keyboard for the demo player: lanes by event.code (layout-independent), rebinding, offset nudge, pause on blur.

export const DEFAULT_KEYS = Object.freeze(["KeyD", "KeyF", "KeyJ", "KeyK"]);
export const REFUSED_KEYS = Object.freeze(["Escape", "Tab", "Enter", "NumpadEnter", "Space"]);
const MINUS = new Set(["Minus", "NumpadSubtract"]);
const PLUS = new Set(["Equal", "NumpadAdd"]);

// Refused too: keys the browser cannot name (event.code "" or "Unidentified"), since they could not be saved.
export const isRefused = (code) => typeof code !== "string" || code === "" || code === "Unidentified" || REFUSED_KEYS.includes(code);

// A valid set of lane keys: 4 distinct event.code strings, none of them refused.
export function validKeys(keys, count = 4) {
    if (!Array.isArray(keys) || keys.length !== count) return false;
    if (!keys.every((k) => typeof k === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k) && !isRefused(k))) return false;
    return new Set(keys).size === keys.length;
}

// "KeyD" → "D", "Digit1" → "1", "Semicolon" → ";" — what the settings show.
export function keyLabel(code) {
    const c = String(code ?? "");
    if (/^Key[A-Z]$/.test(c)) return c.slice(3);
    if (/^Digit\d$/.test(c)) return c.slice(5);
    if (/^Numpad\d$/.test(c)) return `Num ${c.slice(6)}`;
    const named = {
        Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", BracketLeft: "[",
        BracketRight: "]", Backquote: "`", Minus: "-", Equal: "=", ShiftLeft: "LShift", ShiftRight: "RShift",
        ControlLeft: "LCtrl", ControlRight: "RCtrl", AltLeft: "LAlt", AltRight: "RAlt", ArrowLeft: "←", ArrowRight: "→",
        ArrowUp: "↑", ArrowDown: "↓", CapsLock: "Caps",
    };
    return named[c] ?? c;
}

// '-' / '=' during play: −5 / +5 ms, with Shift −1 / +1. 0 for any other key.
export function offsetNudge(event) {
    const step = event?.shiftKey ? 1 : 5;
    if (MINUS.has(event?.code)) return -step;
    if (PLUS.has(event?.code)) return step;
    return 0;
}

// Rebinding: press the four lanes left to right. feed(code) → { status: "next"|"done"|"refused"|"duplicate", keys }.
export function createRebinder(count = 4) {
    const keys = [];
    return {
        get keys() { return keys.slice(); },
        get index() { return keys.length; },
        feed(code) {
            if (isRefused(code)) return { status: "refused", keys: keys.slice() };
            if (keys.includes(code)) return { status: "duplicate", keys: keys.slice() };
            keys.push(code);
            return { status: keys.length >= count ? "done" : "next", keys: keys.slice() };
        },
    };
}

// Listens on `target` (window) and `doc` (visibility). Lane keys go to onLaneDown/onLaneUp(col, event), each once per
// physical press (repeats ignored); other keydowns go to onKey(event). Blur or a hidden page → onLeave(); held lanes
// are released first so nothing stays stuck. setKeys() swaps the bindings; setCapture(fn) routes every keydown to fn
// (rebinding) until cleared.
export function createInput({ target, doc = target?.document, keys = DEFAULT_KEYS, onLaneDown, onLaneUp, onKey, onLeave }) {
    let bindings = new Map(keys.map((code, col) => [code, col]));
    const held = new Map(); // code → { col, event }
    let capture = null;

    function keydown(event) {
        if (capture) {
            event.preventDefault?.();
            if (!event.repeat) capture(event);
            return;
        }
        const col = bindings.get(event.code);
        if (col !== undefined) {
            event.preventDefault?.();
            if (event.repeat || held.has(event.code)) return;
            held.set(event.code, { col });
            onLaneDown?.(col, event);
            return;
        }
        onKey?.(event);
    }

    function keyup(event) {
        const entry = held.get(event.code);
        if (!entry) return;
        event.preventDefault?.();
        held.delete(event.code);
        onLaneUp?.(entry.col, event);
    }

    function releaseAll(event = null) {
        for (const [code, { col }] of [...held]) {
            held.delete(code);
            onLaneUp?.(col, event);
        }
    }

    function leave() {
        releaseAll(null);
        onLeave?.();
    }

    function visibility() {
        if (doc?.visibilityState === "hidden") leave();
    }

    target.addEventListener("keydown", keydown);
    target.addEventListener("keyup", keyup);
    target.addEventListener("blur", leave);
    doc?.addEventListener?.("visibilitychange", visibility);

    return {
        setKeys(next) {
            releaseAll(null);
            bindings = new Map(next.map((code, col) => [code, col]));
        },
        setCapture(fn) { capture = fn ?? null; },
        releaseAll,
        isHeld: (col) => [...held.values()].some((h) => h.col === col),
        heldColumns: () => [...held.values()].map((h) => h.col),
        detach() {
            target.removeEventListener("keydown", keydown);
            target.removeEventListener("keyup", keyup);
            target.removeEventListener("blur", leave);
            doc?.removeEventListener?.("visibilitychange", visibility);
        },
    };
}
