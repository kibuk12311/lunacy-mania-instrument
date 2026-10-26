# Local profile ("Мой профиль" / "My profile")

A skill profile the app builds from the player's own plays over time: an overall dan, a dan for each of
mania-tracker's four axes (Speed, Jack, Stamina, Tech) and for each of the picks' seven patterns (Stream,
Jumpstream, Handstream, Stamina, Chordjack, Jack, Tech), each with a ± range and a confidence. No account and no
network: everything lives in `userData\local-profile`.

Code: `src/localProfile/model.js` (the model, pure), `src/localProfile/recorder.js` (plays from tosu frames),
`src/localProfile/scoresDb.js` (osu! stable's scores.db), `app/localProfileStore.js` (storage),
`app/osuSongsScan.js` (Songs md5 index), `app/localProfileService.js` (recording, import, skill),
`app/localProfileIpc.js` (wiring and channels), `app/renderer/profileTab.js` + `profileViews.js` (the Profile tab).

## Where the plays come from

| Source | How | What it has |
| --- | --- | --- |
| osu! stable, live | tosu `/websocket/v2` (its own socket, started with the window) | judgements, mods/rate, max combo, pass/fail/quit |
| osu! lazer, live | the same feed (tosu reads lazer too; on the results screen the numbers come from `resultsScreen`) | the same |
| osu! stable, history | `<osu!>\scores.db` (read only), matched by md5 to the `.osu` files in `Songs` | judgements, mods, time; passes only (osu! saves no failed plays) |
| Interlude, history | `Data\scores.db` through the existing library reader (copied out, never opened in place) | chart, rate, time, failed flag — **no judgements** (they are only inside the compressed replay) |
| osu! lazer, history | — | lazer keeps scores in a realm database the app cannot read; only plays recorded live count |

**Live recording.** A play starts on entering gameplay and ends on: the results screen → *pass*; leaving gameplay for
at least 0.5 s (one odd frame is ignored) → *quit*, or *fail* if the health bar was empty (osu! stable shows its fail
screen inside gameplay); a retry (the counts start over) or another map → the try before ends as quit/fail. Not
recorded: a results screen opened from song select (a saved score or a replay), someone else's play (tosu's
`play.playerName` differs from the logged-in `profile.name`: replays, spectating), plays with fewer than 20
judgements, non-mania modes. The `.osu` is fetched from tosu while the play goes on and is used only if its md5 is the
play's checksum. «Записывать мои игры» / "Record my plays" turns it off.

**Fails and quits** are stored (they show in recent plays) but are **no evidence** for skill: a quit after ten seconds
and a fail at the last chorus look the same from the outside, and counting them would only pull down players who
retry a lot. A pass with NF counts like any pass (its accuracy says how it went); autoplay-like mods (AT, CN, RX, AP)
never count.

**History import** (Profile → «Импорт из osu! stable»): the osu! folder is the one picked («Папка osu!…»), else the
one tosu reports, else `%LOCALAPPDATA%\osu!`. The main player is the logged-in osu! name if it has scores there, else
the name with the most scores (a shared PC's other players are left out). The Songs folder is indexed by md5 (only
4K mania charts; the index is kept in `songs-md5.json` and a set folder is read again only when it changed). Each
score not yet in the profile is analysed and added; the import can be stopped and goes on where it stopped, and
pressing it again later only adds new scores.

## Storage

