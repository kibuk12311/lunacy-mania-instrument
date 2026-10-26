# Changelog

## 0.9.1

- **Overlay — NPS window:** a fourth widget, "Map NPS": the notes per second of the map itself (not of the presses) at the play position, the map's peak, and a graph of the whole map with a moving playhead (the played part tinted). Hold notes count once by their head; DT, HT and rate copies read in real time. All five styles, opacity, size and position, toggles in the tray and the settings window, made-up numbers in the preview.
- **Overlay — steadier KPS graph:** the rate is a triangular 0.8 s window sampled on a fixed 100 ms grid, so finished samples never change and late judgements barely move it; the newest point slides between grid points, the y-scale eases towards a ceiling above the play's max instead of jumping each frame, and the big "now" number is eased and holds its integer.
- **Overlay — no flicker in song select:** the windows go through a gate with hysteresis: shown only after the play state has lasted 0.4 s with its clock moving or judgements coming (1.5 s of play state alone is also trusted), hidden only after 0.3 s without it; a shown window gets the current snapshot before it appears. The results screen works as before.
- **Overlay in the main window:** an OV button in the analysis footer opens a panel with the overlay on/off, a checkbox per widget, "Move windows (Ctrl+Shift+O)" and a link to the overlay settings; it shares overlay.json with the tray and the settings window and follows every change. The tray menu gets a checkbox per widget too.
- **Create map — volume:** a «Громкость» / "Volume" slider (0–100 %, remembered) under the preview's scroll speed sets the song and the hit clicks together.
- **osu! lazer support:** tosu v4 reads lazer too, and the app now works with it. The footer names the osu! that is connected (stable / lazer). The selected map is read from lazer's hashed file store (tosu's `/files/beatmap/file` and `/json/v2` paths); nothing is ever written there. Rate copies and remaps are made from a copy of the map in Documents\Lunacy mania\lazer and handed to lazer as one .osz that it imports as a separate set (the charts get BeatmapSetID:-1 / BeatmapID:0, so lazer never replaces the original set); Marathon's «+ selected in osu!» uses that copy; the auto-marathon skips the Songs lookup and downloads instead. Lazer's own speeds (DT/HT at any speed, Rate Adjust) are the rate on the card, in the Rate tab and in the overlay. Collections: lazer can't import a collection.db, so with lazer the export also writes a list of the maps with links and says so. The overlay's key lines use lazer's real key counters, and "osu! updated?" has its own lazer hint.
- **Overlay — a single odd frame no longer restarts the play:** a non-play state must last 0.5 s (the results screen still ends a play at once) before the KPS max and the lanes start over. The key counters of tosu's precise feed are now used even though tosu v4.26.3 sends no clock with them.
- **Portable file name:** the portable build is now `Lunacy-mania-Portable-<version>.exe` (the installer stays `Lunacy-mania-Setup-<version>.exe`).

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
