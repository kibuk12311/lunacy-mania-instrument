namespace Interlude.Options

open Percyqaz.Common
open Prelude.Mods

type GameOptions =
    {
        AudioOffset: Setting<float32>
        SelectedMods: Setting<ModState>
    }

    static member Default =
        {
            AudioOffset = Setting.simple 0.0f
            SelectedMods = Setting.simple Map.empty
        }

[<AutoOpen>]
module StaticOptions =

    let mutable options: GameOptions = Unchecked.defaultof<_>

module Options =

    let init () = options <- GameOptions.Default