- `plays.jsonl` — one play per line (the source of truth; the skill and the history are worked out from it).
  A play is kept once: same id, or same map + rate + every judgement (the live recording and the later scores.db
  import of the same play, a replay of one's own score).
- `maps.json` — the analysis summary per map and rate (`<md5>@1.10`): our combined dan, every calculator's dan, the
  pattern shares, the tech flag, the length. A map is analysed once per rate (through the shared analysis line and
  its cache too).
- `settings.json` — the record switch, the osu! folder, the last imports.
- Export writes all of it into one JSON file; import merges a backup into the profile (plays already there are kept
  once); reset clears plays and maps (the record switch stays).

## The model

### 1. Performance dan of one play

`perf = mapDan(rate) + accuracyAdjust(acc) − missPenalty`

- `mapDan` — our combined dan of the map at the play's rate (the same analysis as the card).
- `acc` — osu!stable mania accuracy from the judgements (MAX and 300 both 300, then 200/100/50), the overlay's formula,
  for stable and lazer alike.
- `accuracyAdjust`, around **REF_ACC = 96.5 %**:
  - above: **+0.08 per %**, at most **+0.25** (reached near 99.6 %) — near-perfect on a map is a little more than
    "can play it", but not a different dan;
  - 93 – 96.5 %: **−0.2 per %** (95 % → −0.3, 93 % → −0.7);
  - below 93 % (**KNEE_ACC**): **−0.35 per %** more, floored at **−2.5**.
  - Why 96.5 %: the common reading of "a map at your level" in 4K rice is one you can play at 96–97 % (v1). The
    tracker fixture (`tests/fixtures/mt/plays.json`) agrees: a player whose Speed tile is 14.28 has their top stream
    plays at 94.8–97.3 % (lazer weights, median ≈ 96.2 %), i.e. right around full credit — so the best plays land on
    about the maps' dans, which is what mania-tracker counts as clears for that tile.
- `missPenalty = min(0.4, 10 × missRate)` — 1 % misses → −0.1 on top of what they cost the accuracy: misses are
  combo breaks and HP loss, which dan courses punish more than a 100.
- A pass without judgements (Interlude): `perf = mapDan − 0.5` with **quality 0.5** — "passed it" is evidence, but
  weaker.

### 2. Attribution

From the map's analysis: LeoBlack's top three pattern names, mapped through the generator's families
(`src/gen/search.js NAME_FAMILY`: Rolls/Trills → stream, Chordstream → jumpstream, Brackets → handstream,
Quadstream/Chordjacks → chordjack, Jacks/Minijacks → jack), shares normalised to 1. Then:
- the analysis calls it **tech** → 40 % Tech, the rest scaled to 60 %;
- **length**: from 2:00 a map is partly Stamina, linearly up to 50 % at 6:00;
- no named pattern → the strongest MinaCalc skillset of the map.
Axes are the patterns' tiles (the picks' own mapping, `src/recommend/catalog.js`): stream → Speed; jumpstream,
handstream, stamina → Stamina; chordjack, jack → Jack; tech → Tech. A map is evidence for a key only where its share
is at least **0.2**.

### 3. Aggregation (per axis and per pattern)

1. Each map (md5 + rate) counts once: its best play for that key.
2. Old plays fade: past a **30-day** grace a play counts **0.5 dan less per year** (when ordering and averaging), so
   new plays take over the top of the list.
3. Warm-ups are left out: plays more than **2 dan** below the third best say nothing about the ceiling.
4. The top **20** (mania-tracker's rc dan counts 20 clears per skillset — `clearWindow.need` in the fixture) in
   order, the i-th weighted **0.95^i × share × quality**; the estimate is their weighted mean.
5. Minimum evidence: the summed share × quality of those plays must be at least **2** and come from **3** different
   maps; until then the key reads «мало игр» / "not enough plays".
6. ± range = **0.9 / √evidence**, within 0.1 … 1.2, where evidence is share × quality, halved every **180 days** of
   age; confidence low below 4, medium below 10, high from 10.

**Overall** = the mean of the four axes (mania-tracker's own overall is exactly that mean,
`src/recommend/manualProfile.js manualOverall`); axes without enough plays are left out and the summary says
"not every axis yet". An axis without a dan is `null` in `tiles`, so `playerDanFor` falls back to the overall dan,
like for a tracker profile without that tile.

**Incremental.** Adding a play appends its evidence to the keys it supports (no recompute of the history); reading
the skill aggregates the per-key lists at the current time (a few ms for thousands of plays). A test checks that
adding plays one by one in any order equals the batch result.

**History.** Daily snapshots are worked out from the play log: the skill at the end of each day that had plays (at
most 90 points per chart, evenly picked; the day before the period opens the line at its start). Being derived, they
are always consistent with the plays and survive a model change.

## Where it is used

The skill object has the tracker's shape (`readSkill`: `overall`, `overallLabel`, `tiles`, `msd`, `ready`,
`analyzedPlays`) plus `local: true`, `axes`, `patterns`, `partial`. Picks' source «Мой профиль» (`rec-settings.source =
"local"`) makes it the profile in use everywhere (`app/renderer/profile.js`): the window sends only `{ local: true }`
and main takes its own copy of the skill — picks, the plan, the auto-marathon "by profile", «для тебя» on the card;
Picks' Progress shows the local daily skill and joins the picks journal with the local plays. The local plays' beatmap
ids join "hide played" (`recommender.extraPlayed`). The Profile tab has both profiles: the mania-tracker page (nick,
dan, tiles, MinaCalc ratings, its history chart and recent plays, a link to mania-tracker.com/player/<id>) and «Мой
профиль» (summary, patterns, history chart, best plays per axis/pattern, recent plays, import, backup, reset, the
record switch, and a comparison with the tracker profile when one is loaded).

## Limitations

- Lazer's history can't be read (realm); lazer counts from the day recording starts.
- Interlude's scores have no judgements, so they are weaker evidence; Interlude isn't followed live here.
- Fails and quits are not evidence (by design).
- The dans are our analyzer's: on maps it misreads, the profile inherits the error (one misread map can't dominate:
  the warm-up rule looks at the third best, the mean takes up to 20).
- With few maps per axis the estimate is conservative (a mean of what there is); it settles as maps add up.
- osu! stable's Songs folder must be the one the scores were made with; maps deleted since are skipped and counted.
