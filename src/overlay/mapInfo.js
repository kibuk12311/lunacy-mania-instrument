// The map panel's data, kept pure so it can be tested: the map osu! (through tosu) or Interlude has selected or is
// playing, as the frames say it, and what the panel's window gets. tosu's numbers: beatmap.stats.bpm.* come with the
// mods' rate in them already; stars.total is the map's with the mods; time.* are map ms, so the length in real time is
// the span between the first and the last object over the rate. Interlude's bpm and lengthMs are at rate 1.0; its
// rating is a scale of its own, so it is not shown as stars.
const text = (x) => (typeof x === "string" ? x.trim() : "");
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const positive = (x) => (num(x) !== null && x > 0 ? x : null);

function bpmOf(bpm) {
    const common = positive(bpm?.common) ?? positive(bpm?.realtime);
    if (common === null) return null;
    return { common, min: positive(bpm?.min) ?? common, max: positive(bpm?.max) ?? common };
}

// A /websocket/v2 frame → the map, or null while tosu names none. mode, rate, mods: read from the frame already.
// picture: what names its background (one picture for every difficulty of a set that shares it), null without one.
export function readTosuMap(json, { mode = null, rate = 1, mods = [] } = {}) {
    const b = json?.beatmap;
    const checksum = text(b?.checksum);
    const title = text(b?.title);
    if (!checksum && !title) return null;
    const background = text(json?.files?.background);
    return {
        checksum: checksum || null,
        mode,
        title,
        artist: text(b.artist),
        difficulty: text(b.version),
        mapper: text(b.mapper),
        mods,
        rate: rate > 0 ? rate : 1,
        bpm: bpmOf(b.stats?.bpm),
        firstMs: num(b.time?.firstObject) ?? 0,
        lastMs: num(b.time?.lastObject),
        stars: positive(b.stats?.stars?.total),
        picture: background ? `${text(json?.folders?.beatmap)}/${background}` : null,
    };
}

// An Interlude state line → the map, or null while nothing is selected
export function readInterludeMap(msg) {
    const chart = msg?.chart && typeof msg.chart === "object" ? msg.chart : null;
    const hash = text(chart?.hash);
    if (!hash) return null;
    const rate = positive(msg.play?.rate) ?? positive(chart.rate) ?? 1;
    const bpm = positive(chart.bpm);
    return {
        checksum: `interlude:${hash}`,
        mode: 3,
        title: text(chart.title),
        artist: text(chart.artist),
        difficulty: text(chart.diff),
        mapper: text(chart.creator),
        mods: (Array.isArray(chart.mods) ? chart.mods : []).map((m) => text(m?.id).toUpperCase()).filter(Boolean),
        rate,
        bpm: bpm === null ? null : { common: bpm * rate, min: bpm * rate, max: bpm * rate },
        firstMs: 0, // Interlude's clock is 0 at the first note
        // first to last note at rate 1.0, the same in song select as in a play, so the length does not jump
        lastMs: positive(chart.lengthMs) ?? positive(msg.play?.durationMs),
        stars: null,
        picture: hash,
    };
}

// What the panel's window gets for a map: { phase, map, progress (0..1), elapsedMs (real time into the play, whole
// seconds, null outside a play) }. phase: the session's; liveMs: map ms of the play; dan: { state, numeric }.
export function mapState(info, { phase = "idle", liveMs = null, dan = null } = {}) {
    if (!info) return { phase, map: null, progress: 0, elapsedMs: null };
    const span = info.lastMs > info.firstMs ? info.lastMs - info.firstMs : null;
    const rate = info.rate > 0 ? info.rate : 1;
    const done = span !== null && num(liveMs) !== null ? Math.min(1, Math.max(0, (liveMs - info.firstMs) / span)) : 0;
    const playing = phase === "playing" && span !== null;
    return {
        phase,
        map: {
            title: info.title, artist: info.artist, difficulty: info.difficulty, mapper: info.mapper, mods: info.mods,
            rate, bpm: info.bpm, stars: info.stars, lengthMs: span === null ? null : Math.round(span / rate), dan,
        },
        // the results screen: the whole map; song select: nothing yet (tosu's clock there is the music's preview)
        progress: phase === "results" ? 1 : playing ? Math.round(done * 1000) / 1000 : 0,
        elapsedMs: playing ? Math.floor((done * span) / rate / 1000) * 1000 : null,
    };
}

// 192000 → "3:12", an hour and over "1:02:33"; "" without a length
export function formatLength(ms) {
    if (num(ms) === null || ms < 0) return "";
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, "0");
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// "222", a map with several: "180–222"; "" without one
export function formatBpm(bpm) {
    if (!bpm) return "";
    const low = Math.round(bpm.min);
    const high = Math.round(bpm.max);
    return low === high ? String(Math.round(bpm.common)) : `${low}–${high}`;
}

// "1.25×"; "" at 1×
export const formatRate = (rate) => (num(rate) === null || Math.abs(rate - 1) < 0.005 ? "" : `${Number(rate.toFixed(2))}×`);

export const formatStars = (stars) => (num(stars) === null ? "" : `★ ${stars.toFixed(2)}`);
