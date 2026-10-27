// Builds stepped together on the GPU decoder (ML addendum §11, stream W, designs D3/D4 of
// docs/2026-10-26-webgpu-stream-w.md), the generator worker's side. One variant's GPU source (gpuSource.js) holds a
// decode session on the GPU renderer: the encoder output stays there, each concurrent build is a stream with its own
// decoder ring. Beat by beat, every build of a batch that needs its next beat decoded waits; then ONE request decodes
// that beat for all of them (one round trip worker ↔ GPU renderer per beat per batch), and each build goes on with its
// own lane head (the GPU's first layer + the history, gpu.laneHead's split), sampling (pickRow) and playability guard
// in JS, exactly as the CPU source does. Seeds, part boundaries and the guard never leave the build.
//
//   const batch = createGpuBatch({ backend, session, net, enc, inputs, known })
//   await batch.run(makers, { afterFailure, signal })  // makers[k](stream) → a generator: the build, its result
//   await batch.snapshot(maker)                         // one stream through maker; its return value (a snapshot)
//   batch.drop(snap); batch.release(); batch.off; batch.stats; batch.withStreams(wrap)
//   batch.pays()                                        // whether this variant batches (they pay, or a probe checks)
//   batch.estimate({ builds, ranges })                  // a batch's time and one build's on the CPU decoder, for the
//                                                       // candidates (whose CPU loop stops at a deadline)
//
// A build is a generator over a stream: stream.step(…) answers STEP_WAIT when the beat must be decoded first, and the
// build then yields; run() resumes it with the row. Any GPU error, timeout or lost device during a batch → the batch
// goes on on the CPU (each stream replays its rows on createDecoder and continues there; afterFailure decides which
// unfinished builds are finished), batch.off is set, and the rest of the variant builds on the CPU as before.
import { createDecoder, createHistory, pickRow, N_LANES, DIV_CLASSES } from "../infillModel.js";
import { createLaneHead } from "./infillGpu.js";

export const STEP_WAIT = -1; // a stream's step when its beat is not decoded yet (never a row: rows are 0..15)
export const MIN_BATCH = 2; // fewer builds than this run one after another on the CPU decoder (D1)
// A variant's batches pay when the GPU decodes a build's beat faster than the CPU decoder does: one decode round
// (worker ↔ GPU and back) must cost less than the K beats of the CPU decoder it stands for. K is how many build-beats a
// round of this model's batches decodes, counted in one-beat rounds' worth of GPU time (a round serves several builds,
// and a build that skips over fixed rows or restores a snapshot decodes many beats in one item); it depends on the
// model and the songs, so it is learnt per variant (the median of the last KEPT_VARIANTS). A one-beat round counts as
// one round whatever it took (its speed is the round's cost, below), and a round that decodes more beats counts one
// round plus its extra beats at what an extra beat costs, measured against the one-beat rounds of the same moment. So
// a stall or a slow stretch in a variant shows in the round's cost while it lasts, not in K (the variant's decode time
// against the round at its end turned one 1.5 s round, or a few busy seconds of the GPU, into a K too low for any
// later probe to pass, and batches stayed off for the session). Measured on an RTX 5080
// (docs/2026-10-26-webgpu-stream-w.md): K 10–19 for M, 7–11 for L, 11–15 for S, by the songs. One fixed ratio does not
// fit them all: 19 let L batch up to a round twice its break-even. Before a model's first batch the prior is a round of ROUND_PRIOR_MS
// against ROUND_RATIO CPU beats, which leaves S on its CPU decoder (3 ms against 0.13 ms beats: S's batches lose
// 10–25 %) and lets M and L batch.
export const ROUND_RATIO = 19;
export const ROUND_PRIOR_MS = 3;
// The round's cost is the mean of the last ROUND_WINDOW one-beat rounds without their slowest and fastest eighth: up to
// 8 stalls (a GC, one slow answer) do not move it, a GPU slow for a stretch does (an average of every round let one
// 40 ms round near the end of a batch turn M's batches off for the rest of the session). A mean, not a median: a batch
// costs the sum of its rounds, and S's come at two speeds (≈ 0.8 and 3 ms), where a median took the faster one. Once
// batches are off by what was measured, a variant's first PROBE_ROUNDS one-beat rounds (at most PROBE_MS of decoding)
// run on the GPU again and decide by themselves: if they still do not pay, that batch goes on on the CPU decoder as
// after a failure, and the next probe waits 1, 2, 4, then at most PROBE_WAIT_MAX variants; if they do, the variant
// batches. So a probe costs a slow GPU about PROBE_MS at the most.
export const ROUND_WINDOW = 64;
export const PROBE_ROUNDS = 40;
export const PROBE_MS = 400;
export const PROBE_WAIT_MAX = 8;
// The CPU beat is timed in every variant, and the median of the last CPU_PROBES taken: one probe varies by ±25 % with
// the machine's load (M's 0.30–0.50 ms here), and a model's first one runs beside the GPU renderer's compile of its
// decoder kernel (L's 1.9–2.4 ms instead of ≈ 1.3).
export const CPU_PROBES = 5;
const KEPT_VARIANTS = 3;
const MIN_VARIANT_ROUNDS = 200; // a variant with fewer rounds (a probe, a short song) teaches K nothing
// net → { cpu: [{ beat, slotCpu, slotGpu }] (the last CPU_PROBES), rounds, js, perRound (the last ROUND_WINDOW /
// KEPT_VARIANTS values), wait, backoff }
const learnt = new WeakMap();
const FREE = 255;
const HIST_LEN = 68;
// the first decode of a session may wait for the decoder kernel's compile (2–14 s with Windows' FXC); later ones are
// a few ms, so a GPU that stops answering costs one short wait
export const FIRST_DECODE_MS = 60_000;
export const DECODE_MS = 5_000;

