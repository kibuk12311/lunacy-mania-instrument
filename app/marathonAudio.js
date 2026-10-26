// One mp3 for a marathon: each map's audio cut to its notes, played at its rate, padded/trimmed to the exact length
// the chart expects (so notes never drift), joined with silent gaps.
import { execFile } from "node:child_process";
import { rateFilter, probeAudio } from "./rateAudio.js";

const OUT_RATE = 44100;
const sec = (ms) => String(Number((ms / 1000).toFixed(6)));

export function marathonFilter(segments, { gapMs, pitch }) {
    const parts = [];
    const chain = [];
    segments.forEach((s, i) => {
        const samples = Math.round(((s.srcEndMs - s.srcStartMs) / s.rate / 1000) * OUT_RATE);
        parts.push(
            `[${i}:a]atrim=start=${sec(s.srcStartMs)}:end=${sec(s.srcEndMs)},asetpts=PTS-STARTPTS,`
            + `${rateFilter({ rate: s.rate, pitch, sampleRate: s.sampleRate })},aresample=${OUT_RATE},`
            + `aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=${samples}[s${i}]`,
        );
        chain.push(`[s${i}]`);
        if (i + 1 < segments.length) {
            parts.push(`anullsrc=r=${OUT_RATE}:cl=stereo:d=${sec(gapMs)}[g${i}]`);
            chain.push(`[g${i}]`);
        }
    });
    return `${parts.join(";")};${chain.join("")}concat=n=${chain.length}:v=0:a=1[out]`;
}

export async function renderMarathonAudio({ ffmpeg, segments, gapMs, pitch, output }) {
    const withRates = [];
    for (const s of segments) withRates.push({ ...s, sampleRate: (await probeAudio(ffmpeg, s.path)).sampleRate });
    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    for (const s of withRates) args.push("-i", s.path);
    args.push("-filter_complex", marathonFilter(withRates, { gapMs, pitch }), "-map", "[out]", "-codec:a", "libmp3lame", "-q:a", "2", output);
    await new Promise((resolve, reject) => {
        execFile(ffmpeg, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, _out, stderr) => {
            if (error) reject(new Error(`ffmpeg: ${String(stderr).trim().split(/\r?\n/).at(-1) || error.message}`));
            else resolve();
        });
    });
    return output;
}
