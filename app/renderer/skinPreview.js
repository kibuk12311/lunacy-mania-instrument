// The Skin tab's live playfield: osu!'s 640 × 480 (4:3) stage drawn from the skin's own images and [Mania] 4K
// values — columns at ColumnStart with their widths, spacing and lines, keys at the bottom (pressed by an autoplay),
// notes and holds falling to HitPosition, column light at LightPosition, hit lighting and the judgement at
// ScorePosition — on the built-in loop of src/skin/previewPattern.js. Downscroll or upscroll, scroll speed 10–40.
// An image the skin does not have is drawn as a plain shape. Sizes follow osu!: column-wide pictures keep their
// aspect, everything else is drawn at its size on a 768 px high screen.
import { t } from "../../src/i18n/i18n.js";
import { PATTERN, autoplayAt } from "../../src/skin/previewPattern.js";
import { KEYS } from "../../src/skin/maniaFields.js";

const H = 480;
const W = 640;
const NATIVE = 480 / 768;
const SPEED = { min: 10, max: 40, initial: 22 };
const SPEED_KEY = "skin-preview-speed";
const UP_KEY = "skin-preview-up";
export const spanMs = (speed) => 11485 / speed;

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

// The left edge of each column in stage units.
export function columnLefts(cfg) {
    const out = [];
    let x = cfg.columnStart;
    for (let c = 0; c < KEYS; c += 1) {
        out.push(x);
        x += cfg.columnWidth[c] + (c < KEYS - 1 ? cfg.columnSpacing[c] : 0);
    }
    return out;
}

