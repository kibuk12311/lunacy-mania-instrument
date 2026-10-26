// Test fixture: minimal mirrors of declarations from YAVSRG prelude (MIT, percyqaz) -- names and shapes only.
namespace Prelude

[<Struct>]
type Bitmask =
    {
        Value: uint16
    }
    static member Empty = { Value = 0us }
    member inline this.Contains(key: int) : bool = (1us <<< key) &&& this.Value > 0us
    member inline this.Add(key: int) : Bitmask = { Value = (1us <<< key) ||| this.Value }
    member inline this.Remove(key: int) : Bitmask = { Value = ~~~(1us <<< key) &&& this.Value }

[<Measure>]
type ms = Percyqaz.Common.ms

[<Measure>]
type rate = Percyqaz.Common.rate

type GameplayTime = float32<ms / rate>
type Rate = float32<rate>
type Time = Percyqaz.Common.Time

[<AutoOpen>]
module UnitConstants =
    [<Literal>]
    let LOWEST_SUPPORTED_RATE = 0.5f<rate>

    [<Literal>]
    let HIGHEST_SUPPORTED_RATE = 3.0f<rate>

module Setting =
    open Percyqaz.Common.Setting

    let rate x =
        x |> bounded(LOWEST_SUPPORTED_RATE, HIGHEST_SUPPORTED_RATE) |> roundf_uom 2

namespace Prelude.Mods

type ModState = Map<string, int64>
