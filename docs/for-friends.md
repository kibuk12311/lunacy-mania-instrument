# Lunacy mania — how to use it

## What's new in 0.9.1

- In-game overlay: a fourth window, **"Map NPS"** — the notes per second of the map itself (not of your presses) at the play position, the map's peak NPS, and a graph of the whole map with a playhead (the part already played is tinted). A hold note counts once; with DT, HT and rate copies it is in real time. Five styles, opacity, size and position like the other windows; on or off in the tray, in the overlay settings and in the new OV panel.
- The **KPS graph** holds still now: a smooth curve on a fixed grid that scrolls instead of twitching, a scale that doesn't jump, and a "now" number that no longer flicks between two values.
- The overlay windows **no longer flicker in song select**: they show only once a play is really running (about half a second in) and hide after a short moment, so a single odd frame from osu! can't flash them.
- The main window has an **OV** button next to RU/EN, 📌 and ▭: the overlay on/off, a checkbox per window, "Move windows (Ctrl+Shift+O)" and a link to all overlay settings. It stays in sync with the tray and the settings window. (Not shown in compact mode.)
- **osu! lazer works now**, not only stable (the app shows which one it's connected to at the bottom of the window). On lazer, rate copies and remaps come as an .osz that opens in lazer and imports as a separate set; collections can't go into lazer as a collection.db, so you get a list of the maps with links instead. Custom speeds (DT/HT at any speed, Rate Adjust) count as the rate, and the overlay's key lines use your real presses on lazer.
- The portable file is now called `Lunacy-mania-Portable-<version>.exe`, so it's easy to tell from the installer.

## What's new in 0.9.0

- "Create map" has a model picker. "Classic" is the proven model and stays the default. The others are **experimental**: "XGBoost v3", "Neural net S" (fast), "Neural net M" and "Neural net L" (needs a graphics card; it is still training and comes in a later update). They hit the dan you asked for more often, but their notes feel less hand-made — try them and compare.
- 👍 / 👎 under every variant, with reasons. Your ratings help train the next models; "Export my ratings" saves them to a file.
- "Candidates to choose from" (1 = off): the app makes several candidates per variant and a critic picks the best one. Slower, sometimes better.
- "Repeats get similar patterns": repeated parts of the song get similar patterns (the sound is split into drums and melody when the song loads).
- The neural nets use the graphics card when there is a suitable one.
- The app also checks for updates every 4 hours while it is open, not only 10 seconds after start.

## What's new in 0.8.0

There are now two files on the [releases page](https://github.com/kibuk12311/lunacy-mania-instrument/releases/latest). `Lunacy-mania-Setup-0.8.0.exe` is the installer: it installs without admin rights, adds desktop and Start menu shortcuts and **updates itself** — 10 seconds after start it quietly checks GitHub, downloads a new version in the background and offers "Restart now" or "Later" (then it installs when you quit the app). `Lunacy-mania-Portable-<version>.exe` is the portable version, as before: nothing to install, but it can't update itself — when a new version is out, it offers to open the download page. The tray icon's menu has "Check for updates" and a "Check for updates automatically" checkbox. Both versions share the same settings and results, and uninstalling keeps them. Per tab: "Analysis" has a difficulty graph along the map, a "for you" comparison, a rate ladder and a pattern strip; "Rate" makes a rate for the dan you want, several rates at once, mirror, no-LN and presets; "Marathon" has an auto-marathon, course templates and a difficulty curve; "Picks" has a training plan, similar maps, favourites with export to collection.db, and progress; "Create map" detects the timing, splits the song into parts, gives several variants, shows a preview, saves a mapset and rates, and can remap an existing 4K rice map.

1. Download `Lunacy-mania-Portable-<version>.exe` and run it. Nothing to install.
2. If Windows shows a blue "Windows protected your PC" window, click "More info" → "Run anyway". The app isn't signed, so this can happen.
3. Open osu! (stable) and go to song select. The window shows the dan, the confidence and the patterns of the selected map. 4K rice only. DT and HT are taken into account.
4. Move and resize the window as you like. 📌 keeps it on top, ▭ is the compact mode. Both are also in the tray icon's menu.
5. Close it with the window's × or "Exit" in the tray.
6. If it says "osu! updated? This app needs a new version", ask for a new version of the app.
7. Under the card you can pick the calculator: "Overall" (ours, combines them all), Mixed, Daniel, Azusa, Roxy, Companella, or "All" to see every dan side by side with the MSD of each skillset. The "MSD · Sunny ★" line is the map's MinaCalc difficulty and Sunny star rating.
8. Language: the RU/EN button under the card, or "Язык / Language" in the tray menu.

## Picks

The "Picks" tab suggests maps for your skill. Needs the internet.

1. Click "from osu!" (osu! must be open) or type your nick and click "Load". Your skill comes from mania-tracker.com — if you're not there yet, open your profile on the site and wait until it's computed. You can also skip the tracker: "Manual" → pick a dan.
2. Pick a pattern and a goal: "Comfort" is a bit below your level, "Growth" is what's worth playing right now, "Challenge" is clearly above.
3. "Find maps". Each card shows the map's dan and how far it is above or below yours. "osu!direct" opens the map in the game (needs supporter), "Page" opens it on the osu! site, "Our analysis" checks it with this app and suggests a rate for your goal.
4. "Download" downloads the map and opens it in osu! right away (no supporter needed). Files go to "Documents…скачанные".
