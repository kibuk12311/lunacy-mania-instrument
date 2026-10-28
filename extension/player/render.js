// Canvas 2D playfield of the demo player: 4 lanes (outer gold, inner blue, as on the app icon), notes, hold bodies,
// judge line, key glow, judgement text, combo, accuracy, progress; downscroll or upscroll.

export const COLORS = Object.freeze({
    bg: "#14121c", panel: "#1c1928", line: "#2c2840", text: "#eeeeee", muted: "#8a8698",
    gold: "#f5c66b", blue: "#8fd3ff", grey: "#55516a",
});
export const JUDGEMENT_TEXT = Object.freeze({ max: "MAX", n300: "300", n200: "200", n100: "100", n50: "50", miss: "MISS" });
const JUDGEMENT_COLOR = Object.freeze({
    max: "#ffffff", n300: COLORS.gold, n200: "#8be28b", n100: COLORS.blue, n50: COLORS.muted, miss: "#ff6b6b",
});
const FLASH_MS = 450;

// How long a note takes from the top to the judge line at a scroll speed, in real ms (as app/renderer/playfield.js).
export const visibleSpanMs = (speed) => 11485 / speed;
export const laneColor = (col, keys = 4) => (col === 0 || col === keys - 1 ? COLORS.gold : COLORS.blue);

// Lane geometry in CSS pixels.
export function layout(width, height, { downscroll = true, keys = 4 } = {}) {
    const laneW = Math.round(Math.min(100, Math.max(48, width * 0.085)));
    const fieldW = laneW * keys;
    const left = Math.round((width - fieldW) / 2);
    const keyBox = Math.round(Math.max(36, Math.min(70, height * 0.09)));
    // The canvas starts below the player's top bar (player.css --bar-h), so its top edge is where the notes come in;
    // `topBar` is only the room kept there for the progress line (upscroll's key boxes and the HUD sit below it).
    const topBar = 8;
    const hitY = downscroll ? height - keyBox - 6 : topBar + keyBox + 2;
    const travel = downscroll ? hitY : height - hitY; // judge line → far edge
    return { width, height, laneW, fieldW, left, hitY, travel, keyBox, topBar, downscroll, noteH: Math.max(10, Math.round(laneW * 0.3)) };
}

// y (CSS px) of chart time t at chart time `now`; `spanChart` = chart ms from the far edge to the judge line.
export function noteY(t, now, { hitY, travel, downscroll }, spanChart) {
    const d = ((t - now) / spanChart) * travel;
    return downscroll ? hitY - d : hitY + d;
}

