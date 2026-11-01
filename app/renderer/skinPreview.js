// The Skin tab's live playfield: osu!'s 640 × 480 (4:3) stage drawn from the skin's own images and [Mania] 4K
// values — columns at ColumnStart with their widths, spacing and lines, keys at the bottom (pressed by an autoplay),
// notes and holds falling to HitPosition, column light at LightPosition, hit lighting and the judgement at
// ScorePosition — on the built-in loop of src/skin/previewPattern.js. Downscroll or upscroll, scroll speed 10–40.
// An image the skin does not have is drawn as a plain shape. Sizes follow osu!: column-wide pictures keep their
// aspect, everything else is drawn at its size on a 768 px high screen.
import { t } from "../../src/i18n/i18n.js";
import { PATTERN, autoplayAt } from "../../src/skin/previewPattern.js";
import { createStagePainter, STAGE_W as W, STAGE_H as H, columnLefts, spanMs } from "./skinStage.js";

export { columnLefts, spanMs };

const SPEED = { min: 10, max: 40, initial: 22 };
const SPEED_KEY = "skin-preview-speed";
const UP_KEY = "skin-preview-up";

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
        // not remembered
    }
}

export function createSkinPreview({ canvas, controls }) {
    let cfg = null;
    let images = {}; // value of skin.ini → { img, hd } | null
    let playing = true;
    let up = readStored(UP_KEY, "0") === "1";
    const stored = Number(readStored(SPEED_KEY, SPEED.initial));
    let speed = Number.isFinite(stored) && stored >= SPEED.min && stored <= SPEED.max ? stored : SPEED.initial;
    let clock = 0;
    let last = null;
    let frame = null;
    let visible = false;
    const painter = createStagePainter();

    const el = (tag, className = "", text = "") => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    };
    const play = el("button", "small");
    play.addEventListener("click", () => { playing = !playing; showButtons(); tick(); });
    const dir = el("button", "small");
    dir.addEventListener("click", () => { up = !up; store(UP_KEY, up ? "1" : "0"); showButtons(); draw(); });
    const speedRow = el("label", "slider-row sk-speed");
    const speedInput = el("input");
    Object.assign(speedInput, { type: "range", min: String(SPEED.min), max: String(SPEED.max), step: "1", value: String(speed) });
    const speedValue = el("span", "muted", String(speed));
    speedInput.addEventListener("input", () => {
        speed = Number(speedInput.value) || SPEED.initial;
        speedValue.textContent = String(speed);
        store(SPEED_KEY, String(speed));
        draw();
    });
    speedRow.append(el("span", "", t("skin.preview.speed")), speedInput, speedValue);
    const top = el("div", "row");
    top.append(play, dir);
    controls.replaceChildren(top, speedRow);
    const showButtons = () => {
        play.textContent = playing ? t("skin.preview.pause") : t("skin.preview.play");
        dir.textContent = up ? t("skin.preview.upscroll") : t("skin.preview.downscroll");
        dir.title = t("skin.preview.directionTitle");
    };
    showButtons();

    function draw() {
        const ctx = canvas.getContext?.("2d");
        if (!ctx) return;
        const cssW = canvas.clientWidth || 440;
        const cssH = Math.round((cssW * H) / W);
        const ratio = globalThis.devicePixelRatio || 1;
        if (canvas.width !== Math.round(cssW * ratio) || canvas.height !== Math.round(cssH * ratio)) {
            canvas.width = Math.round(cssW * ratio);
            canvas.height = Math.round(cssH * ratio);
            canvas.style.height = `${cssH}px`;
        }
        ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
        ctx.fillStyle = "#08070c";
        ctx.fillRect(0, 0, W, H);
        if (!cfg) {
            ctx.fillStyle = "#8a8698";
            ctx.font = "16px Segoe UI, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(t("skin.preview.empty"), W / 2, H / 2);
            return;
        }
        const now = clock % PATTERN.length;
        painter.paint(ctx, { cfg, images, up: up || Boolean(cfg.upsideDown), speed, now, notes: PATTERN.notes, shifts: [0, PATTERN.length], keys: autoplayAt(now) });
    }

    function tick() {
        if (frame !== null) return;
        if (!visible || !playing) {
            last = null;
            draw();
            return;
        }
        frame = globalThis.requestAnimationFrame?.((ms) => {
            frame = null;
            if (last !== null) clock += Math.min(100, ms - last);
            last = ms;
            draw();
            tick();
        }) ?? null;
    }

    return {
        // cfg: maniaConfig of the 4K section; pictures: value → { img, hd } | null
        setSkin(nextCfg, pictures) {
            cfg = nextCfg;
            images = pictures ?? {};
            draw();
        },
        setVisible(on) {
            visible = Boolean(on);
            if (!visible && frame !== null) {
                globalThis.cancelAnimationFrame?.(frame);
                frame = null;
            }
            tick();
        },
        // a fixed moment of the loop (the smoke's screenshots)
        seek(ms) {
            clock = ms;
            draw();
        },
        redraw: () => draw(),
        get up() { return up; },
        get speed() { return speed; },
        get playing() { return playing; },
    };
}
