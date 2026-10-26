// Test fixture: minimal mirrors of Interlude declarations (YAVSRG, MIT, percyqaz) -- names and shapes only.
namespace Interlude

open System.Reflection

module Updates =

    /// Numeric version e.g. "0.5.16"
    let short_version: string =
        let v = Assembly.GetExecutingAssembly().GetName()

        if v.Version.Revision <> 0 then v.Version.ToString(4) else v.Version.ToString(3)

    let mutable restart_on_exit = false
