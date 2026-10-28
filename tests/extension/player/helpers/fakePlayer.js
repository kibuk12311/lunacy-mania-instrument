// Just enough browser for boot() of extension/player/main.js under node:test: a DOM of plain objects, a window with
// a controllable performance clock and requestAnimationFrame, a fake AudioContext-backed audio and a fake client.

function makeNode(tag, doc) {
    const listeners = {};
    const attrs = {};
    const node = {
        tagName: String(tag).toUpperCase(), ownerDocument: doc, parent: null, children: [],
        className: "", textContent: "", dataset: {}, style: {}, hidden: false, disabled: false, selected: false, checked: false,
        value: "", type: "", files: null, width: 300, height: 150, clientWidth: 800, clientHeight: 600, onclick: null,
        classList: {
            add: (c) => { if (!node.className.split(" ").includes(c)) node.className = `${node.className} ${c}`.trim(); },
            remove: (c) => { node.className = node.className.split(" ").filter((x) => x !== c).join(" "); },
            contains: (c) => node.className.split(" ").includes(c),
            toggle: (c, on) => (on ?? !node.classList.contains(c) ? node.classList.add(c) : node.classList.remove(c)),
        },
        setAttribute(name, value) { attrs[name] = String(value); if (name === "hidden") node.hidden = true; },
        getAttribute: (name) => attrs[name] ?? null,
        removeAttribute(name) { delete attrs[name]; },
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
        dispatch(type, props = {}) {
            const event = { type, target: props.target ?? node, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
            let at = node;
            while (at) { // bubble
                for (const fn of [...(at.listenersOf(type))]) fn(event);
                if (type === "click" && at.onclick) at.onclick(event);
                at = at.parent;
            }
            return event;
        },
        listenersOf: (type) => listeners[type] ?? [],
        click() { if (!node.disabled) node.dispatch("click"); },
        focus() {},
        append(...kids) {
            for (const kid of kids) { // like the DOM: anything that is not a node becomes text ("null" included)
                const child = kid && typeof kid === "object" && kid.tagName ? kid : Object.assign(makeNode("#text", doc), { textContent: String(kid) });
                child.parent = node;
                node.children.push(child);
            }
        },
        replaceChildren(...kids) {
            for (const k of node.children) k.parent = null;
            node.children = [];
            node.append(...kids);
        },
        get firstChild() { return node.children[0] ?? null; },
        closest(selector) {
            const tags = selector.split(",").map((s) => s.trim().toUpperCase());
            for (let at = node; at; at = at.parent) if (tags.includes(at.tagName)) return at;
            return null;
        },
        getContext: () => fakeContext2d(),
        attrs,
    };
    return node;
}

function fakeContext2d() {
    const target = { calls: 0 };
    return new Proxy(target, {
        get(obj, key) {
            if (key in obj) return obj[key];
            if (key === "createLinearGradient") return () => ({ addColorStop() {} });
            return () => { obj.calls += 1; };
        },
        set(obj, key, value) { obj[key] = value; return true; },
    });
}

export function fakeDocument() {
    const doc = { title: "", visibilityState: "visible" };
    const docListeners = {};
    doc.createElement = (tag) => makeNode(tag, doc);
    doc.documentElement = makeNode("html", doc);
    doc.body = makeNode("body", doc);
    const root = makeNode("main", doc);
    root.parent = doc.body;
    doc.body.children.push(root);
    doc.getElementById = (id) => (id === "lm-player" ? root : null);
    doc.addEventListener = (type, fn) => { (docListeners[type] ??= []).push(fn); };
    doc.removeEventListener = (type, fn) => { docListeners[type] = (docListeners[type] ?? []).filter((f) => f !== fn); };
    doc.fire = (type, props = {}) => {
        const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
        for (const fn of [...(docListeners[type] ?? [])]) fn(event);
        return event;
    };
    doc.root = root;
    return doc;
}

export function fakeWindow() {
    const listeners = {};
    let now = 1000;
    let frames = new Map();
    let nextFrame = 1;
    const posted = [];
    const win = {
        devicePixelRatio: 1, innerWidth: 800, innerHeight: 600,
        performance: { now: () => now },
        requestAnimationFrame(cb) { const id = nextFrame++; frames.set(id, cb); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
        fire(type, props = {}) {
            const event = { type, timeStamp: now, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
            for (const fn of [...(listeners[type] ?? [])]) fn(event);
            return event;
        },
        focus() {},
        parent: { postMessage: (message, origin) => posted.push({ message, origin }) },
        posted,
        get now() { return now; },
        // move the clock and run the frames that were due
        step(ms) {
            now += ms;
            const due = frames;
            frames = new Map();
            for (const cb of due.values()) cb(now);
        },
        get pendingFrames() { return frames.size; },
    };
    return win;
}

// audio whose ctx time is the window's performance clock (seconds) while running, frozen while suspended
export function fakeAudio(win, { duration = 10, decodeFails = false } = {}) {
    let frozenAt = null;
    let shift = 0;
    const played = [];
    const ctx = {
        state: "suspended",
        outputLatency: 0,
        get currentTime() { return frozenAt ?? (win.now / 1000 - shift); },
    };
    frozenAt = win.now / 1000;
    const run = () => {
        if (ctx.state === "running") return;
        shift = win.now / 1000 - frozenAt;
        frozenAt = null;
        ctx.state = "running";
    };
    return {
        ctx,
        played,
        volume: 0.6,
        async decode(bytes) {
            if (decodeFails) throw new Error("cannot decode");
            return { duration, bytes };
        },
        async unlock() { run(); },
        play(buffer, opts) { played.push({ buffer, ...opts }); },
        stop() { played.push("stop"); },
        async pause() { if (ctx.state === "running") { frozenAt = ctx.currentTime; ctx.state = "suspended"; } },
        async resume() { run(); },
        setVolume(v) { this.volume = v; },
        async close() { ctx.state = "closed"; },
    };
}

export const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// depth-first search of the fake DOM
export function findAll(node, pred, out = []) {
    if (pred(node)) out.push(node);
    for (const kid of node.children ?? []) findAll(kid, pred, out);
    return out;
}
export const byAction = (root, action) => findAll(root, (n) => n.dataset?.lmAction === action)[0] ?? null;
export const textOf = (node) => (node.children?.length ? node.children.map(textOf).join(" ") : node.textContent ?? "");
