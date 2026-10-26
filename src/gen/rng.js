// Small seeded PRNG so the same seed always gives the same map.
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function pick(rng, items, weights = null) {
    if (!weights) return items[Math.floor(rng() * items.length)];
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < items.length; i += 1) {
        r -= weights[i];
        if (r < 0) return items[i];
    }
    return items.at(-1);
}

// One seed from several integers (a map's seed, a part, a block, a retry round …): the same inputs always give the
// same seed, and neighbouring inputs give unrelated ones.
export function deriveSeed(...ints) {
    let h = 0x811c9dc5;
    for (const x of ints) {
        h = Math.imul(h ^ (Number(x) >>> 0), 0x01000193);
        h ^= h >>> 15;
        h = Math.imul(h, 0x2c1b3c6d);
        h ^= h >>> 12;
        h = Math.imul(h, 0x297a2d39);
        h ^= h >>> 15;
    }
    return h >>> 0;
}
