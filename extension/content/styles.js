// CSS of the panel's shadow root: the app's palette (app/renderer), nothing of osu!'s branding. The shadow root keeps
// osu-web's styles out and ours in; `all: initial` on the host stops inherited osu-web text styles too.
export const PANEL_CSS = `
:host {
  all: initial;
  display: block;
  --bg: #14121c;
  --panel: #1c1928;
  --line: #2c2840;
  --text: #eee;
  --muted: #8a8698;
  --gold: #f5c66b;
  --blue: #8fd3ff;
  --bad: #ff8f8f;
  color: var(--text);
  font: 14px/1.4 Torus, Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
  margin: 12px 0;
}
:host([data-lm-floating]) {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: min(380px, calc(100vw - 32px));
  max-height: 70vh;
  overflow: auto;
  z-index: 2147483000;
  margin: 0;
  box-shadow: 0 8px 32px rgba(0, 0, 0, .5);
  border-radius: 10px;
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; }
.lm {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px 8px;
}
.head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.title { font-weight: 700; color: var(--gold); }
.muted, .count, .note { color: var(--muted); }
.count { font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.chip {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  min-width: 0; max-width: 220px;
  padding: 5px 9px; border-radius: 7px; cursor: pointer;
  background: var(--panel); border: 1px solid var(--line); text-align: left;
}
.chip:hover { border-color: var(--muted); }
.chip[aria-current="true"] { border-color: var(--gold); box-shadow: inset 0 0 0 1px var(--gold); }
.chip:focus-visible, .btn:focus-visible, .rate:focus-visible, .toggle:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.chip .ver { font-size: 11px; color: var(--muted); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip .dan { white-space: nowrap; }
.chip .lbl { font-weight: 600; }
.chip .num { margin-left: 6px; color: var(--blue); font-variant-numeric: tabular-nums; }
.chip[data-state="pending"] .dan, .chip[data-state="not-rice"] .dan, .chip[data-state="too-short"] .dan { color: var(--muted); }
.chip[data-state="error"] .dan { color: var(--bad); }
.grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 900px) { .grid { grid-template-columns: minmax(0, 1fr); } }
:host([data-lm-floating]) .grid { grid-template-columns: minmax(0, 1fr); }
.box { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.card .ver { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.card .big { display: flex; align-items: baseline; gap: 10px; margin: 2px 0; }
.card .lbl { font-size: 22px; font-weight: 700; color: var(--gold); }
.card .num { font-size: 20px; color: var(--blue); font-variant-numeric: tabular-nums; }
.card .msg { font-size: 15px; margin: 6px 0; }
.card .msg.bad { color: var(--bad); }
.card .line { font-size: 12px; color: var(--muted); }
.card .primary { margin-top: 8px; font-weight: 600; }
.bar-row { display: flex; justify-content: space-between; font-size: 12px; margin-top: 4px; }
.bar { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--blue); }
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.tag { font-size: 11px; padding: 1px 7px; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); }
.side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.toggle { background: none; border: 0; padding: 0; cursor: pointer; font-weight: 600; color: var(--text); }
.rates { display: flex; flex-direction: column; margin-top: 6px; }
.rate {
  display: grid; grid-template-columns: 3.2em minmax(0, 1fr) 2.8em 3em 5.6em; gap: 6px; align-items: baseline;
  background: none; border: 0; border-top: 1px solid var(--line); padding: 3px 2px; cursor: pointer; text-align: left;
  font-size: 12px; font-variant-numeric: tabular-nums;
}
.rate:hover { background: var(--bg); }
.rate .r { color: var(--muted); }
.rate .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rate .num { color: var(--blue); text-align: right; }
.rate .d { color: var(--muted); text-align: right; }
.rate[data-current] { background: var(--bg); }
.rate[data-current] .r { color: var(--gold); }
.rate .now { color: var(--gold); font-size: 11px; white-space: nowrap; text-align: right; }
.rate-line { display: flex; align-items: stretch; min-width: 0; }
.rate-line > .rate { flex: 1; min-width: 0; }
.rate-line > .rate .lbl { color: var(--bad); }
.rate-retry {
  flex: none; background: none; border: 0; border-top: 1px solid var(--line); padding: 3px 6px; cursor: pointer;
  font-size: 11px; color: var(--gold); white-space: nowrap;
}
.rate-retry:hover { text-decoration: underline; }
.rate-retry:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.foreign { color: var(--muted); font-size: 13px; }
.play { display: flex; flex-direction: column; gap: 6px; }
.btn {
  display: block; width: 100%; text-align: left; cursor: pointer;
  background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 6px 10px;
}
.btn:hover:not(:disabled) { border-color: var(--gold); }
.btn.main { border-color: var(--gold); color: var(--gold); font-weight: 700; }
.btn:disabled { cursor: default; opacity: .55; }
.btn .note { display: block; font-size: 11px; font-weight: 400; margin-top: 1px; }
.btn .note.warn { color: var(--gold); }
.foot { margin-top: 8px; font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
`;
