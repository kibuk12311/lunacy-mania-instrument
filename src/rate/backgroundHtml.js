// 1920×1080 dan-course style background for a marathon: big title, dan range, the numbered map list and,
// when given, the difficulty curve (an SVG string from marathonCurve.js) along the bottom.
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// curveSvg is our own markup (its labels are escaped where it is made), so it goes in as it is.
export function backgroundHtml({ title, subtitle, items, imageDataUrl = null, curveSvg = "" }) {
    const curve = typeof curveSvg === "string" && curveSvg.startsWith("<svg") ? curveSvg : "";
    // with the curve below, the list gets tighter sooner and the title stays on one line (≈0.68 em a letter + spacing)
    const many = items.length > (curve ? 6 : 8);
    const titleSize = Math.round(Math.max(56, Math.min(many ? 96 : 110, (1700 / Math.max(1, String(title ?? "").length) - 6) / 0.68)));
    const rows = items.map((it, i) => `
        <li><span class="n">${i + 1}</span><span class="name">${escape(it.label)}</span><span class="dan">${escape(it.dan)}</span></li>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0d0b14; font-family: "Segoe UI", sans-serif; color: #f2f0f8; }
    .bg { position: absolute; inset: -40px; background-size: cover; background-position: center; filter: blur(18px) brightness(0.35) saturate(1.2); }
    .shade { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 30%, rgba(245,198,107,0.18), transparent 60%),
             linear-gradient(180deg, rgba(13,11,20,0.2), rgba(13,11,20,0.85)); }
    .wrap { position: relative; height: 100%; display: flex; flex-direction: column; align-items: center; padding-top: ${many ? 70 : 120}px; box-sizing: border-box; }
    h1 { margin: 0; font-size: ${many ? 120 : 150}px; font-weight: 900; letter-spacing: 6px; text-transform: uppercase; color: #f5c66b;
         text-shadow: 0 0 40px rgba(245,198,107,0.55), 0 6px 0 rgba(0,0,0,0.5); text-align: center; max-width: 1700px; }
    .sub { margin-top: 10px; font-size: 38px; color: #8fd3ff; letter-spacing: 2px; }
    ol { list-style: none; margin: ${many ? 40 : 70}px 0 0; padding: 0; width: 1500px; }
    li { display: flex; align-items: center; gap: 28px; padding: ${many ? 8 : 14}px 26px; margin-bottom: 10px; border-radius: 14px;
         background: rgba(28,25,40,0.72); border: 1px solid rgba(143,211,255,0.18); font-size: ${many ? 28 : 34}px; }
    .n { width: 56px; text-align: center; font-weight: 800; color: #f5c66b; }
    .name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dan { color: #7be08f; font-weight: 700; white-space: nowrap; }${curve ? `
    .wrap { padding-top: ${many ? 50 : 80}px; padding-bottom: 270px; }
    h1 { font-size: ${titleSize}px; }
    ol { margin-top: ${many ? 30 : 50}px; min-height: 0; overflow: hidden; }
    .curve { position: absolute; left: 210px; bottom: 40px; width: 1500px; height: 200px; padding: 10px 0; box-sizing: border-box;
             border-radius: 14px; background: rgba(28,25,40,0.6); border: 1px solid rgba(143,211,255,0.18); }
    .curve svg { display: block; width: 100%; height: 100%; }` : ""}
    </style></head><body>
    ${imageDataUrl ? `<div class="bg" style="background-image:url('${imageDataUrl}')"></div>` : ""}
    <div class="shade"></div>
    <div class="wrap"><h1>${escape(title)}</h1><div class="sub">${escape(subtitle)}</div><ol>${rows}</ol></div>${curve ? `
    <div class="curve">${curve}</div>` : ""}
    </body></html>`;
}
