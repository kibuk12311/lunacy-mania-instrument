// A song with six parts, like a typical rhythm-game track (160 BPM, first beat at 250 ms):
// intro (quiet beats), build-up (1/4 clicks getting louder), drop (loud 1/4 with bass), break (quiet beats),
// drop, outro (quiet beats).
export const PARTS_SONG = [
    { kind: "intro", startMs: 0, endMs: 21250 },
    { kind: "build", startMs: 21250, endMs: 36250 },
    { kind: "drop", startMs: 36250, endMs: 66250 },
    { kind: "break", startMs: 66250, endMs: 84250 },
    { kind: "drop", startMs: 84250, endMs: 114250 },
    { kind: "outro", startMs: 114250, endMs: 130000 },
];
export const PARTS_SONG_BPM = 160;
export const PARTS_SONG_OFFSET = 250;

export function partsSong({ sampleRate = 22050 } = {}) {
    const seconds = PARTS_SONG.at(-1).endMs / 1000;
    const out = new Float32Array(Math.round(seconds * sampleRate));
    let s = 11;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const step = 60000 / PARTS_SONG_BPM / 4;
    for (let k = 0, t = PARTS_SONG_OFFSET; t < seconds * 1000; k += 1, t = PARTS_SONG_OFFSET + k * step) {
        const part = PARTS_SONG.find((p) => t >= p.startMs && t < p.endMs);
        const onBeat = k % 4 === 0;
        let amp = 0;
        let bass = 0;
        if (part.kind === "drop") {
            amp = onBeat ? 1 : 0.7;
            bass = onBeat ? 0.8 : 0;
        } else if (part.kind === "build") {
            const x = (t - part.startMs) / (part.endMs - part.startMs);
            amp = (0.3 + 0.6 * x) * (onBeat ? 1 : 0.6);
        } else if (onBeat) {
            amp = 0.22;
        }
        if (!amp) continue;
        const start = Math.round((t / 1000) * sampleRate);
        for (let i = 0; i < 600 && start + i < out.length; i += 1) {
            const decay = Math.exp(-i / 110);
            out[start + i] += amp * (rand() * 0.6 + bass * Math.sin((2 * Math.PI * 55 * i) / sampleRate)) * decay;
        }
    }
    for (let i = 0; i < out.length; i += 1) out[i] += rand() * 0.004;
    return out;
}
