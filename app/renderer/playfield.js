// Playfield preview of the create tab (mapgen v3): 4 lanes × 40 px, 300 px high, the chosen variant's notes falling
// to the judge line in the snap palette over the beat grid (only the grid before anything is generated).
// Controls: play / pause, the scroll speed (10–40, 24 by default), the volume (0–100 %) and hit clicks, all remembered
// in localStorage.
// ←/→ on the focused playfield seek 2 s, the wheel one beat; another tab or a hidden window pauses the player.
import { t } from "../../src/i18n/i18n.js";
import { snapOf, gridLines, SNAP_COLORS, prepareCanvas, sectionsOf, sectionIndexAt } from "./snapColors.js";

export { snapOf };
export const LANES = 4;
export const LANE_PX = 40;
export const HEIGHT = 300;
export const JUDGE_Y = HEIGHT - 30;
const NOTE_PX = 10;
const SEEK_MS = 2000;
const SPEED = { min: 10, max: 40, initial: 24 };
const SPEED_KEY = "create-play-speed";
const CLICKS_KEY = "create-play-clicks";
const VOLUME_KEY = "create-play-volume";

// How long a note takes from the top to the judge line at a scroll speed.
export const visibleSpanMs = (speed) => 11485 / speed;

// [i0, i1): the rows (sorted by t) with fromMs ≤ t ≤ toMs.
export function visibleRange(rows, fromMs, toMs) {
    const first = (x, strict) => {
        let lo = 0;
        let hi = rows.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (strict ? rows[mid].t <= x : rows[mid].t < x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const i0 = first(fromMs, false);
    return [i0, Math.max(i0, first(toMs, true))];
}

// The y of a note at time t when the song is at now: on the judge line at t = now, at the top a span later.
export const noteY = (t, now, spanMs, judgeY) => judgeY - ((t - now) / spanMs) * judgeY;

function readStored(key, fallback) {
    try {
        return globalThis.localStorage?.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

function store(key, value) {
    try {
        globalThis.localStorage?.setItem(key, value);
    } catch {
        // not remembered, still applied
    }
}

// The next (dir 1) or previous (dir −1) beat line from ms.
function beatStep(timing, ms, dir) {
    const sections = sectionsOf(timing);
    const beatMs = 60000 / sections[sectionIndexAt(sections, ms)].bpm;
    const lines = dir > 0 ? gridLines(timing, ms + 1, ms + beatMs * 2 + 1, 1) : gridLines(timing, ms - beatMs * 2 - 1, ms - 1 + 1e-6, 1);
    const line = dir > 0 ? lines[0] : lines.at(-1);
    return line ? Math.round(line.t) : ms + dir * beatMs;
}

// player: the create tab's audio player; getTiming() → the current Timing.
export function createPlayfield({ canvas, controls, player, getTiming }) {
    let rows = null;
    const stored = Number(readStored(SPEED_KEY, SPEED.initial));
    let speed = Number.isFinite(stored) && stored >= SPEED.min && stored <= SPEED.max ? stored : SPEED.initial;
    let clicks = readStored(CLICKS_KEY, "0") === "1";
    const storedVolume = Number(readStored(VOLUME_KEY, 100));
    let volume = Number.isFinite(storedVolume) && storedVolume >= 0 && storedVolume <= 100 ? Math.round(storedVolume) : 100;
    player.setVolume?.(volume / 100);

    const el = (tag, className = "", text = "") => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    };
    const play = el("button", "small cr-play");
    play.addEventListener("click", () => player.toggle());
    const time = el("span", "muted cr-time");
    const speedRow = el("label", "slider-row cr-speed");
    const speedInput = el("input");
    speedInput.type = "range";
    speedInput.min = String(SPEED.min);
    speedInput.max = String(SPEED.max);
    speedInput.step = "1";
    speedInput.value = String(speed);
    const speedValue = el("span", "muted", String(speed));
    speedInput.addEventListener("input", () => {
        speed = Number(speedInput.value) || SPEED.initial;
        speedValue.textContent = String(speed);
        store(SPEED_KEY, String(speed));
        draw();
    });
    speedRow.append(el("span", "", t("create.play.speed")), speedInput, speedValue);
    const volumeRow = el("label", "slider-row cr-volume");
    const volumeInput = el("input");
    volumeInput.type = "range";
    volumeInput.min = "0";
    volumeInput.max = "100";
    volumeInput.step = "1";
    volumeInput.value = String(volume);
    const volumeValue = el("span", "muted", `${volume}%`);
    volumeInput.addEventListener("input", () => {
        volume = Math.round(Number(volumeInput.value));
        if (!Number.isFinite(volume)) volume = 100;
        volumeValue.textContent = `${volume}%`;
        store(VOLUME_KEY, String(volume));
        player.setVolume?.(volume / 100);
    });
    volumeRow.append(el("span", "", t("create.play.volume")), volumeInput, volumeValue);
    const clickRow = el("label", "check");
    const clickBox = el("input");
    clickBox.type = "checkbox";
    clickBox.checked = clicks;
    clickBox.addEventListener("change", () => {
        clicks = Boolean(clickBox.checked);
        store(CLICKS_KEY, clicks ? "1" : "0");
        applyClicks();
    });
    clickRow.append(clickBox, el("i", "", t("create.play.clicks")));
    const gridNote = el("div", "muted", t("create.play.gridOnly"));
    const keys = el("div", "muted", t("create.play.keys"));
    const top = el("div", "row");
    top.append(play, time);
    controls.replaceChildren(top, speedRow, volumeRow, clickRow, gridNote, keys);

    const applyClicks = () => player.setHitClicks(clicks && rows ? rows.map((r) => r.t) : null);
    const showPlaying = () => { play.textContent = player.playing ? t("create.play.pause") : t("create.play.play"); };

    function draw(now = player.now()) {
        const { ctx } = prepareCanvas(canvas, LANES * LANE_PX, HEIGHT);
        const ms = Math.max(0, now);
        time.textContent = `${Math.floor(ms / 60000)}:${(Math.floor(ms / 100) / 10 % 60).toFixed(1).padStart(4, "0")}`;
        if (!ctx) return;
        const width = LANES * LANE_PX;
        ctx.fillStyle = "#14121c";
        ctx.fillRect(0, 0, width, HEIGHT);
        ctx.fillStyle = "#2c2840";
        for (let c = 1; c < LANES; c += 1) ctx.fillRect(c * LANE_PX, 0, 1, HEIGHT);
        const span = visibleSpanMs(speed);
        const from = now - (span * (HEIGHT - JUDGE_Y)) / JUDGE_Y;
        const to = now + span;
        const timing = getTiming();
        for (const line of gridLines(timing, from, to, 4)) {
            const y = Math.round(noteY(line.t, now, span, JUDGE_Y));
            ctx.globalAlpha = line.div === 1 ? 0.8 : 0.35;
            ctx.fillStyle = SNAP_COLORS[line.div] ?? SNAP_COLORS[0];
            ctx.fillRect(0, y, width, line.bar ? 2 : 1);
        }
        ctx.globalAlpha = 1;
        if (rows) {
            const [i0, i1] = visibleRange(rows, from - NOTE_PX * 4, to);
            for (let i = i0; i < i1; i += 1) {
                const row = rows[i];
                const y = noteY(row.t, now, span, JUDGE_Y);
                ctx.fillStyle = snapOf(row.t, timing).color;
                for (let c = 0; c < LANES; c += 1) if (row.mask & (1 << c)) ctx.fillRect(c * LANE_PX + 2, Math.round(y - NOTE_PX / 2), LANE_PX - 4, NOTE_PX);
            }
        }
        ctx.fillStyle = "#eeeeee";
        ctx.fillRect(0, JUDGE_Y, width, 2);
    }

    canvas.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault?.();
        player.seek(player.now() + (e.key === "ArrowLeft" ? -SEEK_MS : SEEK_MS));
        draw();
    });
    canvas.addEventListener("wheel", (e) => {
        e.preventDefault?.();
        player.seek(beatStep(getTiming(), Math.round(player.now()), e.deltaY > 0 ? 1 : -1));
        draw();
    }, { passive: false });
    player.subscribe(() => { showPlaying(); draw(); });
    window.addEventListener("tab-shown", (e) => { if (e.detail !== "create") player.pause(); });
    document.addEventListener?.("visibilitychange", () => { if (document.hidden) player.pause(); });
    showPlaying();
    draw();

    return {
        // the chosen variant's rows [{ t, mask }] sorted by t, or null for only the beat grid
        setRows(next) {
            rows = next && next.length ? next : null;
            gridNote.hidden = Boolean(rows);
            if (rows) gridNote.textContent = "";
            else gridNote.textContent = t("create.play.gridOnly");
            applyClicks();
            draw();
        },
        frame: draw,
        redraw: () => draw(),
        get speed() { return speed; },
        get volume() { return volume; },
        get rows() { return rows; },
    };
}
