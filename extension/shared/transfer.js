// Bytes across Chrome extension messaging, which carries JSON only: base64 text in pieces of at most 1 MiB of bytes.
export const CHUNK_BYTES = 1024 * 1024;
const BLOCK = 0x8000; // String.fromCharCode.apply takes this many arguments safely

export function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    let binary = "";
    for (let i = 0; i < view.length; i += BLOCK) binary += String.fromCharCode.apply(null, view.subarray(i, i + BLOCK));
    return btoa(binary);
}

export function base64ToBytes(text) {
    const binary = atob(String(text ?? ""));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

// One Uint8Array of all the parts, in order.
export function concatBytes(parts) {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

// Gathers the pieces a stream gives (any sizes) into pieces of exactly `size` bytes (the last one shorter).
export function createChunker(size = CHUNK_BYTES) {
    let parts = [];
    let held = 0;
    const take = () => {
        const all = concatBytes(parts);
        const out = all.subarray(0, Math.min(size, all.length));
        const rest = all.subarray(out.length);
        parts = rest.length ? [rest] : [];
        held = rest.length;
        return out;
    };
    return {
        // → the full pieces that are ready now
        push(bytes) {
            if (bytes?.length) {
                parts.push(bytes);
                held += bytes.length;
            }
            const ready = [];
            while (held >= size) ready.push(take());
            return ready;
        },
        // → what is left (may be empty)
        flush() {
            return held ? take() : new Uint8Array(0);
        },
        get held() {
            return held;
        },
    };
}

// Base64 pieces of a whole byte array (for tests and small payloads).
export function* base64Chunks(bytes, size = CHUNK_BYTES) {
    for (let i = 0; i < bytes.length; i += size) yield bytesToBase64(bytes.subarray(i, i + size));
}
