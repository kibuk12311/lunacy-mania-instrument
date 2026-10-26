namespace Interlude.Features.Play

open Prelude
open Prelude.Gameplay.Scoring
open Interlude.Features.Gameplay

type PlayState(info: LoadedChartInfo, scoring: ScoreProcessor, current_time: unit -> Time) =

    let mutable scoring = scoring
    let first_note = scoring.FirstNote

    member this.Info = info
    member this.Scoring = scoring
    member this.CurrentTime() : Time = current_time ()
    member this.CurrentChartTime() : Time = current_time () - first_note
    member this.Rate = this.Scoring.Rate
    member this.ChangeScoring(new_scoring: ScoreProcessor) : unit = scoring <- new_scoring
