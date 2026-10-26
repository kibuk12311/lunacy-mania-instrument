namespace Interlude.UI

type ScreenType =
    | SplashScreen = 0
    | MainMenu = 1
    | Lobby = 2
    | LevelSelect = 3
    | Play = 4
    | Practice = 5
    | EditHud = 6
    | Replay = 7
    | Score = 8

[<AbstractClass>]
type Screen() =
    abstract member OnEnter: ScreenType -> unit
    abstract member OnExit: ScreenType -> unit
    abstract member Update: float -> unit
    default this.Update(_) = ()

type private SimpleScreen(name: string) =
    inherit Screen()
    member this.Name = name
    override this.OnEnter(_) = ()
    override this.OnExit(_) = ()

module Screen =

    let mutable enable_background = true
    let mutable timescale = 1.0
    let mutable current_type = ScreenType.SplashScreen
    let mutable private current = Unchecked.defaultof<Screen>
    let private screens: Screen array = Array.zeroCreate 5

    let init () =
        for i = 0 to 3 do
            screens.[i] <- SimpleScreen(string i)

        current <- screens.[0]

    let current_screen () = current

    /// immediate (no transition) version of Screen.change_new
    let change_new (thunk: unit -> Screen) (screen_type: ScreenType) : unit =
        let s = thunk ()
        current.OnExit(screen_type)
        s.OnEnter(current_type)
        current_type <- screen_type
        current <- s

    let change (screen_type: ScreenType) : unit =
        let idx =
            match screen_type with
            | ScreenType.MainMenu -> 1
            | ScreenType.LevelSelect -> 2
            | ScreenType.Lobby -> 3
            | _ -> 0

        change_new (fun () -> screens.[idx]) screen_type
