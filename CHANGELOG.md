# Changelog

## 0.9.0

- **Model picker for Create map:** "Classic" — the proven model from 0.8 — stays the default and is what Auto runs. Next to it, experimental models to try: XGBoost v3, and the neural nets S (fast) and M; the neural net L (needs a graphics card) shows as not there yet — it is still training and comes in a later update. On 179 held-out songs the new models hit the asked dan more often, but their notes and patterns are less like a human mapper's, so each one says so in its hint and none is the default. A card names the model it was made with, and if the one you picked couldn't run (no file, or no sound breakdown) it says which one was used instead.
- **Ratings:** 👍 / 👎 on every variant, with up to four reasons ("too jacky", "fun", …); your ratings are counted and can be exported to a file.
- **Candidates and the critic:** the "Candidates to choose from" slider (1–20, default 1: off) makes several candidates per variant and lets the critic pick the most human-like, fun and comfortable one; the card shows its scores.
- **Stems and repeats:** the song is split into kick, snare, hi-hat and harmony when it loads; with that, repeated parts of the song can get similar patterns ("Repeats get similar patterns"), and a mapper style can be picked when the model knows any.
- **Graphics card path:** the neural nets run on the graphics card (WebGPU) when there is one that passes a self-check, else on the CPU; "Regenerate only this part" redoes one part of a variant in place.
- **Updates:** the app checks for a new version again every 4 hours while it runs (installed and portable), not only at start.

## 0.8.1

- **In-game overlay:** three separate always-on-top windows over osu! (windowed or borderless): judgements with the MAX:300 ratio, accuracy and UR; KPS now and max with a graph; key-press lines for K1–K4. Five styles (Minimal, Card, Neon, osu! Classic, Compact), opacity and size per window, Ctrl+Shift+O to move them, settings in the tray. Off by default; nothing is injected into osu!.

## 0.8.0 — first public release

- **Pattern kinds:** one «General / Detailed» switch for every tab. In Detailed, Create map (and a part's own patterns) offers 21 kinds of the six patterns — rolls, trills, minitrills, running man, jumptrills, split trills, anchors, dumpstream, chord trills, dense and jumpy handstream, handjacks, jumpjacks, quadhand, quadstream, minijacks, longjacks, gluts, speedjacks, coordination and jacky stream — spread over the song's parts or mixed every few bars; variants are ranked by how much of the chosen kinds came out. Result cards, part lines, the analysis card and its pattern strip show kinds; Picks and the auto-marathon add quadstream, handjack and speedjack.
- **Installer with auto-updates** next to the portable exe. The installer updates itself from GitHub Releases; the portable version tells you when a new one is out.
- **Create map v3:** BPM and offset detection for songs with several BPMs, 1/3 and 1/6 snaps, song parts with their own dan and patterns, a playability guard, several ranked variants, a preview player with a playfield and a timeline, locking a part and regenerating the rest, mapsets and dan ladders in one click, rate versions, metadata, preview point and background, and remapping an existing map.
- **Analysis:** MSD, Sunny ★, a choice of calculator (ours, Mixed, Daniel, Azusa, Roxy, Companella or all), a difficulty line along the map, patterns by part, "for you" and a dan-by-rate ladder.
- **Rate:** rate for a target dan, several rates at once, mirror and no-LN versions, presets.
- **Marathon:** an automatic marathon from your skill profile, course templates and a difficulty curve.
- **Picks:** maps for your skill from mania-tracker by pattern and goal or your own dan range, one-click download, a training plan, similar maps, favourites exported as an osu! collection, and progress.
- Russian and English interface, a new icon, and the name Lunacy mania (the project: Lunacy mania instrument).
