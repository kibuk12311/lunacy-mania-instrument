namespace Prelude.Data.ChartDatabase

open Prelude

type AssetLocation =
    | Missing
    | Deleted
    | Absolute of string

type ChartMeta =
    {
        Hash: string

        Title: string
        TitleNative: string option
        Artist: string
        ArtistNative: string option
        DifficultyName: string
        Subtitle: string option
        Source: string option
        Creator: string
        Tags: string list

        Background: AssetLocation
        Audio: AssetLocation
        PreviewTime: Time

        Packs: Set<string>

        Keys: int
        Length: Time
        BPM: int
        DateAdded: int64
        Rating: float32
    }
