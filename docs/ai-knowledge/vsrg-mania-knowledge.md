# VSRG / osu!mania 4K knowledge file

> **Как вставить (для человека):** скопируй весь этот файл в «Инструкции проекта» / Custom instructions (Claude Project, ChatGPT Project или GPT, Gemini Gem) или приложи его файлом в первом сообщении чата.

## For the agent: read this first

- **Who the user probably is:** an osu!mania **4K rice** player (tap notes, few or no long notes), often Russian-speaking. **Answer in the language the user writes in** (Russian if they write Russian). Use the community's English terms (jumpstream, chordjack, dan, MSD) as they are; players use them untranslated.
- **What this file is:** a compact reference on VSRG / osu!mania 4K, dan scales, difficulty calculators, patterns, rates, osu! file formats, mania-tracker, beatmap mirrors, map generation and osu! rules. It was distilled from the source code and notes of **Lunacy mania** (section 11), an open-source Windows helper for 4K rice players.
- **How to use it:** treat it as background knowledge. Numbers here come from code, tests and benchmark reports; quote them as given and say where they come from ("the Lunacy mania benchmark", "LeoBlack's tables"). When something is not covered here (judgement windows, pp formulas, a specific map's dan), say so and suggest checking the osu! wiki, mania-tracker or the app, rather than guessing. Dates in this file (mirror status, rules) are snapshots from 2026-10; tell the user to re-check them if it matters.
- **Do not** claim calculators are exact. Every dan number is an estimate with an error of roughly 0.2-0.5 of a level (section 3).

---

## 1. VSRG and osu!mania 4K basics

| Term | Meaning |
|---|---|
| VSRG | Vertical scrolling rhythm game: notes fall (or rise) in lanes toward a judgement line. osu!mania, Etterna/StepMania, Quaver, Malody and Interlude are VSRGs. |
| osu!mania | osu!'s VSRG mode. In a `.osu` file it is `Mode: 3`. |
| Keys / columns | Lane count. 4K = 4 lanes (`CircleSize:4` in the .osu). Default keys **D F J K**; left hand = columns 1-2, right hand = 3-4. |
| Downscroll | Notes move down toward a line at the bottom; charts are read bottom-up. |
| Rice | Tap notes only or nearly so. The project's rule: **4K rice = exactly 4 keys and at most 15% long notes** (LN ratio = LN objects / all objects). |
| LN | Long note (hold). LN-heavy maps are "LN" or "Mix", rated by different tables and skills. |
| Chord names | 2 notes at once = **jump**, 3 = **hand**, 4 = **quad**. |
| Vibro | Extremely fast single-column jack spam. A separate niche; tools filter it by the word "vibro" in title/diff name. |
| Rate | Playback speed multiplier (1.2x = 20% faster). Community plays and ranks maps at rates; a rate copy is a separate map with a separate difficulty. |
| DT / NC | Double Time / Nightcore = **1.5x** (NC also raises pitch). |
| HT / DC | Half Time / Daycore = **0.75x**. In osu!lazer the speed_change setting of the mod overrides these defaults. |
| Scroll speed | Visual note speed. osu!mania scales scroll speed by the map's **dominant BPM**, so maps with several BPMs use green lines (SV) to keep the visual speed constant (section 7). |
| OD / HP | OverallDifficulty and HPDrainRate in `[Difficulty]`. Rate copies can override them. |
| Accuracy | Per-play score percentage; mania-tracker stores accuracy and rate per play. Exact judgement windows and accuracy formulas are **not covered here**; check the osu! wiki. |
| MSD | Etterna's MinaCalc difficulty number per skillset (section 3). |
| Dan | A difficulty level named after dan courses (section 2). |

## 2. Dans

### 2.1 Numeric scale

The scale used by Lunacy mania, LeoBlack's benchmark and (via labels) mania-tracker:

| Value | Name | Value | Name |
|---|---|---|---|
| 1-10 | Dan 1 ... Dan 10 (numbered dans; the "Reform" courses) | 16 | Zeta |
| 11 | Alpha | 17 | Eta |
| 12 | Beta | 18 | Theta |
| 13 | Gamma | 19 | Iota |
| 14 | Delta | 20 | Kappa |
| 15 | Epsilon | | |

- Values `< 0.5` are "below dan 1"; values `>= 20.5` are "above Kappa". Since 0.9.2 the app shows "above Kappa" with the number ("выше Kappa · 21.3" / "above Kappa · 21.3"); where the number already stands beside the label (the card, the rate ladder, "{label} ({dan})") the label is just "above Kappa". Values are never clamped for display; only the pickers and targets stop at Kappa high (20.4). mania-tracker's history marks a snapshot past its table with `beyondTable: true` (its last label is `kappa++`); that reads "above Kappa" too, the dan keeping its number.
- **There is no Omega level.** The READMEs once said "Alpha...Omega" (fixed in 0.9.2), but the code, tests and tracker-label parser stop at Kappa (20); "omega" is explicitly rejected.
- A value like 12.8 means "Gamma (13) minus 0.2".

### 2.2 Step labels

Each dan D covers D-0.5 .. D+0.5, split into five 0.2-wide steps by the offset `n - round(n)` (rounded to 1e-6 to avoid float artefacts). **Step boundaries inside a dan belong to the lower step** (12.7 = low, 12.9 = low/mid). At an exact .5 the tools differ: Lunacy mania uses JavaScript `Math.round` (13.5 -> 14 -> Delta low), while mania-tracker puts 13.5 in `gamma++`.

| Offset | Lunacy mania label | LeoBlack / Companella text | +/- notation (Companella, mania-tracker) | Step centre |
|---|---|---|---|---|
| <= -0.3 | low | low | `--` | -0.4 |
| <= -0.1 | low/mid | **mid/low** | `-` | -0.2 |
| <= 0.1 | mid | mid | (none) | 0 |
| <= 0.3 | mid/high | mid/high | `+` | +0.2 |
| otherwise | high | high | `++` | +0.4 |

Examples: 12.7 = Gamma low, 12.8 = Gamma low/mid, 13.0 = Gamma mid, 13.2 = Gamma mid/high, 13.31 = Gamma high, 7.8 = "8 low/mid", 10.6 = Alpha low. Tracker examples: `delta--` = 13.6, `10++` = 10.4, `kappa` = 20, 13.5 = `gamma++`, 13.7 = `delta--`, 13.9 = `delta-`.

**Compare labels by number, never by text** (the second step is spelled "low/mid" in one tool and "mid/low" in another).

### 2.3 Dan courses and table names

- **Dan Reform** is the community dan course series. In LeoBlack's 4K RC table: `Intro 1..3` = numeric -2..0, `Reform 1..10` = 1..10, then Alpha, Beta, Gamma, Delta, Epsilon, `Emik Zeta`, `Thaumiel Eta`, `CloverWisp Theta` (= 11..18). The prefixes are names of the makers of those Zeta/Eta/Theta courses; Lunacy mania shows short names without "Reform" or the prefixes.
- The table ends at **CloverWisp Theta high** (Sunny star 11.019-11.129). Iota and Kappa exist on the numeric scale but have no star band there.
- Reference packs mentioned in the project notes: "Dan Reform Conglomeration v2.2" (a large archive of Reform course .osz), an archive.org dan archive (Reform, Shoegazer, Luminal, Tachyon, Celestial, Signicial, Cyclone of Jack), and EtternaOnline "Thumb Dan" / dan-convert packs (MSD 11-40; .sm conversions of osu!mania dan ladders).

### 2.4 Sunny star -> dan bands (4K RC table, examples)

| Label | Sunny ★ band |
|---|---|
| Reform 1 mid | 3.253-3.346 |
| Reform 5 mid | 4.883-4.972 |
| Reform 10 mid | 6.560-6.616 |
| Alpha low / mid | 6.666-6.691 / 6.716-6.773 |
| Beta low | 6.947-7.034 |
| Gamma low / mid | 7.410-7.509 / 7.607-7.705 |
| Delta mid | 8.098-8.244 |
| Epsilon mid/low | 8.825-9.019 |
| Zeta low | 9.398-9.511 |
| Theta mid | 10.799-10.909 |

Bands are narrow and irregular (Reform 2 mid/high is 3.701-3.708, almost empty) because they are fitted to real course charts, so **star -> dan is steep and non-linear above ~6.5 star**: a 0.05 star difference can flip a label. There is also an "extended" table (`4k-rc-ext.js`) and LN tables (`4k-ln.js`).

## 3. Calculators

### 3.1 Overview

| Calculator | Type | Range | Bias (benchmark) | MAE (out-of-fold / clean) | Notes |
|---|---|---|---|---|---|
| **Sunny** | Star rating (osu!mania SR rework by Sunnyxxy) | any | +0.525 | 0.558 / 0.496 | A star, not a dan; dan comes from the table lookup. Worst dan predictor overall but **best on course/marathon maps (0.26)**. |
| **Daniel** | Sunny-like star -> dan via a means table | 11-18 only | -0.351 (underrates) | 0.421 / 0.378 | Star means: Alpha 6.562, Beta 6.957, Gamma 7.459, Delta 7.939, Epsilon 9.095, Zeta 9.473, Eta 10.162, Theta 10.782; boundaries = midpoints. Below Alpha: "< Alpha Low" (no number); above Theta: "> CloverWisp Theta High". Falls back to Sunny for non-4K. |
| **Azusa** | Hand-built feature model + calibration | whole scale | ~0 | 0.257 / 0.173 | Skill weights speed 0.36, stamina 0.24, chord 0.12, tech 0.16, jack 0.12; decay windows 140/280/560/980 ms; length exponent 0.22. RC only (LN ratio limit 0.18, min 80 notes). **Tuned on the benchmark.** |
| **Roxy** | Structural model for high dans | 11 to <17 | +0.019 | 0.211 (1104 maps) / 0.186 | Streams: speed .22, handStream .18, jack .16, chordjack .16, tech .12, stamina .11, course .05. Below Alpha "< Alpha Low", from 17 up "> Emik Zeta high", both **null**. RC only. |
| **Companella** | ONNX regression | 1-20 (+1 shift) | +0.223 (overrates) | 0.427 / 0.308 | Inputs: MSD Overall + 7 skillsets, Interlude star, Sunny star. Missing any input -> null. Designed for the low band; worst on tech (0.47). |
| **Mixed** (LeoBlack) | Router over the others | whole scale | +0.013 | 0.240 / 0.183 | The baseline; mania-tracker uses it. |
| **ISOR** | (another estimator in the benchmark) | | -0.008 | 0.258 / 0.225 | |
| **Polaris** | Sunny table + fitted correction | **7K only** | | | For 4K/6K/10K it silently falls back to plain Sunny. Not part of the 4K Overall. |
| **Overall** (Lunacy mania, variant M) | Mean of Mixed and Azusa | whole scale | +0.001 | 0.240 / **0.168** | 98% within +/-1 level out-of-fold. |

### 3.2 How Mixed routes (4K RC)

1. Try **Roxy** (if it returns a number, i.e. 11 <= dan < 17).
2. Switch to **Azusa** when a disagreement rule fires: balanced hand bias with Azusa >= +0.4 higher; anchor-heavy chart with Azusa <= -0.7 lower; or the crossing rule (Roxy >= 11 while Azusa < 11).
3. Roxy out of scope -> Azusa; if Sunny star < 9 and Azusa < 11, fuse **Azusa + Companella 50/50**.
4. Azusa fails -> **Daniel**.
5. Mix (LN) charts: RC part uses Azusa+Companella below Sunny star 9, Daniel above; RC||LN split when LN ratio >= 0.15. 7K uses Polaris. Mixed considers Azusa over Roxy only when there is no IN (inverse) conversion flag and no explicit OD override.

### 3.3 Marathon duration correction (Azusa/Roxy, optional)

Structure-based calculators over-rate long maps, so (idea from Dan-Overlay) a correction applies only when **drain time > 300 s AND the skill profile is balanced** (max of 4 aggregated MSD skills / total < 0.45, so real marathon-jack maps are not punished). Correction = `min(0.50, 0.40*ln(1+excessMinutes))` dan, full at dan <= 10, tapering to zero at dan 16, and it only ever lowers the value. Aggregation: jack = max(JackSpeed, Chordjack), stream = max(Stream, Jumpstream), tech = Technical, endurance = 0.7*Stamina + 0.3*Handstream.

### 3.4 Lunacy mania's Overall and its confidence

- **Formula:** Overall = mean of Mixed and Azusa (whichever are available); if neither, the first available of Roxy, Daniel, Companella. Rounded to 0.1, and the label is derived from the rounded number so number and label always agree. It beat a gradient-boosted model (variant A) and a ridge regression (variant B) on the clean held-out set.
- **Confidence** is a lookup on calculator disagreement, not a model output. Spread = max-min of available dan calculators (Daniel, Azusa, Roxy, Companella, Mixed), 4 bins with edges 0.43, 0.61, 0.83; half widths 0.39, 0.345, 0.32, 0.394 (80th percentile of out-of-fold error per bin). Unknown range -> last bin; fallback estimator used -> half width doubled. Level: <= 0.35 high, <= 0.7 medium, else low. The UI shows "+/- halfWidth".
- **Honest reading:** the half widths are nearly flat, so confidence mostly says whether a fallback was used. The gain over plain Mixed is tiny (0.240 vs 0.240 out-of-fold); the variant was selected on the same clean set it is reported on, so the clean-set gain may be slightly overstated.

### 3.5 Benchmark

- Ground truth: LeoBlack's **VSRG-DanEstimation-Benchmark** (`samples/data.csv`, ~1350 4K maps with a hand-labelled expected dan on the numeric scale and a type: course/jack/speed/stamina/tech/ln). About 1245 labelled 4K rice maps were used, including rate copies.
- Rate copies are separate rows (file names carry the rate, e.g. x1.35, and the .osu are already sped up), so evaluation uses **5-fold GroupKFold split by song**; otherwise results leak.
- Clean set: 576 maps added after Azusa/Roxy/Mixed were tuned; mostly an imported "delta table", so biased to Delta.
- MAE by map type (out-of-fold): course is hardest for every dan calculator (Overall 0.50, Mixed 0.47, Roxy 0.40, Daniel 0.68, Companella 0.66) while Sunny is 0.26 there; jack 0.23 for Overall.
- Benchmark maps are copyrighted and stay out of the app; only model weights ship.

### 3.6 Why calculators disagree

1. **Table vs structure:** Sunny/Daniel push one star number through a steep, irregular table, so small star differences flip labels. Daniel (-0.35), Companella (+0.22) and Sunny (+0.53) have systematic biases; Azusa, Mixed and Roxy are near zero on their own benchmark.
2. **Coverage:** Roxy answers only 11-17, Daniel only 11-18, Companella/Azusa the whole range, so which calculators exist changes with difficulty. Below Alpha only Azusa, Companella and Mixed are valid.
3. **Benchmark tuning:** Azusa/Roxy/Mixed were fitted to the same labels, so they agree with each other more than with independent calculators.
4. **Map type:** course/marathon maps (endurance under-modelled) give the largest errors; tech/uneven-rhythm maps are hard for MSD-fed models (Daniel and Companella tech MAE 0.47).
5. **Options:** LN content, OD and conversion flags change routing.

Tell users: a one-level disagreement between calculators is normal; prefer Overall/Mixed for rice and look at Sunny when the map is a long course.

### 3.7 MSD (MinaCalc) and Sunny ★

- **MSD** = Etterna's MinaCalc, compiled to WASM. Builds: 0.68.0-Unofficial, 0.70.0, 0.72.0, 0.72.3 (default), 0.74.0, 0.75.0. Keycounts 4-18; non-4K is pinned to 0.74.0. MSD takes the music rate and a score goal, so it responds to rate.
- **Skillsets (7 + Overall):** Stream, Jumpstream, Handstream, Stamina, JackSpeed, Chordjack, Technical, Overall.
- The vendored builds carry an "MSD cap patch"; the cap value inside the binary was not verified, and EtternaOnline pack metadata tops out around MSD 40. Treat very high MSD on extreme charts with caution.
- **MSD and dan are different scales.** Recommendation goals (relative to the player): comfort = dan [-0.6, -0.1] / MSD -1.0; growth = [0, +0.5] / +0.75; challenge = [+0.5, +1.2] / +2.0.
- **JackSpeed MSD is not comparable to the player's jack dan:** a player's JackSpeed rating sits about 7 below the MSD of jack charts at their own jack dan, so jack picks rank by dan only.
- **Sunny ★** is shown as a plain star with 2 decimals; it never enters the dan-spread statistics.
- **Interlude star** (from the Interlude/YAVSRG model) is an extra input feature; Companella needs MSD + Interlude + Sunny together.

## 4. Patterns (4K rice)

### 4.1 Families and sub-patterns

The project's pattern guide uses six families. "Level 1-3" in the guide is a learning-difficulty tag, not a calculator rating.

**Stream** (skillsets Stream, Stamina): single notes only, no chords, same column never twice in a row. Most beginner dans are stream.
- Rolls: columns in order one way (1-2-3-4 or 4-3-2-1).
- Trills: long alternation of two columns (1-2-1-2).
- Minitrills: A-B-A, then the flow moves on.
- Running man: one column every other note while the others run around it (an anchor made of singles).

**Jumpstream** (Jumpstream, Stamina, Technical): stream with jumps mixed in (usually every other row or so), no hands. The most common family in rice.
- Jumptrill: `[12][34][12]...`, jumps alternating between hands.
- Split trill: alternating jumps using one finger of each hand: `[13]/[24]` or `[14]/[23]`.
- Anchor: one column about every other row, never twice in a row (also common in handstream).
- Dumpstream: a staircase of notes and jumps in one direction (rolls with jumps inside).

**Handstream**: stream mixing hands, jumps and singles; denser and heavier than jumpstream.
- Chord trills: a hand alternating with the left-out note (`[123] 4 [123] 4`).
- Dense handstream: a hand about every third row, jumps between, few singles (level 3).
- Jumpy handstream: more jumps than hands, singles between chords.

**Chordjack**: chords row after row, each new chord repeating at least one column of the previous one. Played from the wrist.
- Handjack: hands in a row, each repeating two columns of the one before (level 3).
- Jumpjack: the same jump hit 2+ times, then moves.
- Quadhand: quads mixed with hands, a jack in every row.
- Quadstream: a quad, a short single-note stream, a quad again (tagged Handstream + Chordjack).
- Gluts: jumps sliding one column per row sharing a note: `[12][23][34]` (Chordjack + JackSpeed).

**Jack** (JackSpeed): one column or chord hit several times in a row. Jack speed = how fast one finger can release and re-press.
- Minijacks: exactly twice, then moves (level 1, the entry point).
- Longjacks: one column for many rows while other notes change around it (JackSpeed + Stamina).
- Speedjacks: fast 2-4 note jacks on one column, then a move (level 3).

**Tech** (Technical): uneven rhythm, mixed snaps (1/3, 1/6, 1/8), hands doing different things; hard to sight-read.
- Coordination: one hand trills evenly while the other plays its own line.
- Jacky stream: stream with a minijack every few notes (the guide lists it with Stream; the map generator files it under Tech; trains Stream + JackSpeed).

**Extras (not families):** grace notes/flams (two notes almost together, one slightly earlier); bursts (a short very dense run inside a calm part); polyrhythm (hands in different rhythms, e.g. 4 against 3); quadjack (a quad hit several times in a row); **stamina** (a length property, not a shape).

### 4.2 Cross-family occurrences

| Pattern | Shows up in / trains |
|---|---|
| Anchor | Jumpstream and Handstream |
| Running man | Stream (anchor made of singles) |
| Jacky stream | Listed with Stream in the guide, Tech in the generator; trains Stream + JackSpeed |
| Quadstream | Handstream + Chordjack |
| Gluts | Chordjack family in the guide, trains Chordjack + JackSpeed; the finder-to-family table in the code (analysis strip and generator) maps it to jack |
| Longjacks | JackSpeed + Stamina |
| Chordjack/handstream boundary | Same chord density; chordjack repeats columns, handstream avoids jacks |

Pattern -> MSD skillset -> mania-tracker dan tile: stream -> Stream -> speed; jumpstream -> Jumpstream -> stamina; handstream -> Handstream -> stamina; stamina -> Stamina -> stamina; chordjack -> Chordjack -> jack; jack -> JackSpeed -> jack; tech -> Technical -> tech.

### 4.3 How to train (guide's advice)

- Suggested order: simple stream at low BPM -> trills and rolls -> jumps/jumpstream -> minijacks -> anchors and handstream -> chordjack and longjacks -> tech/grace/polyrhythm -> stamina gradually.
- Get confident in jumpstream before handstream.
- Chordjack: play from the wrist and release keys fully between chords, or the next note will not register.
- Tech: listen to the music; practice hard sections at a lower rate.
- Use rates to fine-tune difficulty: "growth" maps sit 0 to +0.5 dan above the player's tile dan, "comfort" -0.6 to -0.1, "challenge" +0.5 to +1.2.

### 4.4 Tech tag rule (Lunacy mania)

A map is tagged Tech only if its most important pattern cluster has uneven ("Mixed") rhythm **and** MSD Technical >= **0.83** x the highest of the 7 skillsets. (The design doc and a code default say ~0.93; the shipped trained value is 0.83.) It tags 69% of benchmark tech maps and 3% of speed/stamina maps (F1 0.76). Purpose: not every floating-BPM stream is tech.

## 5. LeoBlack / Interlude pattern finder: quirks

**How it works:** the chart becomes rows (Notes, Jacks = columns repeated from the previous row, Direction, Roll, MsPerBeat = 4 x row gap). A window slides one row at a time over six core patterns: Stream, Chordstream, Jacks, Coordination, Density, Wildcard (the last three need LNs). Core matches get keymode-specific names. Spans are clustered by BPM (merged within 5 ms per beat) and ranked by Importance = Amount x RatingMultiplier x BPM.

**4K names:**

| Core | Specific names (4K) |
|---|---|
| Stream | Rolls (3 single rows in one direction), Trills (4 rows alternating two column sets), Minitrills (A-B-A then something else) |
| Chordstream | Handstream (a 3-note row, then 3 more jack-free rows), Split Trill (3 jumps in a row, no jacks, no roll), Jumptrill (4 jumps, rolled each time), Jumpstream (a jump, a single, then 2 jack-free rows, none with 3+ notes) |
| Jacks | Longjacks (one column in 5 consecutive rows), Quadstream (a quad, any row, then 2 jack-free rows), Gluts, Chordjacks (3+ note chord followed by a row repeating columns), Minijacks (a jack row followed by a non-jack row) |

**Quirks:**
- **Core gates:** Stream needs 5 single-note jack-free rows with first column != fifth. Chordstream needs a chord row then 3 jack-free rows, at least one more of them a chord. **Jacks fires only when 2+ columns repeat** (Jacks > 1) and MsPerBeat < 2000. A single-column jack is not a Jacks match at all, and a stream with a jack in it drops out of Stream/Chordstream.
- **Winner-take-all label:** detection is multi-label per window, but the chart label is the top cluster's most common name (if its share > 5%). The only blend is "Jumpstream/Handstream" (second name Handstream with share > 40% of Jumpstream's). Secondary clusters count only above 50% of the first's importance. A chart that is 60% jumpstream and 40% jacks reads as "Jumpstream"; use the cluster list, not the label.
- **Tech is only an instability flag:** spans whose beat length varies by >= 5 ms are "Mixed" ("~BPM Mixed X"), and " Tech" is appended when the top cluster is Mixed.
- **Not detected as names:** Anchor, Running man, Dumpstream, Chord trills, Handjack, Jumpjack, Speedjacks, grace notes, bursts, polyrhythm.
- **7K/other-only names** never appear in 4K: Brackets, Double Stream, Dense/Light Chordstream, Chord Rolls, DS/DCS/LCS Density. **LN-only names:** Column Lock, Release, Shield, JS/HS/DS/DCS/LCS Density, Inverse, Jacky WC, Speedy WC.
- **Mode tag** from LN ratio: <= 15% RC (rice), >= 90% LN, else Mix, or HB (hybrid) if >= 10% of rows mix LN heads and normal notes. For RC the LN cores are filtered out.
- **Family mapping in Lunacy mania:** Stream/Rolls/Trills/Minitrills -> stream; Jumpstream/Chordstream/Split Trill/Jumptrill -> jumpstream; Handstream -> handstream; Chordjacks/Quadstream -> chordjack; Jacks/Minijacks/Longjacks/Gluts -> jack; tech from the tech flag.

