// Same 1/4 click pattern all song long, but 30–60 s is a quiet "light part" (quarter amplitude, no bass).
export function dropSong({ bpm = 180, seconds = 90, sampleRate = 22050 }) {
    const out = new Float32Array(seconds * sampleRate);
    let s = 7;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const step = 60000 / bpm / 4;
    for (let t = 300; t < seconds * 1000; t += step) {
        const quiet = t >= 30000 && t < 60000;
        const start = Math.round((t / 1000) * sampleRate);
        for (let k = 0; k < 500 && start + k < out.length; k += 1) {
            const decay = Math.exp(-k / 90);
            const bass = quiet ? 0 : 0.6 * Math.sin((2 * Math.PI * 60 * k) / sampleRate);
            out[start + k] += (quiet ? 0.25 : 1) * (rand() * 0.7 + bass) * decay;
        }
    }
    return out;
}