const rgba = (c, k = 1) => `rgba(${c[0]},${c[1]},${c[2]},${((c[3] ?? 255) / 255) * k})`;

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
    const tints = new Map();

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

    // the picture for a value of skin.ini, its fallback's when it has none
    const pic = (key) => {
        let k = key;
        for (let i = 0; i < 3 && k; i += 1) {
            const got = images[cfg.images[k]];
            if (got?.img) return got;
            k = cfg.fallback?.[k];
        }
        return null;
    };
    const px = (p) => (p.hd ? 0.5 : 1);

    // a white picture in a colour (column light): multiplied, its own alpha kept
    function tinted(p, colour) {
        const id = `${p.img.src.length}:${p.img.src.slice(-24)}:${colour.join(",")}`;
        if (tints.has(id)) return tints.get(id);
        const c = document.createElement("canvas");
        c.width = p.img.naturalWidth || 1;
        c.height = p.img.naturalHeight || 1;
        const g = c.getContext("2d");
        if (g) {
            g.drawImage(p.img, 0, 0);
            g.globalCompositeOperation = "multiply";
            g.fillStyle = `rgb(${colour[0]},${colour[1]},${colour[2]})`;
            g.fillRect(0, 0, c.width, c.height);
            g.globalCompositeOperation = "destination-in";
            g.drawImage(p.img, 0, 0);
        }
        if (tints.size > 64) tints.clear();
        tints.set(id, c);
        return c;
    }

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
        const flipStage = up || Boolean(cfg.upsideDown);
        const lefts = columnLefts(cfg);
        const widths = cfg.columnWidth;
        const stageL = lefts[0];
        const stageR = lefts[KEYS - 1] + widths[KEYS - 1];
        const hit = cfg.hitPosition;
        const now = clock % PATTERN.length;
        const auto = autoplayAt(now);
        const span = spanMs(speed);
        const perMs = hit / span;
        // y in downscroll terms → the canvas; a picture h high whose top is at y
        const Y = (y, h = 0) => (flipStage ? H - y - h : y);
        const image = (p, x, y, w, h, { flip = false, alpha = 1, source = null } = {}) => {
            const src = source ?? p.img;
            ctx.save();
            ctx.globalAlpha = alpha;
            const yy = Y(y, h);
            if (flip && flipStage) {
                ctx.translate(0, yy + h);
                ctx.scale(1, -1);
                ctx.drawImage(src, x, 0, w, h);
            } else ctx.drawImage(src, x, yy, w, h);
            ctx.restore();
        };
        const box = (x, y, w, h, style) => {
            ctx.fillStyle = style;
            ctx.fillRect(x, Y(y, h), w, h);
        };
        // column-wide height of a picture
        const tall = (p, w) => (p.img.naturalHeight * w) / (p.img.naturalWidth || 1);
        const noteW = (c) => cfg.widthForNoteHeightScale || widths[c];

        // lanes and lines
        for (let c = 0; c < KEYS; c += 1) box(lefts[c], 0, widths[c], H, rgba(cfg.colours[c]));
        for (let i = 0; i <= KEYS; i += 1) {
            const w = cfg.columnLineWidth[i] ?? 0;
            if (w <= 0) continue;
            const x = i < KEYS ? lefts[i] : stageR;
            box(x - w / 2, 0, w, H, rgba(cfg.columnLine));
        }
        // the stage's sides
        const left = pic("StageLeft");
        if (left) {
            const w = left.img.naturalWidth * NATIVE * px(left);
            image(left, stageL - w, 0, w, H, { flip: true });
        }
        const right = pic("StageRight");
        if (right) image(right, stageR, 0, right.img.naturalWidth * NATIVE * px(right), H, { flip: true });

        // column light where a key is down
        for (let c = 0; c < KEYS; c += 1) {
            const light = pic("StageLight");
            const since = auto.lastHit[c];
            const on = auto.pressed[c] ? 1 : since !== null && since < 220 ? 1 - (since - 70) / 150 : 0;
            if (!light || on <= 0) continue;
            const h = tall(light, widths[c]);
            image(light, lefts[c], cfg.lightPosition - h, widths[c], h, { flip: true, alpha: Math.min(1, on), source: tinted(light, cfg.lights[c]) });
        }

        const drawKeys = () => {
            for (let c = 0; c < KEYS; c += 1) {
                const key = pic(auto.pressed[c] ? `KeyImage${c}D` : `KeyImage${c}`) ?? pic(`KeyImage${c}`);
                if (key) {
                    const h = tall(key, widths[c]);
                    image(key, lefts[c], H - h, widths[c], h, { flip: cfg.keyFlip });
                } else box(lefts[c] + 1, hit, widths[c] - 2, H - hit, auto.pressed[c] ? "#3a3552" : "#1c1928");
            }
        };
        if (cfg.keysUnderNotes) drawKeys();

        // the hint and the judgement line
        const hint = pic("StageHint");
        if (hint) {
            const h = hint.img.naturalHeight * NATIVE * px(hint);
            for (let c = 0; c < KEYS; c += 1) image(hint, lefts[c], hit - h / 2, widths[c], h, { flip: true });
        }
        if (cfg.judgementLine) box(stageL, hit - 0.5, stageR - stageL, 1, rgba(cfg.judgementLineColour));

        // notes: their bottom on the hit line on time; holds draw body, tail, then head
        const yOf = (time) => hit - (time - now) * perMs;
        const loops = [0, PATTERN.length];
        for (const shift of loops) {
            for (const n of PATTERN.notes) {
                const t0 = n.t + shift;
                const c = n.col;
                const w = widths[c];
                const x = lefts[c];
                const head = pic(n.end !== undefined ? `NoteImage${c}H` : `NoteImage${c}`);
                const hh = head ? (head.img.naturalHeight * noteW(c)) / (head.img.naturalWidth || 1) : w * 0.35;
                if (n.end !== undefined) {
                    const t1 = n.end + shift;
                    if (now > t1 || yOf(t1) > H + 40) continue;
                    // tops of the head and the tail end; the body runs between their middles
                    const yHead = Math.min(hit, yOf(t0)) - hh;
                    const yTail = yOf(t1) - hh;
                    if (yHead + hh < -10) continue;
                    const body = pic(`NoteImage${c}L`);
                    const length = yHead - yTail;
                    const bodyTop = yTail + hh / 2;
                    if (length > 0) {
                        if (body) {
                            const style = cfg.bodyStyles[c];
                            if (style === 0) image(body, x, bodyTop, w, length, { flip: cfg.noteFlip });
                            else {
                                const tile = Math.max(4, tall(body, w));
                                ctx.save();
                                ctx.beginPath();
                                ctx.rect(x, Y(bodyTop, length), w, length);
                                ctx.clip();
                                const bodyEnd = bodyTop + length;
                                if (style === 1) for (let y = bodyTop; y < bodyEnd; y += tile) image(body, x, y, w, tile, { flip: cfg.noteFlip });
                                else for (let y = bodyEnd - tile; y > bodyTop - tile; y -= tile) image(body, x, y, w, tile, { flip: cfg.noteFlip });
                                ctx.restore();
                            }
                        } else box(x + w * 0.2, bodyTop, w * 0.6, length, rgba(cfg.lights[c], 0.5));
                    }
                    const tail = pic(`NoteImage${c}T`);
                    if (tail) {
                        const th = (tail.img.naturalHeight * noteW(c)) / (tail.img.naturalWidth || 1);
                        image(tail, x, bodyTop - th / 2, w, th, { flip: cfg.noteFlip });
                    }
                    if (head) image(head, x, yHead, w, hh, { flip: cfg.noteFlip });
                    else box(x + 1, yHead, w - 2, hh, "#eeeeee");
                    continue;
                }
                if (t0 < now) continue;
                const y = yOf(t0) - hh;
                if (y + hh < -10) continue;
                if (y > H) continue;
                if (head) image(head, x, y, w, hh, { flip: cfg.noteFlip });
                else box(x + 1, y, w - 2, hh, "#eeeeee");
            }
        }
        if (!cfg.keysUnderNotes) drawKeys();

        // hit lighting: a burst when a note is hit, the hold light while a hold is down
        for (let c = 0; c < KEYS; c += 1) {
            const since = auto.lastHit[c];
            const holding = auto.hold[c];
            const p = pic(holding ? "LightingL" : "LightingN");
            if (!p || (!holding && (since === null || since > 160))) continue;
            const widthList = holding ? cfg.lightingLWidth : cfg.lightingNWidth;
            const base = widthList?.[c] || p.img.naturalWidth * NATIVE * px(p);
            const grow = holding ? 1 : 1 + since / 900;
            const w = base * grow;
            const h = (p.img.naturalHeight * w) / (p.img.naturalWidth || 1);
            image(p, lefts[c] + widths[c] / 2 - w / 2, hit - h / 2, w, h, { alpha: holding ? 0.9 : 1 - since / 160 });
        }

        // the judgement, centred on the stage at ScorePosition: a quick pop, then a fade
        if (auto.judgement && auto.judgement.since < 450) {
            const p = images[cfg.images[auto.judgement.key]];
            const since = auto.judgement.since;
            const k = since < 60 ? 1.25 - since / 240 : 1;
            const alpha = since > 300 ? 1 - (since - 300) / 150 : 1;
            const cx = (stageL + stageR) / 2;
            if (p?.img) {
                const w = p.img.naturalWidth * NATIVE * px(p) * k;
                const h = p.img.naturalHeight * NATIVE * px(p) * k;
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.drawImage(p.img, cx - w / 2, Y(cfg.scorePosition - h / 2, h), w, h);
                ctx.restore();
            }
        }
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
