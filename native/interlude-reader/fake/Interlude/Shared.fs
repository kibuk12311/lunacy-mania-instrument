namespace Interlude.Features.Play

open Percyqaz.Flux.Audio
open Prelude.Gameplay.Scoring
open Interlude.UI
open Interlude.Features.Gameplay

[<AbstractClass>]
type IPlayScreen(info: LoadedChartInfo, scoring: ScoreProcessor) =
    inherit Screen()

    let state: PlayState = PlayState(info, scoring, Song.get_TimeWithOffset)

    member this.State = state

    override this.OnEnter(_: ScreenType) : unit = ()
    override this.OnExit(_: ScreenType) : unit = ()
