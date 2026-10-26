// Main-process events the tab modules subscribe to without touching main.js:
// "result" — a fresh result for the map selected in osu! ({ key, text, rate, result, checksum });
// "window-load" — the page (re)loaded, after settings and the view were sent.
export const HOOK_NAMES = ["result", "window-load"];

export function createHooks({ log = () => {} } = {}) {
    const subscribers = new Map(HOOK_NAMES.map((name) => [name, []]));
    const listFor = (name) => {
        const list = subscribers.get(name);
        if (!list) throw new Error(`unknown hook "${name}"`);
        return list;
    };
    const report = (name, error) => log(`hook ${name} failed: ${error?.message ?? error}`);

    return {
        on(name, fn) {
            const list = listFor(name);
            if (typeof fn !== "function") throw new TypeError(`hook "${name}" needs a function`);
            const entry = { fn };
            list.push(entry);
            return () => {
                const i = list.indexOf(entry);
                if (i >= 0) list.splice(i, 1);
            };
        },
        // a subscriber that throws or rejects is logged; the rest still run
        emit(name, payload) {
            for (const { fn } of [...listFor(name)]) {
                try {
                    const out = fn(payload);
                    if (out && typeof out.then === "function") out.then(undefined, (error) => report(name, error));
                } catch (error) {
                    report(name, error);
                }
            }
        },
    };
}