## 6. Rates and difficulty

- Conventions: DT/NC 1.5x, HT/DC 0.75x. Tools allow 0.5-2.0 in 0.01 steps (auto-marathon uses 0.05).
- Analysing a rate = re-analysing the sped-up chart: BPM shown = dominant BPM x rate, duration = length / rate. **The 4K Overall has no separate rate correction.**
- Test-verified: a faster rate raises Mixed, Sunny star and MSD Overall on the same chart; DT turns 160 BPM into 240 BPM and raises Sunny star.
- **The effect is map-dependent and not perfectly monotonic.** Finding "the rate for dan X" assumes dan grows with rate (binary search over a grid, max 10 tries, ties go to the rate nearer 1.0), but keeps the best of all probes because real curves jitter.
- Polaris's fitted 7K data show how level-dependent the DT (1.5x vs 1.0x) increment is: about 0 below level ~3, about 0.44-0.68 around levels 3.75-5.25, peaking at about 1.06-1.17 around levels 7.75-9.25, then falling to about 0.19 at 13.25. HT effects were small and inconsistent, so Polaris leaves rates < 1.0 uncorrected. This is 7K data; treat it only as an illustration that a rate does not add a fixed number of dans.
- Practical rule for answers: never say "+0.1x = +N dan" as a constant; re-analyse the rated chart or use a dan-by-rate ladder.
- mania-tracker rate suggestion (Lunacy mania): analyse at 1.0x, search 0.75-1.6 (0.05 steps) for the rate where `ours(r) - ours(1) ~ centre - trackerDan`; within 0.1 the map is already on target. The shown label is anchored on the tracker's dan plus our shift.

