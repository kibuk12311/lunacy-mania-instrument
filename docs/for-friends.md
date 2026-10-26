# Lunacy mania — how to use it

## What's new in 0.9.7

- **Dan by part, in the Analysis tab.** Under the difficulty line there's a new block, "Dan by part": the map is cut into parts of about half a minute (at breaks and where the density changes), and each part gets a real dan from the same model as the card, as if it were a map of its own at your rate — then corrected for length and stamina (a short part alone plays easier than inside a long map). You see steps along the map with dan names on the side, the hardest part outlined and named ("hardest 1:29–1:58 · Gamma mid"), and the whole map's dan as a dashed line. Hover or tap a part to see its time, dan and main pattern; "All parts" lists them all. It takes a moment after the card ("working out each part's dan…"). The card's main dan doesn't change — it is still the map's overall dan.
- **The overlay's Dan window shows only the map's overall dan now**: the number and its name, nothing else out of the box. The line along the map and "now: …" are gone (they were only an estimate — the real per-part dans are in Analysis now). The pattern with its confidence, "vs your level" and "this play" are still there as options, off until you tick them in the overlay settings. If you never changed those boxes in 0.9.6 they're switched off for you; if you did, your choice stays.

## What's new in 0.9.6

- **The overlay has a "Dan" window now.** While you play it shows the map's dan at your rate (the same number as the card, e.g. "Gamma mid · 13.0") with how sure it is and the main pattern, a small line of how hard the map gets with a marker where you are and "now: Gamma high", and "+0.8 vs your level" against your profile (the one chosen in Picks). On the results screen it shows "this play: …" — the dan of your play by My profile (when "Record my plays" is on). Turn it on or off in the tray, the OV panel or the overlay settings, where each line can be switched off too. While the map is being worked out it says "working out…"; not-4K, LN and non-mania maps say so.

