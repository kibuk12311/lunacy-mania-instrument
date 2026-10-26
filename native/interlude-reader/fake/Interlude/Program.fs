module Interlude.Program

open System
open System.Threading
open System.Collections.Concurrent
open Percyqaz.Flux.Audio
open Prelude
open Prelude.Data.ChartDatabase
open Interlude.UI
open Interlude.Options
open Interlude.Features.Gameplay
open Interlude.Features.Play

// Fake Interlude driven by stdin commands (one per line). Prints "ok <cmd>" after applying each.
//   screen <mainmenu|levelselect|score|lobby>
//   select hash|title|artist|diff|creator|keys|lengthMs|bpm|rating
//   rate <float>          mods <id=state,id=state|none>
//   play                  retry (same as play)
//   quit

let private make_meta (parts: string array) : ChartMeta =
    {
        Hash = parts.[0]
        Title = parts.[1]
        TitleNative = None
        Artist = parts.[2]
        ArtistNative = None
        DifficultyName = parts.[3]
        Subtitle = None
        Source = None
        Creator = parts.[4]
        Tags = []
        Background = Missing
        Audio = Missing
        PreviewTime = 0.0f<ms>
        Packs = Set.empty
        Keys = int parts.[5]
        Length = float32 parts.[6] * 1.0f<ms>
        BPM = int parts.[7]
        DateAdded = 0L
        Rating = float32 parts.[8]
    }

let private apply (line: string) : bool =
    let cmd, arg =
        match line.IndexOf(' ') with
        | -1 -> line, ""
        | i -> line.Substring(0, i), line.Substring(i + 1)

    match cmd with
    | "screen" ->
        match arg with
        | "mainmenu" -> Screen.change ScreenType.MainMenu
        | "levelselect" -> Screen.change ScreenType.LevelSelect
        | "lobby" -> Screen.change ScreenType.Lobby
        | "score" ->
            Song.Pause()
            Screen.change ScreenType.Score
        | _ -> ()

        true
    | "select" ->
        SelectedChart.change (make_meta (arg.Split('|')))
        true
    | "rate" ->
        (SelectedChart.rate_setting ()).Value <- float32 arg * 1.0f<rate>
        true
    | "mods" ->
        let m =
            if arg = "none" || arg = "" then
                Map.empty
            else
                arg.Split(',')
                |> Array.map (fun kv ->
                    let p = kv.Split('=')
                    p.[0], int64 p.[1])
                |> Map.ofArray

        SelectedChart.selected_mods.Value <- m
        true
    | "play"
    | "retry" ->
        let info = SelectedChart.loaded_info ()
        Screen.change_new (fun () -> PlayScreen.Create(info)) ScreenType.Play
        true
    | "gc" ->
        // force compacting GCs so the reader must cope with objects moving
        GC.Collect(2, GCCollectionMode.Forced, true, true)
        true
    | "quit" -> false
    | _ -> true

[<EntryPoint>]
let main argv =
    Options.init ()
    Screen.init ()

    let queue = ConcurrentQueue<string>()
    let mutable running = true

    let reader =
        Thread(
            (fun () ->
                let mutable l = Console.ReadLine()

                while not (isNull l) do
                    queue.Enqueue(l.Trim().TrimStart(char 0xFEFF))
                    l <- Console.ReadLine()

                queue.Enqueue("quit")),
            IsBackground = true
        )

    reader.Start()
    printfn "ready %i %s" Environment.ProcessId Updates.short_version
    Console.Out.Flush()

    // some garbage so the heap is not trivial
    let junk = ResizeArray<obj>()

    while running do
        Song.MarkStartOfFrame()

        let mutable cmd = null

        while queue.TryDequeue(&cmd) do
            if apply cmd then
                printfn "ok %s" cmd
            else
                running <- false

            Console.Out.Flush()

        (Screen.current_screen ()).Update(8.0)

        junk.Add(box (Array.zeroCreate<byte> 256))

        if junk.Count > 20000 then
            junk.Clear()

        Thread.Sleep(4)

    0
