// Generated maps kept in main by id (mapgen v3): the window only ever sends ids back to save or lock a map.
// A small LRU: reading an entry makes it the newest; past `max` the oldest is dropped.
import { randomUUID } from "node:crypto";

export function createGeneratedStore({ max = 24 } = {}) {
    const entries = new Map(); // id → entry, oldest first
    const known = (id) => typeof id === "string" && entries.has(id);
    return {
        put(entry) {
            const id = randomUUID();
            entries.set(id, entry);
            while (entries.size > max) entries.delete(entries.keys().next().value);
            return id;
        },
        get(id) {
            if (!known(id)) return null;
            const entry = entries.get(id);
            entries.delete(id);
            entries.set(id, entry);
            return entry;
        },
        has: known,
    };
}
