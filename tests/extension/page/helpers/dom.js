// A small DOM for the page lane's tests: elements, text, attributes, dataset, classList, style, events (capture,
// bubble, shadow retargeting), open shadow roots, a selector engine (tag #id .class [attr op v], descendant and child
// combinators, lists), an HTML parser for fixture bodies, a fake window (location, history, postMessage-free) with
// fake timers and a manual MutationObserver. Only what content/*.js uses.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);

const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k] ?? m;
});

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export class FakeEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.bubbles = !!init.bubbles;
        this.cancelable = init.cancelable ?? true;
        this.defaultPrevented = false;
        this.target = null;
        this.currentTarget = null;
        this.stopped = false;
        Object.assign(this, init);
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
    stopImmediatePropagation() { this.stopped = true; }
}

class Target {
    constructor() { this._listeners = []; }
    addEventListener(type, fn, opts) {
        const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
        if (!this._listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) this._listeners.push({ type, fn, capture });
    }
    removeEventListener(type, fn, opts) {
        const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
        this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
    }
    _fire(event, phase) {
        for (const l of [...this._listeners]) {
            if (l.type !== event.type) continue;
            if (phase === "capture" && !l.capture) continue;
            if (phase === "bubble" && l.capture) continue;
            event.currentTarget = this;
            l.fn.call(this, event);
        }
    }
    // the path from this node up to the window, each with the target the listener sees (shadow trees retarget)
    _path() {
        const path = [];
        let node = this;
        let seen = this;
        while (node) {
            path.push({ node, seen });
            if (node instanceof ShadowRoot) {
                node = node.host;
                seen = node;
            } else if (node instanceof Document) node = node.defaultView ?? null;
            else node = node.parentNode ?? null;
        }
        return path;
    }
    dispatchEvent(event) {
        const path = this._path();
        for (let i = path.length - 1; i >= 1 && !event.stopped; i--) {
            event.target = path[i].seen;
            path[i].node._fire(event, "capture");
        }
        if (!event.stopped) {
            event.target = this;
            this._fire(event, "target");
        }
        if (event.bubbles) {
            for (let i = 1; i < path.length && !event.stopped; i++) {
                event.target = path[i].seen;
                path[i].node._fire(event, "bubble");
            }
        }
        event.target = this;
        return !event.defaultPrevented;
    }
}

