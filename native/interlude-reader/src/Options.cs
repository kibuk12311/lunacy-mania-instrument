using System.Collections.Immutable;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Diagnostics.Runtime;

namespace InterludeReader;

internal sealed class Options
{
    public int? Pid;
    public string ProcessName = "Interlude";
    public string? DacPath;
    public bool AllowDownload;
    public bool NoMismatchFallback;
    public double SelectionHz = 4;
    public double PlayHz = 30;
    public bool Events = true;
    public bool Once;
    public bool ExitWithStdin = true;
    public bool ExitWithTarget;
    public string? Dump;
    public static bool Verbose;
    public static void Log(string s) { if (Verbose) Console.Error.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] {s}"); }

    public static Options Parse(string[] args)
    {
        var o = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"{a} needs a value");
            switch (a)
            {
                case "--pid": o.Pid = int.Parse(Next(), CultureInfo.InvariantCulture); break;
                case "--name": o.ProcessName = Next(); break;
                case "--dac": o.DacPath = Next(); break;
                case "--allow-download": o.AllowDownload = true; break;
                case "--no-mismatch-fallback": o.NoMismatchFallback = true; break;
                case "--selection-hz": o.SelectionHz = double.Parse(Next(), CultureInfo.InvariantCulture); break;
                case "--play-hz": o.PlayHz = double.Parse(Next(), CultureInfo.InvariantCulture); break;
                case "--no-events": o.Events = false; break;
                case "--once": o.Once = true; break;
                case "--no-stdin-exit": o.ExitWithStdin = false; break;
                case "--exit-with-target": o.ExitWithTarget = true; break;
                case "--dump": o.Dump = Next(); break;
                case "--verbose": Verbose = true; break;
                case "-h":
                case "--help":
                    Console.Error.WriteLine(Help);
                    Environment.Exit(0);
                    break;
                default: throw new ArgumentException($"unknown argument {a}");
            }
        }
        o.SelectionHz = Math.Clamp(o.SelectionHz, 0.2, 60);
        o.PlayHz = Math.Clamp(o.PlayHz, 1, 120);
        return o;
    }

    public const string Help = """
        interlude-reader - read-only "now playing" reader for Interlude (JSON lines on stdout)
          --pid N                attach to this process id only
          --name NAME            process name to look for (default Interlude)
          --dac PATH             use this mscordaccore.dll
          --allow-download       allow fetching the DAC from msdl.microsoft.com once (cached in %LOCALAPPDATA%)
          --no-mismatch-fallback never use a DAC whose patch version differs from the target runtime
          --selection-hz F       poll rate outside gameplay (default 4)
          --play-hz F            poll rate during gameplay (default 30)
          --no-events            do not emit per-note hit events
          --once                 print one snapshot and exit
          --no-stdin-exit        keep running when stdin closes (default: exit on stdin EOF)
          --exit-with-target     exit (code 0) when the target process exits instead of waiting for a new one
          --verbose              trace to stderr
          --dump FILTER          diagnostic: list target types/static fields matching FILTER and exit
        """;
}

/// <summary>Never finds anything: guarantees ClrMD performs no symbol-server downloads.</summary>
internal sealed class NullFileLocator : IFileLocator
{
    public string? FindElfImage(string fileName, SymbolProperties archivedUnder, ImmutableArray<byte> buildId, bool checkProperties) => null;
    public string? FindMachOImage(string fileName, SymbolProperties archivedUnder, ImmutableArray<byte> uuid, bool checkProperties) => null;
    public string? FindPEImage(string fileName, int buildTimeStamp, int imageSize, bool checkProperties) => null;
    public string? FindPEImage(string fileName, SymbolProperties archivedUnder, ImmutableArray<byte> buildIdOrUUID, OSPlatform originalPlatform, bool checkProperties) => null;
}