- **All the settings are on one page now.** Press **⚙** under the card (or "Settings…" in the tray menu): the calculator, the language, 📌 always on top, the overlay (with the new Dan window), Interlude (folder, following the game live, its library), your profile source and "Record my plays", folders, updates ("Check now"), osu!/tosu, clearing caches and About. "← Back" (or Esc) returns to the card. With an Interlude folder linked, the small **IL** under the card opens its library there.
- **The compact mode (▭) is gone** — use the in-game overlay instead (the Dan window shows the map's dan right in the game). If you had it on, the app simply opens in the normal window.
- The author: Sneezey · Discord: sneezey123 (at the bottom of the Settings page; click the name to copy it).
- **The Profile tab shows your dans as a chart**, so "13.00 ±0.43" is easy to read: your Speed / Jack / Stamina / Tech on a dan scale (Beta, Gamma, Delta …), the band around each dot is the ± (fainter = less sure), the gold line is your overall dan. "Radar" shows the same as a spider chart. Hover or tap a skill to see it in words. The patterns are bars on the same scale, and the history chart's scale is in dans too. Works on both pages, My profile and mania-tracker.

## What's new in 0.9.5

- **Mapper style is easier to use.** On the Create tab the "Mapper style" list now shows the styles of the model you picked straight away (XGBoost v3 or a neural net), with real mapper names, the ones with the most maps first and a search box to find one. The Classic model has no styles — the list says so. The map's card tells you which style it was made with. A style changes the notes only a little on XGBoost v3 and a bit more on the neural nets.

## What's new in 0.9.4

- **New "Skin" tab — make or edit an osu!mania 4K skin.** "From scratch": pick the note shape (circles, bars, arrows, diamonds), the column colours (1-2-2-1 and other presets, or your own per column), sizes, hold notes, keys, the stage, the judgement font and the lighting, then "Make the skin". "My osu! skins" opens a copy of one of your skins (your original isn't touched), ".osk file" opens a skin file. Then change anything of its 4K part — column width, hit position, colours, every picture (click a thumbnail or drop a PNG / JPG / WebP on it to use your own picture — the normal and @2x size are made for you; "Reset" brings back the old one, "Apply to all columns" does all four at once) — and watch it in the preview with notes falling, holds and key presses (downscroll or upscroll). ↶ / ↷ undo and redo. "Save an .osk and open it in osu!" puts the skin in `Documents\Lunacy mania\скины` and osu! (stable or lazer) imports it. For **Interlude**, a skin made from scratch can also be saved as an `.isk`: drag it onto Interlude's window. (Your own existing skin goes into Interlude through Interlude's own skin editor and import.)

## What's new in 0.9.3

- **New "Profile" tab** (the "Create map" tab is now just "Create"). Two pages: **mania-tracker** (your tracker profile, history chart, recent plays, a link to the site) and **My profile** — the app learns your skill from your own plays: every osu! play (stable or lazer) that reaches the results screen is recorded and analysed, and "Import from osu! stable" reads your old local scores once (it may take a while the first time; you can stop it and go on later). Interlude's history can be imported too. You get an overall dan, Speed / Jack / Stamina / Tech and every pattern with a ± and how sure it is, the best and recent plays and a history chart. Choose "My profile" as the source in Picks (or at the top of the Profile tab) and picks, the plan, the auto-marathon and "For you" use it. Nothing leaves your PC; export / import a backup or reset it in the same place; untick "Record my plays" to stop recording. osu! lazer's old plays can't be read — lazer counts from now on.

## What's new in 0.9.2

- **Interlude works now** too (the free VSRG client, portable). Press **IL** at the bottom of the card and pick your Interlude folder (the one with Interlude.exe, Songs and Data) or press "Find".
- In the same panel you can **search Interlude's library** and click a chart: the card shows its dan, patterns, MSD and the dan at other rates, and the Rate tab makes rate copies of it.
- Rate copies, marathons, generated maps, remaps and downloads get a **"→ Interlude"** button: the app makes an .osz, shows it in Explorer and brings Interlude to the front — **drag the file onto Interlude's window** (Interlude can't be told to import a file any other way).
- **"Playlist in Interlude"** under the marathon, the Picks plan and the favourites: the maps go into an Interlude playlist in order, each at its own rate — handy for dan courses. **Close Interlude first** (it saves its playlists when it exits and would overwrite them); the old file is kept as a backup. Maps you haven't imported into Interlude yet are listed so you can import them first.
- "Hide played" in Picks also knows the osu! maps you played in Interlude.
- **The card follows Interlude live:** once the folder is linked, the card shows the chart you select in Interlude (at your rate), just like with osu!, and the bottom of the window says **"Interlude · live"**. If osu! is open too, the card shows whichever one you changed last. You can turn this off in the IL panel ("Follow Interlude live").
- **The overlay works in Interlude** too: judgements under your ruleset's own names (MARV, PERF … for SC or Wife3) with Interlude's accuracy, KPS and key lines from your real presses, UR, the chart's NPS.
- It works through a small helper that only reads Interlude's memory (it never changes anything). If the IL panel says the .NET helper file is missing, tick "Download .NET's helper file if it's missing" once. If your antivirus removes `interlude-reader.exe`, add the app's folder to its exceptions. If the panel says "Did Interlude update? The scanner didn't find …", the rest still works — tell me and a new version will fix it.
- **The overlay no longer disappears** after you minimize osu!, Interlude or the app's window (pinned or not) and come back — it pops back up over the game.

- **No mania-tracker? Set your skill by hand.** Picks → "Manual": pick your dan for **Speed, Jack, Stamina and Tech** (like a tracker profile shows them), optionally a name. The app works out your overall dan (the mean of the four, as mania-tracker does) and uses this profile for picks, the plan, the auto-marathon "from my Picks profile" and "For you" in the analysis. If you do have a tracker profile, "Copy from mania-tracker" fills the four in to start from. Hiding played maps needs mania-tracker or a linked Interlude folder (then the maps you played in Interlude are hidden); Progress still needs mania-tracker — the app says so.
- **Picks → "Session": a practice session from your own maps**, nothing to download. The app goes through your osu! stable Songs folder (and Interlude, if linked) once, analyses every 4K map in the background and remembers it, so next time only new maps are looked at. Pick a length (20–60 min or your own), 1–3 patterns and a goal: you get warm-up → main maps at your level → a harder push → an easy cool-down, about as long as you asked. Tick "allow rates" to use maps at the rate that gives the dan you need. ↻ swaps one map, you can save a session and send it to osu! as a collection, to Interlude as a playlist or build it as one marathon. osu! lazer's maps can't be read from outside, so they aren't included.
- Maps and players **above Kappa high** now read "above Kappa · 21.3" — the number tells how far above.

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
4. Move and resize the window as you like. 📌 "Always on top" is on the Settings page (⚙ under the card) and in the tray icon's menu.
5. Close it with the window's × or "Exit" in the tray.
6. If it says "osu! updated? This app needs a new version", ask for a new version of the app.
7. Under the card you can pick the calculator: "Overall" (ours, combines them all), Mixed, Daniel, Azusa, Roxy, Companella, or "All" to see every dan side by side with the MSD of each skillset. The "MSD · Sunny ★" line is the map's MinaCalc difficulty and Sunny star rating.
8. Language: on the Settings page (⚙ under the card), or "Язык / Language" in the tray menu.

## Picks

The "Picks" tab suggests maps for your skill. Needs the internet.

1. Click "from osu!" (osu! must be open) or type your nick and click "Load". Your skill comes from mania-tracker.com — if you're not there yet, open your profile on the site and wait until it's computed. You can also skip the tracker: "Manual" → set your dan for Speed, Jack, Stamina and Tech.
2. Pick a pattern and a goal: "Comfort" is a bit below your level, "Growth" is what's worth playing right now, "Challenge" is clearly above.
3. "Find maps". Each card shows the map's dan and how far it is above or below yours. "osu!direct" opens the map in the game (needs supporter), "Page" opens it on the osu! site, "Our analysis" checks it with this app and suggests a rate for your goal.
4. "Download" downloads the map and opens it in osu! right away (no supporter needed). Files go to "Documents…скачанные".
