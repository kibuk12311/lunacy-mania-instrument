namespace Interlude.Features.Gameplay

open Percyqaz.Common
open Prelude
open Prelude.Mods
open Prelude.Data.ChartDatabase
open Interlude.Options

type LoadedChartInfo =
    {
        ChartMeta: ChartMeta
        DurationString: string
        BpmString: string
    }

module SelectedChart =

    let mutable autoplay = false

#if RENAMED
    // test variant: simulates a future Interlude version that renamed this binding
    let _rate_v2 = Setting.rate 1.0f<rate>
    let inline private rate_cell () = _rate_v2
#else
    let _rate = Setting.rate 1.0f<rate>
    let inline private rate_cell () = _rate
#endif
    let _selected_mods = options.SelectedMods

    let private format_duration (chart_meta: ChartMeta option) =
        match chart_meta with
        | Some chart_meta -> chart_meta.Length
        | None -> 0.0f<ms>
        |> fun x -> x / (rate_cell ()).Value
        |> fun x -> (x / 1000.0f / 60.0f |> int, (x / 1000f |> int) % 60)
        |> fun (x, y) -> sprintf "%i:%02i" x y

    let private format_bpm (chart_meta: ChartMeta option) =
        match chart_meta with
        | Some chart_meta -> sprintf "%i" (float32 chart_meta.BPM * float32 (rate_cell ()).Value |> round |> int)
        | None -> sprintf "120"

    let mutable CACHE_DATA: ChartMeta option = None
    let mutable FMT_DURATION: string = format_duration None
    let mutable FMT_BPM: string = format_bpm None

    let keymode () : int =
        match CACHE_DATA with
        | Some chart_meta -> chart_meta.Keys
        | None -> 4

    let change (chart_meta: ChartMeta) : unit =
        CACHE_DATA <- Some chart_meta
        FMT_DURATION <- format_duration CACHE_DATA
        FMT_BPM <- format_bpm CACHE_DATA

    let update () : unit =
        if CACHE_DATA.IsSome then
            FMT_DURATION <- format_duration CACHE_DATA
            FMT_BPM <- format_bpm CACHE_DATA

#if RENAMED
    let rate_v2: Setting.Bounded<float32<rate>> = rate_cell () |> Setting.trigger (fun _ -> update ())
    let inline rate_setting () = rate_v2
#else
    let rate: Setting.Bounded<float32<rate>> = rate_cell () |> Setting.trigger (fun _ -> update ())
    let inline rate_setting () = rate
#endif

    let selected_mods: Setting<ModState> = _selected_mods |> Setting.trigger (fun _ -> update ())

    let loaded_info () : LoadedChartInfo =
        {
            ChartMeta = CACHE_DATA.Value
            DurationString = FMT_DURATION
            BpmString = FMT_BPM
        }
