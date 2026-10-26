// Rate-changed audio through the bundled ffmpeg: time-stretch keeps the pitch, nightcore changes it with the speed.
import { execFile } from "node:child_process";

const run = (ffmpeg, args) => new Promise((resolve) => {
    execFile(ffmpeg, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stderr: String(stderr) }));
});

// atempo takes 0.5…100 per stage, so slower rates are split into several stages.
export function rateFilter({ rate, pitch, sampleRate }) {
    if (pitch) return `asetrate=${Math.round(sampleRate * rate)},aresample=${sampleRate}`;
    const stages = [];
    let left = rate;
    while (left < 0.5) {
        stages.push(0.5);
        left /= 0.5;
    }
    stages.push(Number(left.toFixed(6)));
    return stages.map((s) => `atempo=${s}`).join(",");
}

// Sample rate and duration from ffmpeg's own stream report.
export async function probeAudio(ffmpeg, input) {
    const { stderr } = await run(ffmpeg, ["-hide_banner", "-i", input]);
    const hz = /(\d+) Hz/.exec(stderr);
    const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
    return {
        sampleRate: hz ? Number(hz[1]) : 44100,
        durationSec: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
    };
}

export async function renderRateAudio({ ffmpeg, input, output, rate, pitch }) {
    const { sampleRate } = await probeAudio(ffmpeg, input);
    const { error, stderr } = await run(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", input,
        "-vn", "-af", rateFilter({ rate, pitch, sampleRate }),
        "-codec:a", "libmp3lame", "-q:a", "2", output,
    ]);
    if (error) throw new Error(`ffmpeg: ${stderr.trim().split(/\r?\n/).at(-1) || error.message}`);
    return output;
}