const abortError = (signal) => signal.reason ?? Object.assign(new Error("the batch was cancelled"), { name: "AbortError" });
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// the mean of a list without its top and bottom eighth
const trimmed = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const cut = Math.floor(s.length / 8);
    let sum = 0;
    for (let k = cut; k < s.length - cut; k += 1) sum += s[k];
    return sum / (s.length - 2 * cut);
};
// What an extra beat costs, in one-beat rounds, over a variant's rounds that decoded more than one beat an item
// ([extra beats, cost | null, ms]; null: before any one-beat round, then priced against the round at the end): the
// median over their extra beats, so one stalled round among them changes nothing unless it holds half of them, and
// at most a whole round (a round's extra beats skip the round trip itself), which bounds that one.
const extraBeat = (extra, round) => {
    const xs = extra.map(([x, c, ms]) => [x, Math.min(1, Math.max(0, c ?? (ms / round - 1) / x))]);
    xs.sort((a, b) => a[1] - b[1]);
    let left = xs.reduce((n, [x]) => n + x, 0) / 2;
    for (const [x, c] of xs) if ((left -= x) <= 0) return c;
    return 0;
};
const keep = (list, x, most) => {
    list.push(x);
    if (list.length > most) list.shift();
};

// backend: { decode(session, { ops, items }, { timeoutMs }) → { out, stride }, release(session) } (gpuClient.js);
// enc: the CPU-side statics of the same encode ({ T, xn, e2d, cross }, for the CPU fallback); head(net, enc, inputs) →
// (out, lane, hist, logits, beat) → logits: the lane head over one decoded beat (default: the GPU's split head, out =
// 8 × lane_hidden bases; tests give their own, with the decoder answers it reads); firstDecodeMs / decodeMs: how long
// a decode round may take (the first may wait for the kernel's compile); policy "auto": batches when they pay (pays()),
// "always": whenever 2 or more builds can step together (tests, measurements; estimate() then gives null).
export function createGpuBatch({
    backend, session, net, enc, inputs, known = null, head = null, onError = null, now = () => performance.now(),
    firstDecodeMs = FIRST_DECODE_MS, decodeMs = DECODE_MS, policy = "auto",
}) {
    const inp = inputs;
    const T = inp.T;
    const hh = net.arch.lane_hidden;
    const laneHead = head ? null : createLaneHead(net);
    const headOf = head ? head(net, enc, inp) : (out, lane, hist, logits) => laneHead(out, lane * hh, hist, logits);
    const stats = { batches: 0, builds: 0, rounds: 0, maxBatch: 0, decodeMs: 0, fallbacks: 0, beats: 0, probes: 0 };
    // pays: this variant's decision (null: not asked yet); probe: { rounds: its one-beat ones, ms } while a probe runs;
    // cpu: a probe found that batches still do not pay, the rest of the variant builds on the CPU; v: its rounds, for K
    // (extra: [extra beats, what one cost in one-beat rounds | null before any, ms] of each round that decoded more)
    const state = { off: false, decoded: false, released: false, pays: null, probe: null, cpu: false, timed: false, v: { rounds: 0, beats: 0, extra: [] } };
    if (!learnt.has(net)) learnt.set(net, { cpu: [], rounds: [], js: [], perRound: [], wait: 0, backoff: 1 });
    const cost = learnt.get(net);
    // One beat of the CPU decoder once its attention windows are full (the first dec_win / cross_win beats attend to
    // fewer keys): the median of 8 beats past them (in a model's first variant on a second pass: the first warms V8
    // up); then one slot's lane head on the CPU decoder and on the GPU path (the history's part after the GPU's first
    // layer), 16 of each. ≈ 50 ms a variant for L.
    const timeCpu = () => {
        if (state.timed) return;
        state.timed = true;
        const rows = new Uint8Array(T * N_LANES);
        const K = Math.min(T, Math.max(net.arch.dec_win, net.arch.cross_win) + 8);
        const times = [];
        const passes = cost.cpu.length ? 1 : 2;
        let dec = null;
        for (let pass = 0; pass < passes; pass += 1) {
            dec = createDecoder(net, enc, inp);
            for (let b = 0; b < K; b += 1) {
                const t = now();
                dec.advance(b ? rows : null, (b - 1) * N_LANES);
                if (pass === passes - 1 && b >= K - 8) times.push(now() - t);
            }
        }
        times.sort((x, y) => x - y);
        const beat = times.length ? times[Math.floor(times.length / 2)] : 0;
        const feats = new Float32Array(HIST_LEN);
        const logits = new Float32Array(16);
        const out = new Float32Array(Math.max(net.arch.dec_d, N_LANES * hh));
        const slot = (fn) => {
            const t = now();
            for (let k = 0; k < 16; k += 1) fn(k % N_LANES);
            return (now() - t) / 16;
        };
        const slotCpu = K > 0 ? slot((lane) => dec.laneLogits(lane, feats, logits)) : 0;
        const slotGpu = K > 0 ? slot((lane) => headOf(out, lane, feats, logits, K - 1)) : 0;
        keep(cost.cpu, { beat, slotCpu, slotGpu }, CPU_PROBES);
    };
    const cpuOf = (key) => (cost.cpu.length ? median(cost.cpu.map((c) => c[key])) : null);
    const roundMs = () => (cost.rounds.length ? trimmed(cost.rounds) : ROUND_PRIOR_MS);
    const perRound = () => (cost.perRound.length ? median(cost.perRound) : ROUND_RATIO);
    // the JS a build runs between two rounds on the batch path (its lane heads, sampling, guard, the generator's own
    // work); before any batch, one slot's lane head on the GPU path for each slot of an average beat
    const jsMs = () => (cost.js.length ? median(cost.js) : (cpuOf("slotGpu") ?? 0) * (inp.beatOf.length / Math.max(1, T)));
    const headMs = () => Math.max(0, (cpuOf("slotCpu") ?? 0) - (cpuOf("slotGpu") ?? 0));
    const paysNow = (round = roundMs()) => round < perRound() * (cpuOf("beat") ?? 0);
    // decided once per variant; off by what was measured (not by the prior), the variant's first rounds probe again
    const pays = () => {
        if (state.pays === null) {
            if (policy !== "always") timeCpu();
            state.pays = policy === "always" || paysNow();
            if (state.pays) {
                // they pay again: a later slow stretch is probed at once, not after an old wait
                cost.wait = 0;
                cost.backoff = 1;
            } else if (cost.rounds.length) {
                if (cost.wait > 0) cost.wait -= 1;
                else {
                    state.probe = { rounds: [], ms: 0 };
                    state.pays = true;
                    stats.probes += 1;
                }
            }
        }
        return state.pays;
    };
    const settleProbe = () => {
        const { rounds } = state.probe;
        state.probe = null;
        state.pays = paysNow(rounds.length ? trimmed(rounds) : roundMs());
        if (state.pays) cost.backoff = 1;
        else {
            state.cpu = true;
            cost.wait = cost.backoff;
            cost.backoff = Math.min(PROBE_WAIT_MAX, 2 * cost.backoff);
        }
    };
    let nextRef = 0;
    const ops = []; // ring copies and frees, sent ahead of the next decode (in order)
    const posOf = (i) => inp.beatOf[i] + inp.laneOf[i] / DIV_CLASSES[inp.div[inp.beatOf[i]]];
    const knownAt = (i) => (known && known[i] !== FREE ? known[i] & 15 : null);

    // A batch of `builds` builds from the song's start that draw the slots in `ranges` ([i0, i1) in slot order, the
    // same for each) → { batchMs, buildMs, rounds, beats, slots }: its time in lockstep, one round per beat a build
    // waits at whatever the batch's size, plus each build's JS; and one such build on the CPU decoder, which decodes
    // every beat up to its last slot and runs the whole lane head, plus the same JS (a little short of a real one: the
    // CPU source's own bookkeeping is left out, ≈ 5 % for M here). null with policy "always".
    function estimate({ builds, ranges }) {
        if (policy === "always") return null;
        let rounds = 0;
        let slots = 0;
        let beats = 0;
        let prev = -1;
        for (const [i0, i1] of ranges) {
            for (let i = i0; i < i1; i += 1) {
                if (knownAt(i) !== null) continue;
                const b = inp.beatOf[i];
                slots += 1;
                if (b !== prev) rounds += 1;
                prev = b;
                beats = b + 1;
            }
        }
        timeCpu();
        const js = jsMs();
        return {
            batchMs: rounds * (roundMs() + builds * js),
            buildMs: beats * (cpuOf("beat") ?? 0) + slots * headMs() + rounds * js,
            rounds, beats, slots,
        };
    }

    // One build's decoder state: rows and history here, its ring on the GPU (or a CPU decoder after a fallback).
    function stream() {
        const ref = ++nextRef;
        const rows = new Uint8Array(T * N_LANES);
        const hist = createHistory();
        const logits = new Float32Array(16);
        const p = new Float64Array(16);
        const h = new Float32Array(HIST_LEN);
        let cur = 0;
        let beat = 0; // beats decoded so far in this build
        let last = null; // the GPU's output for beat − 1
        let cpu = null; // after a fallback: createDecoder over the CPU statics
        let wait = null; // the sample that waits for its beat
        const record = (i, m) => {
            rows[inp.beatOf[i] * N_LANES + inp.laneOf[i]] = m;
            hist.push(m, posOf(i));
        };
        const begin = () => {
            cur = 0;
            beat = 0;
            last = null;
            hist.clear();
            cpu?.reset();
        };
        const pick = ({ i, offset, rngs, weightOf }) => {
            const feats = hist.features(posOf(i), h);
            if (cpu) {
                const b = inp.beatOf[i];
                while (cpu.beat <= b) {
                    const pb = cpu.beat;
                    cpu.advance(pb ? rows : null, (pb - 1) * N_LANES);
                }
                cpu.laneLogits(inp.laneOf[i], feats, logits);
            } else {
                headOf(last, inp.laneOf[i], feats, logits, inp.beatOf[i]);
            }
            const m = pickRow(logits, offset, rngs, weightOf, p);
            record(i, m);
            cur = i + 1;
            return m;
        };
        // the CPU from here on: the decoder replays this build's rows up to the beats decoded on the GPU
        const toCpu = () => {
            if (!cpu) {
                cpu = createDecoder(net, enc, inp);
                for (let b = 0; b < beat; b += 1) cpu.advance(b ? rows : null, (b - 1) * N_LANES);
            }
            const w = wait;
            wait = null;
            return w ? pick(w) : undefined;
        };
        return {
            begin,
            step(i, offset, ctx, rngs, weightOf = null, fixed = undefined) {
                if (i < cur) begin();
                while (cur < i) {
                    record(cur, knownAt(cur) ?? 0);
                    cur += 1;
                }
                const forced = Number.isInteger(fixed) && fixed >= 0 && fixed < 16 ? fixed : knownAt(i);
                if (forced !== null) {
                    record(i, forced);
                    cur = i + 1;
                    return forced;
                }
                const w = { i, offset, rngs, weightOf };
                if (!cpu && beat <= inp.beatOf[i]) {
                    wait = w;
                    return STEP_WAIT;
                }
                return pick(w);
            },
            // the decode this stream waits for: beats beat … b in its ring, with the rows of the beats before each
            request() {
                const b = inp.beatOf[wait.i];
                const n = b - beat + 1;
                const prev = new Uint8Array(n * N_LANES);
                for (let k = 0; k < n; k += 1) if (beat + k > 0) prev.set(rows.subarray((beat + k - 1) * N_LANES, (beat + k) * N_LANES), k * N_LANES);
                return { ref, b0: beat, n, rows: prev };
            },
            resolve(out) {
                last = out;
                beat = inp.beatOf[wait.i] + 1;
                const w = wait;
                wait = null;
                return pick(w);
            },
            toCpu,
            // a GPU snapshot copies the ring into one of its own (none before the first decoded beat: nothing to keep)
            snapshot() {
                if (cpu) return { gpu: false, ref: null, cur, beat, last: null, rows: rows.slice(), hist: hist.snapshot(), dec: cpu.snapshot() };
                const copy = beat > 0 ? ++nextRef : null;
                if (copy !== null) ops.push(["copy", ref, copy]);
                return { gpu: true, ref: copy, cur, beat, last, rows: rows.slice(), hist: hist.snapshot(), dec: null };
            },
            restore(s) {
                cur = s.cur;
                beat = s.beat;
                last = s.last;
                rows.set(s.rows);
                hist.restore(s.hist);
                if (s.gpu && !cpu) {
                    if (s.ref !== null) ops.push(["copy", s.ref, ref]);
                } else if (s.dec) {
                    cpu ??= createDecoder(net, enc, inp);
                    cpu.restore(s.dec);
                } else {
                    cpu = null;
                    toCpu();
                }
            },
            close() { ops.push(["free", ref]); },
        };
    }

    // one round: the waiting streams' beats in one request
    async function decodeRound(list) {
        const items = list.map((e) => e.s.request());
        const t0 = now();
        const got = await backend.decode(session, { ops: ops.splice(0), items }, { timeoutMs: state.decoded ? decodeMs : firstDecodeMs });
        const ms = now() - t0;
        stats.decodeMs += ms;
        stats.rounds += 1;
        const stride = got?.stride;
        if (!(stride > 0 && got.out?.length === items.length * stride && (head || stride === N_LANES * hh))) {
            throw new Error("nn-v2 GPU: the decoder answered with the wrong shapes");
        }
        let beats = 0;
        for (const it of items) beats += it.n;
        stats.beats += beats;
        // The round's cost from one-beat rounds only: a snapshot's or a fixed start's round decodes many beats at once
        // (it counts for K instead). Never the session's first round, which may include the kernel's compile.
        if (state.decoded) {
            const one = beats === items.length;
            if (one) keep(cost.rounds, ms, ROUND_WINDOW);
            else {
                // an extra beat's cost against the round as it is now, so a GPU slow for a while prices it against
                // its own slow rounds
                const x = beats - items.length;
                state.v.extra.push([x, cost.rounds.length ? (ms / roundMs() - 1) / x : null, ms]);
            }
            state.v.rounds += 1;
            state.v.beats += beats;
            if (state.probe) {
                state.probe.ms += ms;
                if (one) state.probe.rounds.push(ms);
            }
        }
        state.decoded = true;
        return items.map((_, k) => got.out.subarray(k * stride, (k + 1) * stride));
    }

    // a request nobody waits for (posted now, so it keeps its place before the next one; a failure is the GPU's loss)
    const send = (fn) => {
        try {
            Promise.resolve(fn()).catch(() => {});
        } catch {
            // no link any more
        }
    };
    // frees and copies nobody waits for (end of a batch, a dropped snapshot)
    function flush() {
        if (!ops.length || state.released) return;
        const body = { ops: ops.splice(0), items: [] };
        send(() => backend.decode(session, body, { timeoutMs: decodeMs }));
    }

    // makers[k](stream) → generator; → the generators' return values (undefined where afterFailure gave one up).
    // afterFailure, once the GPU failed (or a probe found that batches still do not pay): "finish" (every build, on the
    // CPU), "abandon" (none), or (done) → whether to finish the next unfinished build (in order), given how many are done.
    async function run(makers, { afterFailure = "finish", signal = null, wrap = (s) => s } = {}) {
        stats.batches += 1;
        stats.builds += makers.length;
        stats.maxBatch = Math.max(stats.maxBatch, makers.length);
        const entries = makers.map((make) => {
            const s = stream();
            return { s, gen: make(wrap(s)), done: false, value: undefined };
        });
        const go = (e, value) => {
            const r = e.gen.next(value);
            if (r.done) {
                e.done = true;
                e.value = r.value;
            }
        };
        const onCpu = () => {
            let done = entries.filter((e) => e.done).length;
            for (const e of entries) {
                if (e.done) continue;
                const keep = afterFailure === "finish" || (typeof afterFailure === "function" && afterFailure(done));
                if (!keep) break;
                go(e, e.s.toCpu());
                if (!e.done) throw new Error("nn-v2: a build on the CPU decoder waited for the GPU");
                done += 1;
            }
        };
        try {
            for (const e of entries) go(e);
            let waiting = entries.filter((e) => !e.done);
            while (waiting.length) {
                if (signal?.aborted) throw abortError(signal);
                if (state.probe && (state.probe.rounds.length >= PROBE_ROUNDS || state.probe.ms >= PROBE_MS)) settleProbe();
                if (state.off || state.cpu) {
                    onCpu();
                    break;
                }
                let outs;
                try {
                    outs = await decodeRound(waiting);
                } catch (error) {
                    state.off = true;
                    stats.fallbacks += 1;
                    onError?.(error);
                    if (signal?.aborted) throw abortError(signal);
                    onCpu();
                    break;
                }
                if (signal?.aborted) throw abortError(signal);
                const t = now();
                waiting.forEach((e, k) => go(e, e.s.resolve(outs[k])));
                keep(cost.js, (now() - t) / waiting.length, ROUND_WINDOW);
                waiting = waiting.filter((e) => !e.done);
            }
            return entries.map((e) => e.value);
        } finally {
            for (const e of entries) {
                if (!e.done) e.gen.return?.();
                e.s.close();
            }
            flush();
        }
    }

    function view(wrap) {
        return {
            get off() { return state.off; },
            pays,
            estimate,
            // what is learnt for this model (roundMs: a one-beat round, perRound: K, jsMs: a build's JS a round, headMs:
            // the CPU's lane head over the GPU path's, per slot), and whether this variant probes
            costs: () => ({
                roundMs: roundMs(), cpuBeatMs: cpuOf("beat"), perRound: perRound(), jsMs: jsMs(), headMs: headMs(),
                probing: state.probe !== null,
            }),
            stats,
            run: (makers, opts = {}) => run(makers, { ...opts, wrap }),
            // one stream through maker (a snapshot is its return value, holding a ring on the GPU); null when the GPU
            // failed on the way, or a probe sent the variant to the CPU (then the caller builds on the CPU)
            async snapshot(maker) {
                if (state.off || state.cpu) return null;
                const [snap] = await run([maker], { afterFailure: "abandon", wrap });
                return state.off || state.cpu ? null : snap ?? null;
            },
            drop(snap) {
                if (snap?.ref !== null && snap?.ref !== undefined) ops.push(["free", snap.ref]);
                flush();
            },
            release() {
                if (state.released) return;
                // a variant that batched to its end teaches K: its build-beats over its decode time in one-beat rounds
                const v = state.v;
                if (state.pays && !state.off && !state.cpu && !state.probe && v.rounds >= MIN_VARIANT_ROUNDS && cost.rounds.length) {
                    const extra = v.extra.reduce((n, [x]) => n + x, 0);
                    keep(cost.perRound, v.beats / (v.rounds + extraBeat(v.extra, roundMs()) * extra), KEPT_VARIANTS);
                }
                state.off = true;
                state.released = true;
                ops.length = 0;
                send(() => backend.release?.(session));
            },
            withStreams: (w) => view((s) => w(wrap(s))),
        };
    }
    return view((s) => s);
}
