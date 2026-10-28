// A small stand-in for the extension APIs the extension uses, for node:test (no browser): chrome.runtime
// (id, getURL, getManifest, sendMessage/onMessage, connect/onConnect, lastError) and chrome.storage.local.
// Messages and port messages are JSON-cloned on the way, as Chrome's extension messaging does (a Uint8Array arrives
// as a plain object), and delivered asynchronously. Other lanes may import it read-only.
//
//   const fake = createFakeChrome({ storage: { "lm.page.v1": { ratesOpen: true } } });
//   fake.chrome.runtime.onMessage.addListener(handler);   // the "background"
//   globalThis.chrome = fake.chrome;                        // or pass fake.chrome.runtime where code takes one
//   fake.invalidate();                                      // the extension was reloaded: calls throw
//   fake.sent                                               // every runtime message, in order
//   fake.ports                                              // every port opened with runtime.connect

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const jsonClone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export function createEvent() {
    const listeners = new Set();
    return {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
        hasListener: (fn) => listeners.has(fn),
        hasListeners: () => listeners.size > 0,
        get listeners() {
            return [...listeners];
        },
    };
}

export function createFakeChrome({
    id = "lmfakeextensionid", manifest = { manifest_version: 3, version: "0.1.0" }, storage = {},
    origin = `chrome-extension://${id}`, sender = { id, url: "https://osu.ppy.sh/beatmapsets/1", origin: "https://osu.ppy.sh" },
} = {}) {
    let valid = true;
    const sent = [];
    const ports = [];
    const store = new Map(Object.entries(jsonClone(storage) ?? {}));
    const storageChanged = createEvent();

    const guard = () => {
        if (!valid) throw new Error("Extension context invalidated.");
    };

    const runtime = {
        id,
        lastError: undefined,
        onMessage: createEvent(),
        onConnect: createEvent(),
        getURL: (path = "") => `${origin}/${String(path).replace(/^\//, "")}`,
        getManifest: () => jsonClone(manifest),
        // Promise form when no callback is given (as MV3 Chrome); the callback sees runtime.lastError when nobody answers.
        sendMessage(message, callback) {
            guard();
            const copy = jsonClone(message);
            sent.push(copy);
            const done = deliver(copy);
            if (typeof callback !== "function") {
                return done.then(({ answered, value }) => {
                    if (!answered) throw new Error("Could not establish connection. Receiving end does not exist.");
                    return value;
                });
            }
            done.then(({ answered, value }) => {
                if (!answered) runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
                try {
                    callback(answered ? value : undefined);
                } finally {
                    runtime.lastError = undefined;
                }
            });
            return undefined;
        },
        connect({ name = "" } = {}) {
            guard();
            const [mine, theirs] = portPair(name);
            ports.push(mine);
            tick().then(() => {
                for (const fn of runtime.onConnect.listeners) fn(theirs);
            });
            return mine;
        },
    };

    // Each listener in turn, as Chrome does; the first sendResponse wins. A listener that returns true keeps the
    // channel open; one that returns a promise answers with its value (the Firefox way).
    async function deliver(message) {
        await tick();
        return new Promise((resolve) => {
            let answered = false;
            let open = 0;
            const respond = (value) => {
                if (answered) return;
                answered = true;
                resolve({ answered: true, value: jsonClone(value) });
            };
            for (const fn of runtime.onMessage.listeners) {
                let keep;
                try {
                    keep = fn(message, jsonClone(sender), respond);
                } catch {
                    keep = undefined;
                }
                if (keep === true) open += 1;
                else if (keep && typeof keep.then === "function") {
                    open += 1;
                    keep.then(respond, () => respond(undefined));
                }
            }
            if (!open && !answered) resolve({ answered: false });
        });
    }

    function portPair(name) {
        const make = () => ({
            name,
            sender: jsonClone(sender),
            onMessage: createEvent(),
            onDisconnect: createEvent(),
            connected: true,
            posted: [],
        });
        const a = make();
        const b = make();
        const wire = (self, other) => {
            self.postMessage = (message) => {
                if (!self.connected) throw new Error("Attempting to use a disconnected port object");
                const copy = jsonClone(message);
                self.posted.push(copy);
                tick().then(() => {
                    if (!other.connected) return;
                    for (const fn of other.onMessage.listeners) fn(copy, other);
                });
            };
            self.disconnect = () => {
                if (!self.connected) return;
                self.connected = false;
                other.connected = false;
                tick().then(() => {
                    for (const fn of other.onDisconnect.listeners) fn(other);
                });
            };
        };
        wire(a, b);
        wire(b, a);
        return [a, b];
    }

    const pick = (keys) => {
        if (keys === null || keys === undefined) return Object.fromEntries(store);
        if (typeof keys === "string") return store.has(keys) ? { [keys]: jsonClone(store.get(keys)) } : {};
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, jsonClone(store.get(k))]));
        return Object.fromEntries(Object.entries(keys).map(([k, dflt]) => [k, store.has(k) ? jsonClone(store.get(k)) : dflt]));
    };
    const answer = (value, callback) => {
        const p = tick().then(() => value);
        if (typeof callback === "function") {
            p.then(callback);
            return undefined;
        }
        return p;
    };
    const local = {
        get(keys, callback) {
            guard();
            return answer(pick(keys), callback);
        },
        set(items, callback) {
            guard();
            const changes = {};
            for (const [k, v] of Object.entries(items ?? {})) {
                changes[k] = { oldValue: jsonClone(store.get(k)), newValue: jsonClone(v) };
                store.set(k, jsonClone(v));
            }
            tick().then(() => {
                for (const fn of storageChanged.listeners) fn(changes, "local");
            });
            return answer(undefined, callback);
        },
        remove(keys, callback) {
            guard();
            for (const k of [].concat(keys)) store.delete(k);
            return answer(undefined, callback);
        },
        clear(callback) {
            guard();
            store.clear();
            return answer(undefined, callback);
        },
    };

    const chrome = {
        runtime,
        storage: { local, onChanged: storageChanged },
        permissions: { contains: async () => true },
    };

    return {
        chrome,
        sent,
        ports,
        store,
        invalidate() {
            valid = false;
            runtime.id = undefined;
        },
        // answers every runtime message of a type with fn(message) (a tiny "background")
        answer(type, fn) {
            const listener = (message, _sender, sendResponse) => {
                if (message?.type !== type) return undefined;
                Promise.resolve(fn(message)).then(sendResponse);
                return true;
            };
            runtime.onMessage.addListener(listener);
            return listener;
        },
    };
}
