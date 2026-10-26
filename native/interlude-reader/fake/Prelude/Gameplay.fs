namespace Prelude.Gameplay.Replays

open Prelude

type ChartTime = float32<ms>

[<AbstractClass>]
type KeyPressReader(keys: int) =

    let mutable current_pressed_keys: Bitmask = Bitmask.Empty

    member this.SetKeys(new_pressed_keys: Bitmask) : unit =
        for k = 0 to keys - 1 do
            if current_pressed_keys.Contains(k) && not(new_pressed_keys.Contains(k)) then
                this.HandleKeyUp(0.0f<ms>, k)
            elif new_pressed_keys.Contains(k) && not(current_pressed_keys.Contains(k)) then
                this.HandleKeyDown(0.0f<ms>, k)

        current_pressed_keys <- new_pressed_keys

    member this.KeyState = current_pressed_keys
    abstract member HandleKeyDown: ChartTime * int -> unit
    abstract member HandleKeyUp: ChartTime * int -> unit

namespace Prelude.Gameplay.Rulesets

open Prelude

type Judgement =
    {
        Name: string
        BreaksCombo: bool
        TimingWindows: (GameplayTime * GameplayTime) option
    }

type Ruleset =
    {
        Name: string
        Description: string
        Judgements: Judgement array
        Weights: float array
    }

namespace Prelude.Gameplay.Scoring

open System.Collections.ObjectModel
open Prelude
open Prelude.Gameplay.Replays
open Prelude.Gameplay.Rulesets

type ScoringEventInner =
    | Hit of {| Delta: GameplayTime; Judgement: (int * float) option; Missed: bool |}
    | Hold of {| Delta: GameplayTime; Judgement: (int * float) option; Missed: bool |}
    | Release of
        {|
            Delta: GameplayTime
            Judgement: (int * float) option
            Missed: bool
            Overhold: bool
            Dropped: bool
        |}
    | DropHold
    | RegrabHold
    | GhostTap of {| Judgement: (int * float) option |}

[<Struct>]
type ComboChange =
    | Increase
    | Break of instead_of_increase: bool
    | NoChange

type ScoringEvent =
    {
        Index: int
        Time: ChartTime
        Column: int
        Inner: ScoringEventInner
        ComboChange: ComboChange
    }

[<AbstractClass>]
type GameplayEventProcessor(ruleset: Ruleset, keys: int, first_note_time: Time, note_count: int, rate: Rate) =
    inherit KeyPressReader(keys)

    let first_note = first_note_time
    let mutable expired_notes_index = 0

    member this.Ruleset = ruleset
    member this.Finished: bool = expired_notes_index = note_count
    member this.FirstNote = first_note
    member this.Expire() = expired_notes_index <- expired_notes_index + 1
    abstract member HandleEvent: int * ChartTime * int * GameplayTime * bool -> unit

type ScoreProcessor(ruleset: Ruleset, keys: int, first_note_time: Time, note_count: int, rate: Rate) =
    inherit GameplayEventProcessor(ruleset, keys, first_note_time, note_count, rate)

    let scoring_events = ResizeArray<ScoringEvent>()

    let on_event_ev = Event<ScoringEvent>()
    let on_event = on_event_ev.Publish

    let judgement_counts = Array.zeroCreate ruleset.Judgements.Length
    let mutable points_scored = 0.0
    let mutable max_possible_points = 0.0

    let mutable current_combo = 0
    let mutable best_combo = 0
    let mutable combo_breaks = 0
    let mutable max_possible_combo = 0

    let break_combo (would_have_increased_combo: bool) =
        if would_have_increased_combo then
            max_possible_combo <- max_possible_combo + 1

        combo_breaks <- combo_breaks + 1
        current_combo <- 0

    let incr_combo () =
        max_possible_combo <- max_possible_combo + 1
        current_combo <- current_combo + 1
        best_combo <- max best_combo current_combo

    let score_points (judgement_points: float, judgement: int) =
        max_possible_points <- max_possible_points + 1.0
        points_scored <- points_scored + judgement_points
        judgement_counts.[judgement] <- judgement_counts.[judgement] + 1

    let ms_to_judgement (delta: GameplayTime) : int =
        let mutable j = 0

        while j + 1 < ruleset.Judgements.Length
              && (
                  match ruleset.Judgements.[j].TimingWindows with
                  | None -> true
                  | Some(early, late) -> delta < early || delta > late
              ) do
            j <- j + 1

        j

    member val Duration: Time = 1000.0f<ms>
    member val JudgementCounts: int array = judgement_counts
    member val Rate: Rate = rate

    member this.Accuracy: float =
        if max_possible_points = 0.0 then 1.0 else points_scored / max_possible_points

    member this.CurrentCombo: int = current_combo
    member this.BestCombo: int = best_combo
    member this.ComboBreaks: int = combo_breaks
    member this.MaxPossibleCombo: int = max_possible_combo
    member this.MaxPossiblePoints: float = max_possible_points
    member this.PointsScored: float = points_scored
    member this.Events: ReadOnlyCollection<ScoringEvent> = scoring_events.AsReadOnly()
    member this.OnEvent: IEvent<ScoringEvent> = on_event

    override this.HandleKeyDown(_, _) = ()
    override this.HandleKeyUp(_, _) = ()

    override this.HandleEvent(index, time, column, delta, is_missed) : unit =
        let judgement =
            if is_missed then ruleset.Judgements.Length - 1 else ms_to_judgement delta

        let points = ruleset.Weights.[judgement]
        score_points(points, judgement)

        let combo_action =
            if ruleset.Judgements.[judgement].BreaksCombo then Break true else Increase

        match combo_action with
        | NoChange -> ()
        | Increase -> incr_combo()
        | Break instead_of_increase -> break_combo instead_of_increase

        let gameplay_event: ScoringEvent =
            {
                Index = index
                Time = time
                Column = column
                Inner = Hit {| Delta = delta; Judgement = Some(judgement, points); Missed = is_missed |}
                ComboChange = combo_action
            }

        scoring_events.Add(gameplay_event)
        this.Expire()
        on_event_ev.Trigger(gameplay_event)