## 7. Files and game

### 7.1 `.osu` essentials for mania

- Header `osu file format v14`; `[General]` has `Mode: 3`, `AudioFilename` (relative to the chart's folder), `PreviewTime` (ms; -1 = none). Generated files use CRLF.
- Key count = `[Difficulty] CircleSize` (4 for 4K); read as round(CircleSize).
- **Lane from x:** `column = floor(x * keys / 512)`, clamped. To write lane c: `x = floor((c + 0.5) * 512 / keys)`. 4K lane centres: **64, 192, 320, 448**. y is irrelevant (192 by convention).
- Hit objects: `x,y,time,type,hitSound,extras`. Tap: `x,192,time,1,0,0:0:0:0:`. Hold: type bit **128**, end time is the **first** colon field of extras: `x,192,start,128,0,end:0:0:0:0:`. Hold -> tap: `type=(t & ~128)|1` and drop the first extras field.
- Timing points: `time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects`. Red (uninherited=1): beatLength = ms per beat (BPM = 60000/beatLength). Green (0): negative SV percentage (-100 = 1.0x, -50 = 2x).
- Multi-BPM songs: after each red line add a green line with `SV = -100*bpm/mainBpm`, where mainBpm = the BPM that lasts longest between first and last note, so scroll speed stays constant.
- Breaks: `[Events]` `2,startMs,endMs`; osu! ignores breaks shorter than ~650 ms.
- `[Metadata]`: Title, TitleUnicode, Artist, ArtistUnicode, Creator, Version (diff name), Source, Tags (space-separated), BeatmapID, BeatmapSetID. Local maps: BeatmapID 0, BeatmapSetID -1. Read keys with a whitespace-tolerant exact-key regex like `/^Key\s*:\s*(.*)$/m`.
- Editor `BeatDivisor`: 12 if 1/3 or 1/6 are used, 8 for 1/8, else 4 (display only).

### 7.2 `.osz`

- A plain zip: one .osu per difficulty, audio, optional background; names relative to the set root. Stored (uncompressed) entries with UTF-8 names (flag bit 11) are accepted by osu!.
- Reading pitfalls: find the End Of Central Directory by scanning the last 22+65535 bytes; **some packers write a wrong central-directory offset** (real start = eocd - cdSize; shift all local offsets); treat names as UTF-8 even without the flag (fallback CP437); support stored (0) and deflate (8); cap entry sizes; reject absolute paths, drive letters/colons, `..`, NUL.
- Validate downloads: first bytes `PK`, >= 22 bytes. Mirrors sometimes return an HTML or JSON error page with HTTP 200.
- Find a difficulty in a set by BeatmapID, else by file name ending `[Version].osu`.

### 7.3 Rate copies

- Divide by the rate: every note time, LN end, timing point time, red-line beatLength, break, video start, Bookmarks, PreviewTime. **Green-line SV values stay unchanged.** Round times to integer ms; keep beat lengths precise.
- New Version like `<orig> 1.25x (240bpm)` plus suffixes ` NC`, ` Mirror`, ` NoLN`; BeatmapID reset to 0; file `Artist - Title (Creator) [Version].osu`.
- Audio with ffmpeg: keep pitch `atempo=<rate>` (each stage 0.5..100, chain for lower); nightcore `asetrate=<sr*rate>,aresample=<sr>`; MP3 via libmp3lame `-q:a 2`.
- Optional transforms: mirror (lane c -> keys-1-c), NoLN (holds -> taps).

### 7.4 Marathons / dan courses

- One chart: map, gap, map, gap... Each map cut from 2000 ms before its first note to 1000 ms after its last note, at its own rate; default gap 10000 ms becomes a break.
- Keep each map's beat grid exact: move the active red line forward to its first beat inside the cut and re-emit it with beatLength/rate.
- Audio: one ffmpeg filter_complex per segment (`atrim`, rate filter, `aresample=44100`, pad/trim to the exact sample count `round(cutMs/rate/1000*44100)` so nothing drifts), silence between, concat.
- Output `.osz`: `<title>.osu`, `audio.mp3`, `bg.png`; Mode 3, CircleSize 4, OD 8 / HP 8 by default.

### 7.5 Collections (`collection.db`, osu! stable)

Int32 version (20150203 written), Int32 count; per collection: osu-string name, Int32 count, then osu-string MD5s. osu-string = `0x0b` + ULEB128 byte length + UTF-8 bytes; empty = `0x00`. Little-endian. Reject trailing bytes and truncation. The MD5 is of the raw .osu bytes (fetchable from `https://osu.ppy.sh/osu/<beatmapId>`). Write to a separate file and let the user copy it into osu! themselves (back up the original first).

### 7.6 tosu

- Separate open-source program (LGPL-3.0) that reads osu! stable's memory **read-only** and serves game state on local HTTP/WebSocket. Needs osu! running (`/json/v2` answers 500 otherwise).
- Lunacy mania runs a pinned v4.26.3 on `127.0.0.1:24077`, configured by `tosu.env` next to `tosu.exe` (dashboard, autoupdate, pp, in-game overlay off).
- **tosu refuses to start from `%TEMP%`** (where portable Electron apps unpack), so copy it elsewhere.
- Used fields: WebSocket `ws://127.0.0.1:<port>/websocket/v2`: `state.number` (0 menu, 2 playing, 5 song select, 7 results), `beatmap.checksum`, `play.mods` (`.array`, `.name`, `.rate`; in song select it shows the menu mods). HTTP `/json/v2`: `folders.songs`, `directPath.beatmapFile`, `profile`; `/files/beatmap/file` returns the current .osu. Field names come from this app's code; verify against your tosu version.
- Rate from mods: trust `play.mods.rate` when > 0 (unless it says 1 with DT present); else DT/NC 1.5, HT/DC 0.75.

### 7.7 Safe practices and Windows pitfalls

- **Prefer not to write into osu!'s `Songs` folder.** Write outputs elsewhere and **open the `.osz` with the OS** so osu! imports it. If you do write into Songs (rate copies next to the original), osu! needs a rescan to show them.
- Open maps: `osu://b/<beatmapId>` (osu!direct, needs supporter) or `https://osu.ppy.sh/beatmaps/<id>`. Build URLs from numeric ids only.
- **MAX_PATH ~260:** keep full paths within ~240 chars; shorten the stem before adding ` (n)` suffixes; rename over-long audio and update `AudioFilename`.
- Invalid file-name characters: `<>:"/\|?*` and control chars -> `_`; trim trailing dots/spaces; cap name parts. Cyrillic is fine as UTF-8. Pass paths to ffmpeg as arguments (no shell quoting).
- Use Windows' own `System32\tar.exe` (bsdtar) for .zip and RAR/RAR5; Git Bash's GNU tar treats `C:` as a remote host. A .rar whose last member is a stored .osz can be misread as that zip; appending 128 KiB of zeros fixes it.
- StepMania text: decode UTF-8 (strip BOM), else Shift-JIS, else Windows-1252.
- Treat downloaded archives as untrusted: never execute anything from them; read only chart text and audio.

## 8. mania-tracker API and beatmap mirrors

### 8.1 mania-tracker (`https://api.mania-tracker.com`)

No auth; plain GET, `Accept: application/json`, ~15 s timeout.

| Endpoint | Returns |
|---|---|
| `/api/users/search?q=<name>` | `users[]` (id, username, avatarUrl). Exact case-insensitive match wins; all-digit query with no match = osu! user id. |
| `/api/profiles/<id>/skills` | `status` ("ready"), `tracked`, `modes[]` with `keyCount`, `analyzedPlays`, `ratings` (MSD per skillset), `dan.rc.rawDan`, `dan.rc.skillsets.{speed,stamina,tech,jack}.rawDan` |
| `/api/profiles/<id>/skill-plays?keys=4&axis=<A>&limit=200&offset=0&rejected=1` | **Top 200 plays per axis only** (items[] + rejected[]: beatmapId, beatmapsetId, accuracy, rate, playedAt) |
| `/api/snapshots/maps-search` | Map search (below) |
| `/api/profiles/<id>/recent` | About the last 70 scores |
| `/api/profiles/<id>/skill-history?keys=4&before=<cursor>` | 25 snapshots per page, newest first |

- `rc` = the rice dan scale. Player dan for a pattern = tile rawDan, else overall rc rawDan. "Not ready" = not computed yet / no 4K / not tracked (the player adds themselves on the site).
- To know what a player has played, query all 8 axes (Stream, Jumpstream, Handstream, Stamina, JackSpeed, Chordjack, Technical, Overall) and merge; still best-effort.
- **maps-search params:** `sort=playcount`, `dir=desc`, `page` (0-based), `pageSize=48` (max), `keys=4k`, `patterns=<id>`, `vibro=hide`, `lnMax=15`, `danMin/danMinStep/danMax/danMaxStep`, `lenMin/lenMax` (s), `statuses=ranked,loved`. Response: items[] per set with diffs[], total, page, pageSize; covers only on the set item.
- **Diff fields:** beatmapId, beatmapsetId, title, artist, creator, version, status, stars, bpm, length, playCount, lnShare, keyCount, primaryPattern, patterns{jack,stream,jumpstream,handstream,stamina,chordjack,tech,ln} (0..1), dan{label,rawDan}, msd{7 skillsets + Overall}.
- **Dan filter arithmetic:** the server filters whole steps; `danBound(x)`: `dan = ceil(x-0.5-1e-9)`, `step = clamp(ceil((x-dan+0.5)/0.2-1e-9)-3, -2, 2)`; trim exactly on rawDan client-side.
- **Do not trust `vibro=hide` alone** (many vibro packs are marked false); also drop names matching `/vibro/i`. Check `lnShare <= 0.15` client-side too.

**Polite use:** cache responses (search results 60 s, matching the server's `Cache-Control: max-age=60`); share identical in-flight requests; on HTTP 429 honour `Retry-After` (else `retryAfterMs`, else 5 s) and retry once only for short waits; for bulk crawling sleep ~1200 ms between search pages and stop on an empty or short page. Every request counts toward the rate limit. A search page is ~0.15 MB.

### 8.2 Beatmap mirrors (status observed 2026-10-25; re-check)

| Mirror | URL | Notes |
|---|---|---|
| osu.direct | `https://osu.direct/api/d/<setId>` | ~10 MB/s; **daily budget 200 sets / 8 GB per IP**, headers `x-download-budget-remaining` / `x-download-budget-reset` (unix seconds), resets 00:00 UTC. A 429 with remaining=0 means wait for the reset, not retry. |
| beatconnect.io | `https://beatconnect.io/b/<setId>/` | Rate-limits; was refusing at times |
| dl.sayobot.cn | `https://dl.sayobot.cn/beatmaps/download/novideo/<setId>` | Unlimited but ~0.3-0.8 MB/s per connection |
| catboy.best / nerinyan | | 403 / 404 when tested; not used |

- Try mirrors in order; give up on one that sends nothing for 30 s; cap at 200 MB; reject non-zip bodies; reuse files already on disk.
- `https://osu.ppy.sh/osu/<beatmapId>` returns the raw .osu without auth, but an **empty 200 for deleted maps**: check for `[HitObjects]`.
- Bulk downloading: a few parallel lanes with pauses, an identifying User-Agent, per-pack state files so re-runs skip finished work.

## 9. Map generation lessons and training data

### 9.1 Timing detection

- Global BPM: search 60-260 BPM (0.5 steps) scoring Fourier magnitude x autocorrelation x a log-normal prior centred on 150 BPM; refine +/-0.6 in 0.01 steps; snap to a whole BPM within 0.15.
- **Octave errors (x2, x0.5) are the classic failure.** The sectioned detector runs a Viterbi pass over 40-400 BPM on 10 s windows every 2.5 s with a cost for any change (4) and an extra cost for octave jumps (3). A double-time hi-hat track must not split the BPM. Targets: false splits on single-BPM songs <= 2%, correct section count on multi-BPM songs >= 80%.
- Take the beat phase from the kick (low band) when it has its own beat; off-beat hi-hats pull the phase half a beat.
- Round section BPM to whole, then .1, then .01 only if the grid drifts < 3 ms over the section.
- **Human red lines sit ~23 ms before the attacks the detector finds** (`OFFSET_BIAS_MS = -23`, fitted on 157 held-out maps, Chromium decode at 22050 Hz). This bias is decoder- and detector-specific: refit it for your pipeline.
- Fine onsets: compare energy in ~1.5 ms after vs ~23 ms before each moment on the sample-to-sample difference (so bass swells do not look like attacks).

### 9.2 Snaps

- Grids 1/4, 1/3, 1/6, 1/8 (1/12 and 1/16 left off-grid). Corpus divisor histogram: 84.6 / 3.4 / 2.8 / 8.0 % (1/4, 1/3, 1/6, 1/8).
- Audio-based rule: a beat gets a non-1/4 grid only if that grid's evidence is > 1.5x the 1/4 evidence and above a noise floor; median-filter over 3 beats; a triplet run must last >= 2 beats. Swing and bad timing cause triplet false positives.
- **Lesson:** a 1/4-only generator collapsed Minitrill/Rolls-heavy songs at ~117-170 BPM with high dan targets to ~2.6 dan (7 of 30 test maps), because 1/6-1/8 trills cannot be expressed.

### 9.3 Playability rules (generator limits)

| Family | Max same-column run (rows) | Max anchor share (16-row window) | Min ms between hits on one column |
|---|---|---|---|
| Stream | 2 | 0.5 | 65 |
| Jumpstream | 2 | 0.58 | 65 |
| Handstream | 3 | 0.65 | 65 |
| Tech | 3 | 0.6 | 65 |
| Chordjack | 16 | none | 50 |
| Jack | 24 | none | 50 |

- Keep left-hand share 35-65% (non-jack families, 32-row window) and pull columns toward 25% each over 64 rows.
- Final checks flag over-long jacks in streamy rows, inhuman single-column speed, anchors, an overloaded hand, density spikes (peak ratio 2.2 over >= 8 notes) and uneven columns (ratio 1.3).
- Row recipes: stream never reuses a column of the last two rows (else it reads as trills); chordjack keeps usually 2 columns from the previous row but never holds one for 3 rows (that reads as a longjack); jacks should be two-column so the finder can see them.
- Classifying a stretch from rows: Tech if > 25% of rows are off the 1/4 grid; else jack ratio >= 0.35 -> Chordjack (mean notes/row >= 1.8) or Jack; else >= 25% rows with 3+ notes -> Handstream; else >= 30% with 2+ -> Jumpstream; else Stream.
- Song parts (intro/build/drop/break/outro) from per-bar loudness, onset density and bass with dynamic programming (min 4 bars); drop if energy >= 0.65, break if <= 0.4.

### 9.4 Evaluation lessons

- On 30 held-out maps the rule-based generator vs a learned one: note-timing F1 0.663 vs 0.649, dan hit 13/30 vs 12/30. An earlier 12-song test (12/12 dan hits) was optimistic; trust the harder held-out test.
- Split by song group, never by chart; dedupe rate copies and mirrored charts; quarantine train songs that look like held-out songs (shared audio fingerprint, same title + remix/BPM/length, rate copies under another title).
- Corpus filters: Mode 3, CircleSize 4, >= 100 objects, <= 15% LN, audio present, no vibro, no rate edits (names like `1.2x`, `x1.2`, `(263bpm)`), <= 20% off-grid rows.

### 9.5 Training data sources and their terms (observed 2026-10)

| Source | What | Terms / limits |
|---|---|---|
| EtternaOnline API `https://api.etternaonline.com/api/packs?limit=2000` | ~1731 packs, ~120k 4K charts, per-chart MSD at `/api/packs/{id}/songs` | No auth; keep to ~1 request/s (429 at ~12 parallel). StepMania .sm/.ssc, needs conversion. Licensed audio: private training only. |
| Hugging Face `project-riz/osu-beatmaps` | 213k beatmaps, all modes, .osu + audio (WebDataset tars) | License "osu-terms", **research use only**, do not redistribute |
| Hugging Face `project-riz/osu-beatmap-tags` | metadata.csv (217,263 diffs; playcount, favourites...), tags.csv | Same caution |
| Dan Reform Conglomeration v2.2 | ~1.76 GB of course .osz | Copyrighted maps/audio |
| Malody 4K Converts | .sm conversions binned by MSD | The 38-104 bin is joke charts |
| data.ppy.sh | Charts only, no audio | Restrictive license |

Rules for any training project: ship only model weights (never charts or audio); treat archives as untrusted; skip StepMania charts with warps, fakes, negative stops or BPM > 3000.

**StepMania -> .osu essentials:** only `dance-single` (4 lanes); 48 rows per beat; osu time = (beat time - OFFSET) * 1000; STOP pauses after the notes on its beat, DELAY before; a red line per BPM change/stop/delay; note chars 1 tap, 2 hold head, 4 roll head (both -> holds), 3 tail; lanes 0-3 -> x 64/192/320/448.

## 10. osu! rules (snapshot 2026-10-25; re-check the live wiki)

- **AI-made maps cannot be ranked or loved.** The Ranking Criteria AI policy requires hit objects, hitsounds and timing to come from direct human input with no generative tooling; substantially AI-generated images, videos and songs are banned (ppy/osu-wiki PR #15087, merged 2026-08-13). Loved has no separate rule; NAT/GMT replies say AI maps will not be loved.
- Graveyard/WIP uploads: no rule, but the community norm is to **disclose AI use**. Always tell users to label generated maps as AI-made if they upload them anywhere.
- Local/unsubmitted maps, rate copies and marathons have no leaderboard or pp. Uploading rate copies or marathons of other people's maps needs the mappers' and artists' permission.
- **Third-party tools:** the Rules page prohibits third-party utilities that give an in-game advantage. Read-only memory readers (gosumemory, StreamCompanion) are listed on Community/Projects but not endorsed; tosu is not listed. Tools that only read state and do not play for you are the common case; never suggest anything that automates input.
- The ToS says site content may not be copied or used for derivatives; it says nothing specific about ML or scraping.

## 11. Lunacy mania

**Lunacy mania** (formerly "Sneezey's dan calculator"; the project/repo is **Lunacy mania instrument**) is a small always-on-top Windows window for osu!mania 4K rice players. It reads the selected map from osu! stable through a bundled tosu.

| Tab | What it does |
|---|---|
| Analysis | Dan of the selected map with confidence, main patterns, MSD and Sunny ★; pick the calculator (Overall, Mixed, Daniel, Azusa, Roxy, Companella, or all); difficulty line, patterns by part, "for you", dan-by-rate ladder; DT/HT taken into account |
| Rate | Rate versions (audio with or without pitch), rate for a target dan, batches, mirror, no-LN, presets |
| Marathon | Joins maps into one marathon/dan course .osz; templates, auto-marathon from the skill profile, difficulty curve |
| Picks | Maps for the player's skill from mania-tracker by pattern and goal (comfort/growth/challenge) or a dan range; one-click download, training plan, similar maps, favourites -> collection.db, progress |
| Create map | Generates a 4K rice map from a song (BPM/offset incl. multi-BPM, 1/3 and 1/6 snaps, parts with own dan and patterns, variants, preview, mapsets, rates); can remap a map one dan up or down |

- **Where files go:** `Documents\Lunacy mania` (an older install's existing folder is kept and reused). Marathons, generated maps, downloads and collections go there; finished `.osz` files are opened with the OS so osu! imports them. **Exception:** Rate-tab copies are written next to the original map, i.e. inside osu!'s Songs folder (despite a README line saying it never writes there).
- Downloads: installer `Lunacy-mania-Setup-<version>.exe` (per-user, self-updating) or portable `Lunacy-mania-Portable-<version>.exe`, from the GitHub releases page. Unsigned, so Windows SmartScreen may warn ("More info -> Run anyway").
- Needs Windows 10/11 64-bit and osu! stable. No account, no telemetry; it talks only to mania-tracker, the three mirrors, osu.ppy.sh and GitHub.
- Generated maps are for practice and local play (section 10).
- Interface in Russian and English.

## 12. Gotchas

1. No Omega: the scale ends at Kappa (20); anything higher is "above Kappa", shown with its number ("above Kappa · 21.3").
2. "low/mid" vs "mid/low" vs `-`: compare dan labels numerically.
3. Step boundaries belong to the lower step, but an exact .5 differs between tools: mania-tracker 13.5 = `gamma++`, Lunacy mania 13.5 = Delta low.
4. LeoBlack's 4K RC table stops at CloverWisp Theta high (Sunny ~11.1); no star bands for Iota/Kappa.
5. Roxy and Daniel return null (not 0) outside their ranges; never treat null as 0.
6. Polaris is 7K-only; for 4K it silently equals Sunny.
7. Sunny is a star, not a dan; its table mapping runs high (+0.525), except it is the best on long courses.
8. Benchmark numbers for Azusa/Roxy/Mixed (and anything averaging them) are optimistic: they were tuned on the benchmark.
9. Confidence half widths are nearly flat (0.32-0.39); low confidence mostly means a fallback calculator was used.
10. Tech threshold: 0.83 shipped, not the 0.93 in the design doc.
11. JackSpeed MSD is ~7 below the MSD of jack charts at the player's jack dan; do not compare them directly.
12. The finder labels a chart by its top cluster only and cannot see single-column jacks, anchors or running man.
13. Rate effects are map-dependent and jittery; never apply a fixed "dans per 0.1x".
14. Green-line SV values are not scaled in rate copies; red-line beat lengths are.
15. Rate copies of one song must not straddle train/test splits.
16. `osu.ppy.sh/osu/<id>` returns an empty 200 for deleted maps.
17. Mirrors may return HTML/JSON errors with HTTP 200; check for `PK`.
18. osu.direct 429 can mean the daily budget (200 sets / 8 GB) is used up; wait for 00:00 UTC.
19. mania-tracker `vibro=hide` misses many vibro packs; filter names too. Played data is top-200 per axis only.
20. Some .osz files have a wrong central-directory offset; naive unzippers fail.
21. tosu will not run from `%TEMP%`; needs osu! running.
22. Windows MAX_PATH (~260) breaks osu!, ffmpeg and Python; keep paths under ~240.
23. Git Bash tar misreads `C:`; use `System32\tar.exe`.
24. `OFFSET_BIAS_MS = -23` is specific to one decoder and detector.
25. Mirror status, pack sizes and osu! AI rules are 2026-10 snapshots; re-check.
26. Training data (osu!, Etterna, HF datasets) is copyrighted or research-only; never redistribute charts or audio.

## 13. Sources

**Project files (Lunacy mania instrument repository):**
- Dan scale and labels: `src/core/labels.js`, `tests/labels.test.js`, `src/recommend/progress.js`
- Calculators: `vendor/leoblack/js/estimator/` (`sunnyEstimator.js`, `danielEstimator.js`, `reworkEstimatorUtils.js`, `azusaEstimator.js`, `roxyEstimator.js`, `companellaEstimator.js`, `mixedEstimator.js`, `polarisEstimator.js`, `polarisCorrection.js`, `marathonCorrection.js`, `rcDifficultyFormat.js`, `intervals/4k-rc.js`, `intervals/4k-rc-ext.js`, `intervals/4k-ln.js`)
- MinaCalc: `vendor/leoblack/js/ett/`
- Combined model: `src/core/model.js`, `src/core/features.js`, `src/core/analyze.js`, `src/core/patterns.js`, `src/core/rice.js`, `models/dan_model.json`, `tools/train.py`
- Benchmark: `reports/benchmark.md`; mapper: `reports/mapper.md`
- Pattern finder: `vendor/leoblack/js/patterns/` (`patternsDef.js`, `findPatterns.js`, `clustering.js`, `categorise.js`, `config.js`)
- Recommendations and tracker: `src/recommend/` (`tracker.js`, `skill.js`, `rank.js`, `catalog.js`, `recommend.js`, `similar.js`, `rateFit.js`, `download.js`, `collectionDb.js`)
- Rates and marathons: `src/rate/`, `app/rateCreate.js`, `app/rateAudio.js`, `app/marathonCreate.js`, `app/marathonAudio.js`
- Files: `src/gen/writer.js`, `src/gen/osz.js`, `src/rate/oszRead.js`, `tools/lib/zip.mjs`, `tools/lib/sm2osu.mjs`
- tosu: `app/tosuManager.js`, `app/tosuClient.js`, `tools/fetch-tosu.mjs`
- Generator: `src/gen/` (`playability.js`, `patterns.js`, `mapRows.js`, `snap.js`, `songParts.js`), `src/audio/` (`tempo.js`, `fineOnset.js`, `timingJob.js`)
- Corpus: `tools/corpus-index.mjs`, `tools/fetch-*.mjs`
- Design docs: `docs/2026-10-24-dan-analyzer-design.md`, `docs/2026-10-25-recommendations-design.md` (scoring weights there are outdated; code wins), `docs/2026-10-25-mapgen-v3-plan.md`, `docs/2026-10-25-mapgen-v3-ml-addendum.md`, `README.md`, `docs/for-friends.md`

**URLs:**
- Lunacy mania releases: https://github.com/kibuk12311/lunacy-mania-instrument/releases/latest
- mania-tracker: https://mania-tracker.com (API https://api.mania-tracker.com)
- osu! Ranking Criteria: https://osu.ppy.sh/wiki/en/Ranking_criteria
- osu! map pages and files: `https://osu.ppy.sh/beatmaps/<id>`, `https://osu.ppy.sh/osu/<beatmapId>`; covers: https://assets.ppy.sh
- tosu: https://github.com/tosuapp/tosu
- Mirrors: https://osu.direct, https://beatconnect.io, https://dl.sayobot.cn
- EtternaOnline API: https://api.etternaonline.com/api/packs?limit=2000
- Hugging Face datasets: https://huggingface.co/datasets/project-riz/osu-beatmaps, https://huggingface.co/datasets/project-riz/osu-beatmap-tags
