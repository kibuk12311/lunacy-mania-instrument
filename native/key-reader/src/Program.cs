using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace KeyReader;

/// <summary>
/// Lunacy mania's keyboard reader: tells the app when the keys it names go down and up, while it asks, on a
/// high-resolution monotonic clock (QueryPerformanceCounter, in ms). Protocol v1 on stdin / stdout, see README.md.
/// It hears the keyboard through Raw Input (RawInputWindow): no hook, no injection, nothing written anywhere.
/// </summary>
internal static class Program
{
    public static double NowMs() => Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency;

    const string Help = """
        key-reader [--parent <pid>] [--synthetic | --self-test]
          --parent <pid>  exit when that process exits (the app passes its own pid)
          --synthetic     no Raw Input: keyboard records come from stdin ("feed <hex> <ms>"), for tests
          --self-test     check the record parsing, the key folding and the protocol on made-up data, then exit
        """;

    static int Main(string[] args)
    {
        int? parent = null;
        bool synthetic = false, selfTest = false;
        for (int i = 0; i < args.Length; i += 1)
        {
            switch (args[i])
            {
                case "--parent" when i + 1 < args.Length && int.TryParse(args[i + 1], NumberStyles.None, CultureInfo.InvariantCulture, out int pid):
                    parent = pid;
                    i += 1;
                    break;
                case "--synthetic":
                    synthetic = true;
                    break;
                case "--self-test":
                    selfTest = true;
                    break;
                default:
                    Console.Error.WriteLine(Help);
                    return 64;
            }
        }
        if (selfTest) return SelfTest.Run(Console.Out);
        if (parent is int p) WatchParent(p);
        var output = new LineOutput(Console.OpenStandardOutput());
        try
        {
            return synthetic ? RunSynthetic(output) : RawInputWindow.Run(output);
        }
        catch (IOException)
        {
            return 0; // stdout closed: the app is gone
        }
    }

    // the app died without closing our stdin (it normally does): we go with it
    static void WatchParent(int pid)
    {
        Process proc;
        try
        {
            proc = Process.GetProcessById(pid);
        }
        catch
        {
            Environment.Exit(0);
            return;
        }
        new Thread(() =>
        {
            try { proc.WaitForExit(); } catch { }
            Environment.Exit(0);
        }) { IsBackground = true, Name = "parent-watch" }.Start();
    }

    sealed class NoInput : IInputSource
    {
        public bool Start(out int error) { error = 0; return true; }
        public void Stop() { }
        public bool IsDown(int vk) => false;
    }

    // The same protocol with no Raw Input at all: "feed <hex of a RAWINPUT record> <ms>" stands for a record Windows
    // would have sent at that time. Nothing here can hear the real keyboard.
    static int RunSynthetic(LineOutput output)
    {
        var core = new KeyCore(output.Write, new NoInput());
        core.Ready(NowMs(), "synthetic");
        using var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.StartsWith("feed ", StringComparison.Ordinal))
            {
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                byte[] bytes;
                double ms;
                try
                {
                    if (parts.Length != 3) throw new FormatException();
                    bytes = Convert.FromHexString(parts[1]);
                    ms = double.Parse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture);
                }
                catch (FormatException)
                {
                    output.Write("error bad_command");
                    continue;
                }
                if (RawRecord.TryParse(bytes, IntPtr.Size, out RawKey key)) core.Key(key, ms);
                continue;
            }
            if (!core.Command(line, NowMs())) return 0;
        }
        return 0;
    }
}
