// Just enough of the DOM for the renderer modules under node:test: elements by id, created elements,
// listeners and children, window events and a localStorage stub. Queries find nothing (null / []).
// Every node has getContext("2d") → a context that records its drawing calls in ctx.calls (canvases are 300×150).
// fakeDom(api, { storage }) puts document, window (with danApi = api) and localStorage on globalThis;
// storage is the starting localStorage content, or null for no localStorage at all.
export function fakeDom(api = {}, { storage = {} } = {}) {
    const nodes = new Map();
    const make = (tag = "div") => {
        let ctx = null;
        const node = {
            tagName: String(tag).toUpperCase(), textContent: "", innerHTML: "", value: "", title: "", className: "", type: "",
            disabled: false, checked: false, selected: false, hidden: false, dataset: {}, style: {}, children: [], listeners: {},
            classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
            addEventListener(type, fn) { (node.listeners[type] ??= []).push(fn); },
            removeEventListener(type, fn) { node.listeners[type] = (node.listeners[type] ?? []).filter((f) => f !== fn); },
            replaceChildren(...kids) { node.children = kids; },
            append(...kids) { node.children.push(...kids); },
            querySelector: () => null,
            querySelectorAll: () => [],
            getContext: (type) => (type === "2d" ? (ctx ??= fakeContext2d()) : null),
        };
        if (node.tagName === "CANVAS") Object.assign(node, { width: 300, height: 150 });
        return node;
    };
    const byId = (id) => {
        if (!nodes.has(id)) nodes.set(id, make());
        return nodes.get(id);
    };

    const listeners = {};
    const events = []; // every event dispatched on window, in order
    globalThis.document = { getElementById: byId, createElement: make, querySelector: () => null, querySelectorAll: () => [] };
    globalThis.window = {
        danApi: api,
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
        dispatchEvent(event) {
            events.push(event);
            for (const fn of [...(listeners[event.type] ?? [])]) fn(event);
            return true;
        },
    };

    const store = storage === null ? null : new Map(Object.entries(storage).map(([k, v]) => [k, String(v)]));
    if (store) {
        globalThis.localStorage = {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => { store.set(key, String(value)); },
            removeItem: (key) => { store.delete(key); },
            clear: () => { store.clear(); },
        };
    } else {
        delete globalThis.localStorage;
    }
    return { $: byId, window: globalThis.window, storage: store, events };
}

// A 2d canvas context: properties keep what is set, every method call is recorded as [name, ...args].
function fakeContext2d() {
    const calls = [];
    return new Proxy({}, {
        get(target, key) {
            if (key === "calls") return calls;
            if (key in target || typeof key === "symbol" || key === "then") return target[key];
            if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
            return (...args) => { calls.push([key, ...args]); };
        },
        set(target, key, value) {
            target[key] = value;
            return true;
        },
    });
}

// The text of a node and of all its children, joined with " | ".
export const textOf = (node) => [node.textContent, ...node.children.map(textOf)].filter(Boolean).join(" | ");

// Runs a node's listeners for one event type, one after another.
export async function fire(node, type = "click", event = {}) {
    for (const fn of node.listeners[type] ?? []) await fn({ target: node, type, ...event });
}