class Node extends Target {
    constructor(doc) {
        super();
        this.ownerDocument = doc;
        this.parentNode = null;
        this.childNodes = [];
    }
    get children() { return this.childNodes.filter((n) => n instanceof Element); }
    get firstElementChild() { return this.children[0] ?? null; }
    get lastElementChild() { return this.children.at(-1) ?? null; }
    get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
    get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
    set textContent(value) {
        this.replaceChildren();
        if (value !== "" && value !== null && value !== undefined) this.append(String(value));
    }
    get isConnected() {
        let node = this;
        while (node) {
            if (node instanceof Document) return true;
            node = node instanceof ShadowRoot ? node.host : node.parentNode;
        }
        return false;
    }
    _adopt(child) {
        const node = typeof child === "string" ? new Text(this.ownerDocument, child) : child;
        if (node.parentNode) node.parentNode._detach(node);
        node.parentNode = this;
        return node;
    }
    _detach(child) {
        const i = this.childNodes.indexOf(child);
        if (i >= 0) this.childNodes.splice(i, 1);
        child.parentNode = null;
    }
    append(...nodes) { for (const n of nodes) this.childNodes.push(this._adopt(n)); }
    appendChild(n) { this.append(n); return n; }
    prepend(...nodes) { this.childNodes.unshift(...nodes.map((n) => this._adopt(n))); }
    insertBefore(node, ref) {
        if (!ref) return this.appendChild(node);
        const adopted = this._adopt(node);
        this.childNodes.splice(this.childNodes.indexOf(ref), 0, adopted);
        return adopted;
    }
    removeChild(n) { this._detach(n); return n; }
    replaceChildren(...nodes) {
        for (const c of [...this.childNodes]) this._detach(c);
        this.append(...nodes);
    }
    remove() { this.parentNode?._detach(this); }
    contains(node) {
        for (let n = node; n; n = n.parentNode) if (n === this) return true;
        return false;
    }
    _descendants() {
        const out = [];
        const walk = (n) => {
            for (const c of n.childNodes) if (c instanceof Element) {
                out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
    querySelectorAll(selector) {
        const list = parseSelector(selector);
        return this._descendants().filter((el) => list.some((complex) => matchComplex(el, complex, this)));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class Text extends Node {
    constructor(doc, data) {
        super(doc);
        this.nodeType = 3;
        this.data = String(data);
    }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
}

class ShadowRoot extends Node {
    constructor(doc, host, mode) {
        super(doc);
        this.host = host;
        this.mode = mode;
        this.activeElement = null;
    }
}

export class Element extends Node {
    constructor(doc, tag) {
        super(doc);
        this.nodeType = 1;
        this.localName = tag.toLowerCase();
        this.tagName = tag.toUpperCase();
        this._attrs = new Map();
        this.shadowRoot = null;
        const self = this;
        this.style = { setProperty(k, v) { this[camel(k)] = v; }, removeProperty(k) { delete this[camel(k)]; }, getPropertyValue(k) { return this[camel(k)] ?? ""; } };
        this.dataset = new Proxy({}, {
            get: (_, k) => (typeof k === "string" ? self.getAttribute(`data-${kebab(k)}`) ?? undefined : undefined),
            set: (_, k, v) => { self.setAttribute(`data-${kebab(k)}`, String(v)); return true; },
            deleteProperty: (_, k) => { self.removeAttribute(`data-${kebab(k)}`); return true; },
            has: (_, k) => self.hasAttribute(`data-${kebab(k)}`),
            ownKeys: () => [...self._attrs.keys()].filter((a) => a.startsWith("data-")).map((a) => camel(a.slice(5))),
            getOwnPropertyDescriptor: (_, k) => (self.hasAttribute(`data-${kebab(k)}`) ? { enumerable: true, configurable: true, value: self.getAttribute(`data-${kebab(k)}`) } : undefined),
        });
        this.classList = {
            contains: (c) => self.className.split(/\s+/).includes(c),
            add: (...cs) => { self.className = [...new Set([...self.className.split(/\s+/), ...cs])].filter(Boolean).join(" "); },
            remove: (...cs) => { self.className = self.className.split(/\s+/).filter((x) => x && !cs.includes(x)).join(" "); },
            toggle: (c, force) => {
                const on = force ?? !self.classList.contains(c);
                if (on) self.classList.add(c);
                else self.classList.remove(c);
                return on;
            },
        };
        if (this.localName === "iframe") this.contentWindow = { focused: 0, focus() { this.focused++; } };
    }
    get id() { return this.getAttribute("id") ?? ""; }
    set id(v) { this.setAttribute("id", v); }
    get className() { return this.getAttribute("class") ?? ""; }
    set className(v) { this.setAttribute("class", v); }
    get disabled() { return this.hasAttribute("disabled"); }
    set disabled(v) { if (v) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
    get href() { return this.getAttribute("href") ?? ""; }
    get src() { return this.getAttribute("src") ?? ""; }
    getAttribute(name) { return this._attrs.has(name.toLowerCase()) ? this._attrs.get(name.toLowerCase()) : null; }
    setAttribute(name, value) { this._attrs.set(name.toLowerCase(), String(value)); }
    hasAttribute(name) { return this._attrs.has(name.toLowerCase()); }
    removeAttribute(name) { this._attrs.delete(name.toLowerCase()); }
    toggleAttribute(name, force) {
        const on = force ?? !this.hasAttribute(name);
        if (on) this.setAttribute(name, "");
        else this.removeAttribute(name);
        return on;
    }
    getAttributeNames() { return [...this._attrs.keys()]; }
    get nextElementSibling() {
        const sibs = this.parentNode?.children ?? [];
        return sibs[sibs.indexOf(this) + 1] ?? null;
    }
    get previousElementSibling() {
        const sibs = this.parentNode?.children ?? [];
        const i = sibs.indexOf(this);
        return i > 0 ? sibs[i - 1] : null;
    }
    insertAdjacentElement(position, el) {
        const p = position.toLowerCase();
        if (p === "beforebegin") this.parentNode.insertBefore(el, this);
        else if (p === "afterend") this.parentNode.insertBefore(el, this.nextElementSibling ? this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] : null);
        else if (p === "afterbegin") this.prepend(el);
        else if (p === "beforeend") this.append(el);
        return el;
    }
    attachShadow({ mode }) {
        this.shadowRoot = new ShadowRoot(this.ownerDocument, this, mode);
        return this.shadowRoot;
    }
    matches(selector) { return parseSelector(selector).some((c) => matchComplex(this, c, null)); }
    closest(selector) {
        for (let n = this; n instanceof Element; n = n.parentNode) if (n.matches(selector)) return n;
        return null;
    }
    click() { this.dispatchEvent(new FakeEvent("click", { bubbles: true })); }
    focus() {
        let root = this.parentNode;
        while (root && !(root instanceof ShadowRoot) && !(root instanceof Document)) root = root.parentNode;
        if (root instanceof ShadowRoot) {
            root.activeElement = this;
            this.ownerDocument.activeElement = root.host;
        } else this.ownerDocument.activeElement = this;
        this.ownerDocument.focusLog.push(this);
    }
    blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
}

export class Document extends Node {
    constructor() {
        super(null);
        this.ownerDocument = this;
        this.defaultView = null;
        this.focusLog = [];
        this.documentElement = new Element(this, "html");
        this.append(this.documentElement);
        this.head = new Element(this, "head");
        this.body = new Element(this, "body");
        this.documentElement.append(this.head, this.body);
        this.activeElement = this.body;
    }
    createElement(tag) { return new Element(this, tag); }
    createTextNode(data) { return new Text(this, data); }
    getElementById(id) { return this._descendants().find((e) => e.id === id) ?? null; }
}

// ---- selectors
function splitTop(s, sep) {
    const out = [];
    let depth = 0, quote = null, cur = "";
    for (const ch of s) {
        if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === "[" || ch === "(") depth++;
        if (ch === "]" || ch === ")") depth--;
        if (depth === 0 && ch === sep) { out.push(cur); cur = ""; continue; }
        cur += ch;
    }
    out.push(cur);
    return out;
}

const cache = new Map();
function parseSelector(selector) {
    if (cache.has(selector)) return cache.get(selector);
    const list = splitTop(selector, ",").map((part) => {
        const tokens = [];
        const re = /\s*(>)\s*|\s+|((?:[a-zA-Z*][\w-]*)?(?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)/gy;
        const src = part.trim();
        let m;
        let pendingComb = null;
        re.lastIndex = 0;
        while (re.lastIndex < src.length && (m = re.exec(src))) {
            if (m[1]) pendingComb = ">";
            else if (m[2]) {
                tokens.push({ comb: tokens.length ? pendingComb ?? " " : null, compound: parseCompound(m[2]) });
                pendingComb = null;
            } else if (!m[0]) throw new Error(`bad selector: ${selector}`);
        }
        return tokens;
    });
    cache.set(selector, list);
    return list;
}
function parseCompound(s) {
    const c = { tag: null, ids: [], classes: [], attrs: [] };
    const re = /^([a-zA-Z*][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/g;
    let m;
    while ((m = re.exec(s))) {
        if (m[1]) c.tag = m[1] === "*" ? null : m[1].toLowerCase();
        else if (m[2]) c.ids.push(m[2]);
        else if (m[3]) c.classes.push(m[3]);
        else c.attrs.push({ name: m[4].toLowerCase(), op: m[5] ?? null, value: m[6] ?? m[7] ?? m[8] ?? "" });
    }
    return c;
}
function matchCompound(el, c) {
    if (!(el instanceof Element)) return false;
    if (c.tag && el.localName !== c.tag) return false;
    if (c.ids.some((id) => el.id !== id)) return false;
    const cls = el.className.split(/\s+/);
    if (c.classes.some((x) => !cls.includes(x))) return false;
    for (const a of c.attrs) {
        const v = el.getAttribute(a.name);
        if (v === null) return false;
        if (!a.op) continue;
        if (a.op === "=" && v !== a.value) return false;
        if (a.op === "^=" && !v.startsWith(a.value)) return false;
        if (a.op === "$=" && !v.endsWith(a.value)) return false;
        if (a.op === "*=" && !v.includes(a.value)) return false;
        if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
    }
    return true;
}
function matchComplex(el, tokens, scope) {
    const match = (node, i) => {
        if (!matchCompound(node, tokens[i].compound)) return false;
        if (i === 0) return true;
        const comb = tokens[i].comb;
        if (comb === ">") {
            const p = node.parentNode;
            return p instanceof Element && p !== scope && match(p, i - 1);
        }
        for (let p = node.parentNode; p instanceof Element && p !== scope; p = p.parentNode) if (match(p, i - 1)) return true;
        return false;
    };
    return match(el, tokens.length - 1);
}

// ---- HTML
export function parseInto(doc, parent, html) {
    const stack = [parent];
    const top = () => stack.at(-1);
    const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/gi;
    let m;
    while ((m = re.exec(html))) {
        if (m[1]) {
            const name = m[1].toLowerCase();
            for (let i = stack.length - 1; i > 0; i--) if (stack[i].localName === name) { stack.length = i; break; }
        } else if (m[2]) {
            const el = doc.createElement(m[2]);
            const attrRe = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
            let a;
            while ((a = attrRe.exec(m[3] ?? ""))) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ""));
            top().append(el);
            const name = el.localName;
            if (RAW.has(name)) {
                const end = html.toLowerCase().indexOf(`</${name}`, re.lastIndex);
                const stop = end < 0 ? html.length : end;
                const raw = html.slice(re.lastIndex, stop);
                if (raw) el.append(name === "textarea" || name === "title" ? decode(raw) : raw);
                const close = html.indexOf(">", stop);
                re.lastIndex = close < 0 ? html.length : close + 1;
            } else if (!VOID.has(name) && !m[4]) stack.push(el);
        } else if (m[5]) {
            top().append(decode(m[5]));
        }
    }
    return parent;
}

// A document from a full page (its <html> attributes, head and body) or a body fragment.
export function makeDocument(html = "") {
    const doc = new Document();
    const htmlTag = /<html\b([^>]*)>/i.exec(html);
    if (htmlTag) {
        const holder = doc.createElement("div");
        parseInto(doc, holder, `<x ${htmlTag[1]}>`);
        for (const name of holder.firstElementChild.getAttributeNames()) doc.documentElement.setAttribute(name, holder.firstElementChild.getAttribute(name));
    }
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
    if (head) parseInto(doc, doc.head, head[1]);
    const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
    parseInto(doc, doc.body, body ? body[1] : htmlTag ? "" : html);
    return doc;
}

// ---- timers and the window
export function fakeTimers() {
    let now = 0;
    let nextId = 1;
    const jobs = new Map();
    const add = (fn, ms, every) => {
        const id = nextId++;
        jobs.set(id, { fn, at: now + Math.max(0, ms | 0), every: every ? Math.max(1, ms | 0) : 0 });
        return id;
    };
    return {
        setTimeout: (fn, ms = 0) => add(fn, ms, false),
        setInterval: (fn, ms = 0) => add(fn, ms, true),
        clearTimeout: (id) => jobs.delete(id),
        clearInterval: (id) => jobs.delete(id),
        get now() { return now; },
        get pending() { return jobs.size; },
        tick(ms) {
            const end = now + ms;
            for (;;) {
                let next = null;
                for (const [id, j] of jobs) if (j.at <= end && (!next || j.at < next[1].at || (j.at === next[1].at && id < next[0]))) next = [id, j];
                if (!next) break;
                const [id, j] = next;
                now = j.at;
                if (j.every) j.at += j.every;
                else jobs.delete(id);
                j.fn();
            }
            now = end;
        },
    };
}

export function makeWindow(doc, { url = "https://osu.ppy.sh/", language = "en-US", timers = fakeTimers() } = {}) {
    const win = new Target();
    let href = new URL(url);
    const location = {
        get href() { return href.href; },
        get pathname() { return href.pathname; },
        get hash() { return href.hash; },
        set hash(v) {
            href = new URL(`#${String(v).replace(/^#/, "")}`, href);
            win.dispatchEvent(new FakeEvent("hashchange"));
        },
        get search() { return href.search; },
        get origin() { return href.origin; },
    };
    const observers = new Set();
    class MutationObserver {
        constructor(fn) { this.fn = fn; this.target = null; }
        observe(target, options) { this.target = target; this.options = options; observers.add(this); }
        disconnect() { observers.delete(this); }
        takeRecords() { return []; }
    }
    const history = {
        state: null,
        replaceState(state, _title, next) { this.state = state; href = new URL(next, href); },
        pushState(state, _title, next) { this.state = state; href = new URL(next, href); },
    };
    Object.assign(win, {
        document: doc,
        location,
        history,
        navigator: { language },
        MutationObserver,
        timers,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        observers,
        // call every connected observer once, as a batch of mutations would
        mutate() { for (const o of [...observers]) o.fn([], o); },
        navigate(next) { href = new URL(next, href); },
    });
    doc.defaultView = win;
    return win;
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
