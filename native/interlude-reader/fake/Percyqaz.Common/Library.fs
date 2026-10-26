// Minimal copy of the declarations the reader depends on, from Percyqaz.Common (commit b152f3e, MIT, percyqaz).
namespace Percyqaz.Common

open System

[<Measure>]
type ms

type Time = float32<ms>

[<Measure>]
type rate

type Setting<'T, 'Config> =
    {
        Set: 'T -> unit
        Get: unit -> 'T
        Config: 'Config
    }
    member this.Value
        with get () = this.Get()
        and set (v: 'T) = this.Set(v)

type Setting<'T> = Setting<'T, unit>

module Setting =

    type Bounds<'T> = 'T * 'T
    type Bounded<'T> = Setting<'T, Bounds<'T>>

    let simple (x: 'T) =
        let mutable x = x

        {
            Set = fun v -> x <- v
            Get = fun () -> x
            Config = ()
        }

    let trigger (action: 'T -> unit) (setting: Setting<'T, 'Config>) : Setting<'T, 'Config> =
        { setting with
            Set =
                fun x ->
                    setting.Set x
                    action setting.Value
        }

    let inline bound (min: 'T, max: 'T) (setting: Setting<'T, 'Config>) : Setting<'T, Bounds<'T>> =
        {
            Set =
                fun v ->
                    if v < min then setting.Set min
                    elif v > max then setting.Set max
                    else setting.Set v
            Get = setting.Get
            Config = min, max
        }

    let inline roundf_uom (dp: int) (setting: Setting<float32<'u>, 'Config>) : Setting<float32<'u>, 'Config> =
        { setting with
            Set = fun v -> setting.Set(MathF.Round(float32 v, dp) |> LanguagePrimitives.Float32WithMeasure)
        }

    let inline bounded (min: 'T, max: 'T) (x: 'T) : Bounded<'T> = simple x |> bound (min, max)
