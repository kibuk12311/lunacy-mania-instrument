namespace Interlude.Features.Play

open Percyqaz.Flux.Audio
open Prelude
open Prelude.Gameplay.Rulesets
open Prelude.Gameplay.Scoring
open Interlude.UI
open Interlude.Features.Gameplay

module FakeRuleset =

    let private j name breaks (w: float32) =
        {
            Name = name
            BreaksCombo = breaks
            TimingWindows =
                if w > 0.0f then
                    Some(-w * 1.0f<ms / rate>, w * 1.0f<ms / rate>)
                else
                    None
        }

    let SC_J4 =
        {
            Name = "SC (J4)"
            Description = "fake"
            Judgements =
                [|
                    j "MARVELLOUS" false 22.5f
                    j "PERFECT" false 45.0f
                    j "GREAT" false 90.0f
                    j "GOOD" true 135.0f
                    j "BAD" true 180.0f
                    j "MISS" true 0.0f
                |]
            Weights = [| 1.0; 0.98; 0.5; 0.0; -0.5; -1.0 |]
        }

type PlayScreen =

    /// Same shape as the real PlayScreen.Create: an object expression inheriting IPlayScreen,
    /// capturing mutable locals (key_state, liveplay_position).
    static member Create(info: LoadedChartInfo) : Screen =
        let first_note = 1000.0f<ms>
        let note_spacing = 50.0f<ms>
        let note_count = 2000
        let keys = info.ChartMeta.Keys

        let scoring =
            ScoreProcessor(FakeRuleset.SC_J4, keys, first_note, note_count, (SelectedChart.rate_setting ()).Value)

        let mutable key_state = Bitmask.Empty
        let mutable liveplay_position = -infinityf * 1.0f<ms>
        let mutable next_note = 0
        let rng = System.Random(1234)

        { new IPlayScreen(info, scoring) with
            override this.OnEnter(previous: ScreenType) : unit =
                Song.SetRate((SelectedChart.rate_setting ()).Value)
                Song.PlayFrom(0.0f<ms>)
                Song.MarkStartOfFrame()
                base.OnEnter(previous)

            override this.Update(elapsed_ms: float) : unit =
                let now = Song.TimeWithOffset
                let chart_time = now - first_note

                // fake input: hit every note that is due, with a deterministic pseudo-random error
                while next_note < note_count
                      && first_note + float32 next_note * note_spacing <= now do
                    let col = next_note % keys
                    let note_time = float32 next_note * note_spacing
                    let missed = next_note % 25 = 24
                    let delta = float32 (rng.NextDouble() * 60.0 - 30.0) * 1.0f<ms / rate>
                    key_state <- key_state.Add(col)
                    this.State.Scoring.SetKeys(key_state)
                    this.State.Scoring.HandleEvent(next_note, note_time, col, delta, missed)
                    next_note <- next_note + 1

                // release keys 25ms after each note
                if next_note > 0
                   && now - (first_note + float32 (next_note - 1) * note_spacing) > 25.0f<ms> then
                    key_state <- Bitmask.Empty
                    this.State.Scoring.SetKeys(key_state)

                liveplay_position <- max liveplay_position chart_time
        }
