// Test fixture: minimal mirror of engine/src/Audio (YAVSRG, MIT, percyqaz) -- names and shapes only, no audio.
namespace Percyqaz.Flux.Audio

open System.Diagnostics
open Percyqaz.Common

type Song =
    {
        mutable ID: int
        Frequency: int
        Duration: Time
        PreviewPoint: Time
        LastNote: Time
        mutable LocalOffset: Time
        mutable LowPassFilterEffect: int
        mutable Playing: bool
    }

type private CurrentSongState =
    | Paused
    | PlayingWithoutAudio
    | PlayingWithAudio

type SongPlayer() =

    let mutable song: Song =
        {
            ID = 0
            Frequency = 44100
            Duration = 1000.0f<ms>
            PreviewPoint = 0.0f<ms>
            LastNote = 1000.0f<ms>
            LocalOffset = 0.0f<ms>
            LowPassFilterEffect = 0
            Playing = false
        }

    let mutable timer_start: int64 = Stopwatch.GetTimestamp()
    let mutable timer_position: Time = 0.0f<ms>
    let mutable state: CurrentSongState = Paused

    let mutable time_at_start_of_frame = 0.0f<ms>
    let mutable compensation_at_start_of_frame = 0.0f<ms / rate>
    let mutable rate = 1.0f<rate>
    let mutable global_offset = 0.0f<ms / rate>

    member private this.PositionRealtime() : Time =
        if state = Paused then
            timer_position
        else
            timer_position + float32(Stopwatch.GetElapsedTime(timer_start).TotalMilliseconds) * 1.0f<ms / rate> * rate

    member this.Current: Song = song
    member this.IsPlaying: bool = state <> Paused
    member this.Rate = rate

    member this.SetRate(r: float32<rate>) =
        timer_position <- this.PositionRealtime()
        timer_start <- Stopwatch.GetTimestamp()
        rate <- r

    member this.SetLocalOffset(o: Time) = song.LocalOffset <- o

    member this.PlayFrom(time: Time) =
        timer_position <- time
        timer_start <- Stopwatch.GetTimestamp()
        state <- PlayingWithAudio

    member this.Pause() =
        timer_position <- this.PositionRealtime()
        state <- Paused

    /// called once per frame like the real engine
    member this.MarkStartOfFrame() : unit =
        time_at_start_of_frame <- this.PositionRealtime()

    member this.Time = time_at_start_of_frame
    member this.TimeCompensated = this.Time - compensation_at_start_of_frame * rate
    member this.TimeWithOffset = this.TimeCompensated + song.LocalOffset + global_offset * rate

[<AutoOpen>]
module SongPlayerInstance =

    let Song = SongPlayer()