export function createRenderer(canvas, { win = globalThis.window } = {}) {
    const g = canvas.getContext("2d");
    let cursor = 0;
    let cssW = 0;
    let cssH = 0;

    function fit() {
        const dpr = Math.max(1, Math.min(3, Number(win?.devicePixelRatio) || 1));
        const w = Math.max(1, Math.round(canvas.clientWidth || win?.innerWidth || 800));
        const h = Math.max(1, Math.round(canvas.clientHeight || win?.innerHeight || 600));
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        cssW = w;
        cssH = h;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function roundRect(x, y, w, h, r) {
        g.beginPath();
        if (typeof g.roundRect === "function") g.roundRect(x, y, w, h, r);
        else g.rect(x, y, w, h);
        g.fill();
    }

    function drawField(L, keys, held, labels) {
        g.fillStyle = COLORS.bg;
        g.fillRect(0, 0, cssW, cssH);
        g.fillStyle = "rgba(28,25,40,0.92)";
        g.fillRect(L.left, 0, L.fieldW, cssH);
        g.fillStyle = COLORS.line;
        for (let c = 0; c <= keys; c += 1) g.fillRect(L.left + c * L.laneW - (c === 0 || c === keys ? 1 : 0.5), 0, c === 0 || c === keys ? 2 : 1, cssH);
        for (let c = 0; c < keys; c += 1) {
            const x = L.left + c * L.laneW;
            if (held[c]) {
                const reach = cssH * 0.38;
                const y0 = L.downscroll ? L.hitY - reach : L.hitY;
                const grad = g.createLinearGradient(0, L.downscroll ? L.hitY : L.hitY + reach, 0, L.downscroll ? L.hitY - reach : L.hitY);
                const color = laneColor(c, keys);
                grad.addColorStop(0, hexAlpha(color, 0.38));
                grad.addColorStop(1, hexAlpha(color, 0));
                g.fillStyle = grad;
                g.fillRect(x + 1, y0, L.laneW - 2, reach);
            }
            // key boxes beyond the judge line
            const ky = L.downscroll ? L.hitY + 4 : L.hitY - L.keyBox;
            g.fillStyle = held[c] ? hexAlpha(laneColor(c, keys), 0.85) : COLORS.panel;
            roundRect(x + 4, ky, L.laneW - 8, L.keyBox - 4, 6);
            g.fillStyle = held[c] ? COLORS.bg : COLORS.muted;
            g.font = `600 ${Math.round(L.keyBox * 0.32)}px system-ui, sans-serif`;
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(labels?.[c] ?? "", x + L.laneW / 2, ky + (L.keyBox - 4) / 2);
        }
        g.fillStyle = COLORS.text;
        g.fillRect(L.left, L.hitY - 1, L.fieldW, 2);
    }

    function drawNotes(L, frame, spanChart) {
        const { notes, head, tail, broken, holding } = frame.judge;
        const now = frame.now;
        const behind = now - spanChart * 0.5;
        const ahead = now + spanChart * 1.05;
        while (cursor < notes.length && (notes[cursor].end ?? notes[cursor].t) < behind) cursor += 1;
        const nh = L.noteH;
        for (let i = cursor; i < notes.length; i += 1) {
            const n = notes[i];
            if (n.t > ahead) break;
            // The cursor stops at a long hold still in view; skip the notes after it that are already gone.
            if ((n.end ?? n.t) < behind) continue;
            const x = L.left + n.col * L.laneW + 3;
            const w = L.laneW - 6;
            const color = laneColor(n.col, frame.keys);
            if (n.end === null) {
                if (head[i] && head[i] !== "miss") continue;
                const y = noteY(n.t, now, L, spanChart);
                g.fillStyle = head[i] === "miss" ? hexAlpha(COLORS.grey, 0.6) : color;
                roundRect(x, y - nh / 2, w, nh, 4);
                continue;
            }
            if (tail[i] && !broken[i]) continue; // finished hold
            const held = holding[n.col] === i;
            let yHead = noteY(n.t, now, L, spanChart);
            const yTail = noteY(n.end, now, L, spanChart);
            if (held) yHead = L.hitY;
            const top = Math.min(yHead, yTail);
            const bottom = Math.max(yHead, yTail);
            const dead = broken[i];
            g.fillStyle = dead ? hexAlpha(COLORS.grey, 0.45) : hexAlpha(color, held ? 0.6 : 0.42);
            g.fillRect(x + w * 0.12, top, w * 0.76, bottom - top);
            g.fillStyle = dead ? hexAlpha(COLORS.grey, 0.7) : color;
            roundRect(x, yTail - nh / 4, w, nh / 2, 3); // tail cap
            if (!held) roundRect(x, yHead - nh / 2, w, nh, 4);
        }
    }

    function drawHud(L, frame) {
        const mid = L.left + L.fieldW / 2;
        g.textAlign = "center";
        g.textBaseline = "middle";
        // progress
        const p = Math.min(1, Math.max(0, frame.progress ?? 0));
        g.fillStyle = COLORS.line;
        g.fillRect(0, 0, cssW, 4);
        g.fillStyle = COLORS.gold;
        g.fillRect(0, 0, cssW * p, 4);
        // combo + judgement
        const comboY = L.downscroll ? cssH * 0.36 : cssH * 0.64;
        if (frame.combo > 0) {
            g.fillStyle = COLORS.text;
            g.font = `700 ${Math.round(L.laneW * 0.55)}px system-ui, sans-serif`;
            g.fillText(String(frame.combo), mid, comboY);
        }
        const flash = frame.flash;
        if (flash && frame.perfNow - flash.at < FLASH_MS) {
            const k = 1 - (frame.perfNow - flash.at) / FLASH_MS;
            g.globalAlpha = Math.max(0, Math.min(1, k * 1.4));
            g.fillStyle = JUDGEMENT_COLOR[flash.judgement] ?? COLORS.text;
            g.font = `800 ${Math.round(L.laneW * (0.42 + 0.06 * k))}px system-ui, sans-serif`;
            g.fillText(JUDGEMENT_TEXT[flash.judgement] ?? "", mid, comboY + (L.downscroll ? 1 : -1) * L.laneW * 0.75);
            g.globalAlpha = 1;
        }
        // accuracy and the small lines on the right
        g.textAlign = "left";
        g.textBaseline = "top";
        const rx = L.left + L.fieldW + 18;
        g.fillStyle = COLORS.text;
        g.font = "700 26px system-ui, sans-serif";
        const hudTop = L.topBar + 8; // below the progress line
        g.fillText(frame.acc === null || frame.acc === undefined ? "—" : `${frame.acc.toFixed(2)}%`, rx, hudTop);
        g.font = "500 14px system-ui, sans-serif";
        g.fillStyle = COLORS.muted;
        let y = hudTop + 34;
        for (const line of frame.sideLines ?? []) {
            g.fillText(line, rx, y);
            y += 20;
        }
        if (frame.toast && frame.perfNow - frame.toast.at < 1200) {
            g.textAlign = "center";
            g.fillStyle = COLORS.gold;
            g.font = "600 16px system-ui, sans-serif";
            g.fillText(frame.toast.text, mid, L.downscroll ? L.topBar + 8 : cssH - 36);
        }
        if (frame.banner) {
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillStyle = COLORS.text;
            g.font = "700 30px system-ui, sans-serif";
            g.fillText(frame.banner, mid, cssH * 0.5);
        }
    }

    return {
        reset() { cursor = 0; },
        // frame: { now, rate, speed, downscroll, keys, judge, held[], labels[], combo, acc, progress, flash, toast,
        //          banner, sideLines[], perfNow }
        draw(frame) {
            fit();
            const keys = frame.keys ?? 4;
            const L = layout(cssW, cssH, { downscroll: frame.downscroll, keys });
            const spanChart = visibleSpanMs(frame.speed) * (frame.rate || 1);
            drawField(L, keys, frame.held ?? [], frame.labels);
            if (frame.judge) drawNotes(L, frame, spanChart);
            drawHud(L, frame);
        },
        clear() {
            fit();
            g.fillStyle = COLORS.bg;
            g.fillRect(0, 0, cssW, cssH);
        },
    };
}

export function hexAlpha(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}
