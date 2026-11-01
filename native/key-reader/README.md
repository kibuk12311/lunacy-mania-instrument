# key-reader

Lunacy mania's keyboard reader for the in-game overlay. osu! stable gives tosu no key presses in mania, so the overlay's
KPS and key lines had to be rebuilt from the judgement counts. This small C# console app tells the app when the
**lane keys it is given** go down and up, on the system's high-resolution clock, **only while the app asks**.

The Electron app owns the process (`app/keyReader.js`): it starts it when an osu! stable play wants its keys, reads its
stdout line by line, keeps it idle between plays and stops it by closing its stdin.

## Safety model

* **A listener, not a hook.** It registers the keyboard for [Raw Input](https://learn.microsoft.com/windows/win32/inputdev/raw-input)
  (`RegisterRawInputDevices`, `RIDEV_INPUTSINK`) on a hidden message-only window of its own. Windows hands this process
  a copy of each keyboard record after the fact: nothing waits for it (no `SetWindowsHookEx`, so no added input
  latency), nothing is injected (no `SendInput`, `keybd_event`, UI automation), no other process is opened. osu! is
  never touched.
* **Only the keys asked for, only while asked.** `listen <vk,…>` names the only virtual keys it may report; every other
  key is dropped where it is read. While it listens to nothing (`stop`, the default), the keyboard is unregistered
  (`RIDEV_REMOVE`) and no record reaches the process at all. The app asks for a play's lane keys (from osu!'s own cfg,
  or set by hand) and for nothing between plays.
* **Nothing kept, nothing written.** No log, no file, no network. A record is cleared from memory once read; the only
  state is which listened keys are held down right now (and when each last sent a make).
* **It never outlives the app.** It exits when its stdin closes, when its stdout breaks, and (`--parent <pid>`) when the
  app's process exits.

## Build

Requirements: .NET 8 SDK. The first build restores the win-x64 runtime pack from NuGet.

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1               # out\key-reader.exe, then its self-test
powershell -ExecutionPolicy Bypass -File build.ps1 -SkipSelfTest
```

`npm run build:keys` runs the same. The output is one self-contained, single-file, trimmed exe (~10 MB); package.json's
`build.extraResources` ships it as `resources\key-reader\key-reader.exe`, and `tools/after-pack.mjs` refuses a build
without it.

## Testing without a keyboard

* `key-reader --self-test`: the Raw Input record parsing, the key folding and the whole protocol on made-up records
  (no window, no Raw Input). Prints one line per check and `self-test ok <n>`; exit code 0 / 1.
* `key-reader --synthetic`: the protocol with no Raw Input at all; `feed <hex of a RAWINPUT record> <ms>` on stdin
  stands for a record Windows would have sent at that time.
* `tests/keyReaderExe.test.js` runs both, then the real Raw Input mode listening only to F13–F24 (keys nobody presses):
  it starts, its clock is the app's, it takes listen and stop, and it exits when its stdin closes or its parent dies.

## Protocol v1

ASCII lines, `\n`-terminated. Times are milliseconds of `QueryPerformanceCounter` (`Stopwatch.GetTimestamp()`), three
decimals; Node's `process.hrtime()` reads the same counter, and the app matches it to its own clock with `sync`.

stdin (from the app):

| line | meaning |
|---|---|
| `listen 65,83,186,222` | report these virtual keys (1–254, at most 32) and no others; replaces the set |
| `listen` / `stop` | report nothing; Raw Input off |
| `sync <id>` | answer `t <id> <ms>` at once |
| `quit` | exit (as does closing stdin) |

stdout:

| line | meaning |
|---|---|
| `ready 1 <ms> raw` | up (`synthetic` in that mode), protocol 1 |
| `listening <n>` / `stopped` | a `listen` / `stop` took |
| `d <vk> <ms>` / `u <vk> <ms>` | a listened key went down / up |
| `t <id> <ms>` | the answer to `sync <id>` |
| `error bad_command` | a line it doesn't take (nothing changes) |
| `error register_failed <win32 error>` | Raw Input refused; nothing is listened to |
| `error window_failed <win32 error>` | the hidden window could not be made; it exits |

A held key is one press: the keyboard's auto-repeat is folded, and a key held on two keyboards is one press until both
let go. A key held down when it stops being listened to is let go at that moment (`u`), so the app is never left with a
key down. Raw Input does not mark auto-repeat, so a key that is already held down when it is added to the set
(`GetAsyncKeyState` of that key only, at that moment) is not reported until it has come up, and a make that comes
more than 2.5 s after the key's last one while it is held stands for a release that was never seen (the secure
desktop or Win+L took it): `u` then `d` at that make. Left and right Shift / Ctrl / Alt are told apart (`LeftShift` 160 …, then the generic 16 / 17 / 18 if that is
what was asked for), the fake Shift some keyboards wrap around the navigation keys is dropped, and a numpad key is its
`NumPad…` key, then (NumLock off) the navigation key it stands for.
