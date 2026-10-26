using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Diagnostics.Runtime;

namespace InterludeReader;

/// <summary>
/// Read-only "now playing" reader for Interlude. Emits one JSON object per line on stdout (protocol v1, see README).
/// Never suspends, injects into or writes to the target: it only opens the process for reading
/// (ClrMD passive attach = OpenProcess(VM_READ|QUERY_INFORMATION) + ReadProcessMemory) and loads the DAC in this process.
/// </summary>
internal static class Program
{
    public const int ProtocolVersion = 1;
    static readonly Stream Stdout = Console.OpenStandardOutput();
    static readonly object OutLock = new();

    public static void Emit(JsonObject o)
    {
        var bytes = Encoding.UTF8.GetBytes(o.ToJsonString() + "\n");
        lock (OutLock)
        {
            Stdout.Write(bytes);
            Stdout.Flush();
        }
    }

    public static JsonObject Status(string status, string? reason = null, string? code = null)
    {
        var o = new JsonObject { ["v"] = ProtocolVersion, ["status"] = status };
        if (code is not null) o["code"] = code;
        if (reason is not null) o["reason"] = reason;
        return o;
    }

    static int Main(string[] args)
    {
        Options opt;
        try { opt = Options.Parse(args); }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            Console.Error.WriteLine(Options.Help);
            return 64;
        }

        if (opt.ExitWithStdin && !opt.Once && opt.Dump is null)
        {
            // The Electron app owns our lifetime: when it closes our stdin (or dies), exit.
            var t = new Thread(() =>
            {
                try
                {
                    var stdin = Console.OpenStandardInput();
                    var buf = new byte[256];
                    while (stdin.Read(buf, 0, buf.Length) > 0) { }
                }
                catch { }
                Environment.Exit(0);
            }) { IsBackground = true, Name = "stdin-watch" };
            t.Start();
        }

        return new Runner(opt).Run();
    }
}

internal sealed class Runner(Options opt)
{
    string? _lastStatusKey;
    readonly HashSet<string> _reported = new();
    long _lastDacFailure;

    void StatusOnce(string key, JsonObject o)
    {
        if (_lastStatusKey == key) return;
        _lastStatusKey = key;
        Program.Emit(o);
    }

    void ReportShape(string key, string message)
    {
        if (_reported.Add(key)) Program.Emit(Program.Status("error", message, "field_not_found"));
    }

    public int Run()
    {
        while (true)
        {
            var proc = FindProcess();
            if (proc is null)
            {
                StatusOnce("waiting", Program.Status("waiting", opt.Pid is { } p ? $"process {p} not found" : $"{opt.ProcessName}.exe not running"));
                if (opt.Once) return 2;
                Thread.Sleep(1000);
                continue;
            }

            // a missing DAC will not appear by itself: retry every 30 s (e.g. the user dropped one in)
            if (_lastDacFailure != 0 && Environment.TickCount64 - _lastDacFailure < 30_000)
            {
                proc.Dispose();
                Thread.Sleep(1000);
                continue;
            }

            int rc = Session(proc);
            proc.Dispose();
            if (opt.Once || opt.Dump is not null) return rc;
            if (opt.ExitWithTarget && rc == 0) return 0;
            Thread.Sleep(1000);
        }
    }

    Process? FindProcess()
    {
        try
        {
            if (opt.Pid is { } pid)
            {
                var p = Process.GetProcessById(pid);
                return p.HasExited ? null : p;
            }
            var all = Process.GetProcessesByName(opt.ProcessName);
            var pick = all.OrderBy(p => { try { return p.StartTime; } catch { return DateTime.MaxValue; } }).FirstOrDefault();
            foreach (var p in all) if (p != pick) p.Dispose();
            return pick;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>One attach to one process; returns when the process exits or the attach fails.</summary>
    int Session(Process proc)
    {
        int pid = proc.Id;
        _reported.Clear();
        string? exePath = null, exeVersion = null;
        try
        {
            exePath = proc.MainModule?.FileName;
            if (exePath is not null) exeVersion = FileVersionInfo.GetVersionInfo(exePath).FileVersion;
        }
        catch { }

        DataTarget? dt = null;
        try
        {
            ClrInfo? clr = null;
            for (int i = 0; i < 40; i++)
            {
                Options.Log($"attaching to {pid} ({exePath})");
                // passive attach: no suspend, read-only handle. No symbol-server traffic unless --allow-download.
                var dto = new DataTargetOptions { SymbolCachePath = DacLocator.SymbolCache };
                if (!opt.AllowDownload) dto.FileLocator = new NullFileLocator();
                dt = DataTarget.AttachToProcess(pid, suspend: false, dto);
                clr = dt.ClrVersions.FirstOrDefault();
                if (clr is not null) break;
                // just started: runtime not loaded yet
                dt.Dispose();
                dt = null;
                if (proc.HasExited) return 1;
                StatusOnce("noclr:" + pid, Program.Status("waiting", "target runtime not loaded yet"));
                Thread.Sleep(500);
            }
            if (clr is null || dt is null)
            {
                StatusOnce("notnet:" + pid, Program.Status("error", $"process {pid} has no .NET runtime", "not_dotnet"));
                return 5;
            }

            Options.Log($"clr {clr.Version} singleFile={clr.IsSingleFile} module={clr.ModuleInfo.FileName}");
            foreach (var l in clr.DebuggingLibraries) Options.Log($"  debuglib {l.Kind} {l.Platform} {l.FileName} ts={l.IndexTimeStamp} size={l.IndexFileSize}");

            ClrRuntime rt;
            DacChoice dac;
            try
            {
                rt = DacLocator.CreateRuntime(dt, clr, opt, exePath, out dac);
            }
            catch (DacNotFoundException e)
            {
                _lastDacFailure = Environment.TickCount64;
                StatusOnce("dac:" + clr.Version, Program.Status("error", e.Message, "dac_not_found"));
                return 3;
            }
            _lastDacFailure = 0;
            Options.Log($"dac {dac}");

            if (opt.Dump is not null)
            {
                using (rt) return Probe.Dump(rt, opt.Dump, Console.Out);
            }

            return Poll(proc, dt, clr, rt, dac, exeVersion);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            proc.Refresh();
            if (proc.HasExited) { StatusOnce("exited:" + pid, Program.Status("waiting", $"process {pid} exited")); return 0; }
            StatusOnce("fail:" + pid + e.GetType().Name, Program.Status("error", $"{e.GetType().Name}: {e.Message}", e is UnauthorizedAccessException or System.ComponentModel.Win32Exception ? "attach_failed" : "runtime_init_failed"));
            return 6;
        }
        finally
        {
            dt?.Dispose();
        }
    }

    int Poll(Process proc, DataTarget dt, ClrInfo clr, ClrRuntime firstRuntime, DacChoice dac, string? exeVersion)
    {
        var tracker = new PlayTracker();
        long attachedAt = Environment.TickCount64;
        int refreshes = 0, staleRefreshes = 0;
        string? lastSelection = null;
        bool lastEmittedPlay = false;
        int failuresInARow = 0;
        bool announced = false;

        Target target = new(dt, firstRuntime, proc.Id);
        InterludeModel model = new(target, tracker, ReportShape);
        model.Resolve(exeVersion);
        long lastRefresh = Environment.TickCount64;
        bool wantRefresh = false;

        try
        {
            var sw = Stopwatch.StartNew();
            double nextDue = 0;
            long frames = 0, workTicks = 0, allocatedAtLastGc = 0;
            while (true)
            {
                long frameStartTicks = sw.ElapsedTicks;

                // Fresh DAC instance when the cached one is stale (new modules/types loaded since attach) or
                // statics of not-yet-initialised F# files are still missing. Rate-limited, ~50-150 ms each.
                long now = Environment.TickCount64;
                bool pendingStatics = model.Pending.Count > 0 && now - attachedAt < 120_000;
                if (wantRefresh && staleRefreshes >= 30)
                {
                    // something never gets metadata (should not happen): stop paying for refreshes
                    wantRefresh = false;
                    if (_reported.Add("stale-metadata"))
                        Program.Emit(Program.Status("error", "type metadata stays unavailable after 30 runtime refreshes; some fields will be missing", "read_failed"));
                }
                if ((wantRefresh || pendingStatics) && now - lastRefresh > (wantRefresh ? 1000 : 2000))
                {
                    Options.Log($"refreshing runtime (stale={wantRefresh}, pending={string.Join(",", model.Pending)})");
                    int pendingBefore = model.Pending.Count;
                    target.Rt.Dispose();
                    var rt = clr.CreateRuntime(dac.Path, ignoreMismatch: !dac.Exact);
                    target = new Target(dt, rt, proc.Id);
                    model = new InterludeModel(target, tracker, ReportShape);
                    model.Resolve(exeVersion);
                    if (announced && pendingBefore > 0 && model.Pending.Count == 0)
                    {
                        var resolved = Program.Status("resolved");
                        resolved["fields"] = model.ResolvedNames();
                        Program.Emit(resolved);
                    }
                    lastRefresh = Environment.TickCount64;
                    if (wantRefresh) staleRefreshes++;
                    wantRefresh = false;
                    refreshes++;
                }
                else if (model.Pending.Count > 0 && now - attachedAt >= 120_000)
                {
                    model.ReportPending();
                }

                if (!announced)
                {
                    announced = true;
                    var attached = Program.Status("attached");
                    attached["pid"] = proc.Id;
                    attached["client"] = "interlude";
                    attached["version"] = model.Version;
                    attached["clr"] = DacLocator.ProductVersion(clr.Version);
                    attached["clrFileVersion"] = clr.Version.ToString();
                    attached["singleFile"] = clr.IsSingleFile;
                    attached["dac"] = new JsonObject { ["path"] = dac.Path, ["exact"] = dac.Exact, ["source"] = dac.Source };
                    attached["fields"] = model.ResolvedNames();
                    _lastStatusKey = "attached:" + proc.Id;
                    Program.Emit(attached);
                }

                proc.Refresh();
                if (proc.HasExited)
                {
                    StatusOnce("exited:" + proc.Id, Program.Status("waiting", $"process {proc.Id} exited"));
                    return 0;
                }

                bool inPlay = false;
                try
                {
                    int screen = model.ReadScreen();
                    inPlay = InterludeModel.IsPlayScreen(screen);
                    var sel = new JsonObject
                    {
                        ["v"] = Program.ProtocolVersion,
                        ["client"] = "interlude",
                        ["version"] = model.Version,
                        ["pid"] = proc.Id,
                        ["screen"] = InterludeModel.ScreenName(screen),
                        ["chart"] = model.ReadChart(),
                    };
                    if (model.ReadAutoplay() is { } ap) sel["autoplay"] = ap;
                    string selJson = sel.ToJsonString();

                    JsonObject? play = model.ReadPlay(screen, opt.Events);
                    if (play is not null)
                    {
                        sel["play"] = play;
                        Program.Emit(sel);
                    }
                    else if (selJson != lastSelection || lastEmittedPlay)
                    {
                        sel["play"] = null;
                        Program.Emit(sel);
                    }
                    lastSelection = selJson;
                    lastEmittedPlay = play is not null;
                    failuresInARow = 0;
                    if (opt.Once) return 0;
                }
                catch (StaleMetadataException e)
                {
                    Options.Log("stale: " + e.Message);
                    wantRefresh = true;
                    if (++failuresInARow == 100)
                        Program.Emit(Program.Status("error", $"{e.Message} (Interlude version {model.Version})", "read_failed"));
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    // GC moved something mid-read, or the game swapped objects: retry next tick
                    Options.Log($"transient: {e.GetType().Name}: {e.Message}");
                    proc.Refresh();
                    if (proc.HasExited) continue;
                    if (++failuresInARow == 50)
                        Program.Emit(Program.Status("error", $"{e.GetType().Name}: {e.Message} (Interlude version {model.Version})", "read_failed"));
                }

                frames++;
                // Keep the footprint flat: polls allocate small JSON nodes, and the default gen0 budget (sized from
                // the CPU cache) would let tens of MB of garbage pile up before the first GC. A gen0 GC of this tiny
                // heap costs well under a millisecond.
                long allocated = GC.GetAllocatedBytesForCurrentThread();
                if (allocated - allocatedAtLastGc > 8 << 20)
                {
                    GC.Collect(0, GCCollectionMode.Forced, blocking: true);
                    allocatedAtLastGc = allocated;
                }
                workTicks += sw.ElapsedTicks - frameStartTicks;
                if (Options.Verbose && frames % 100 == 0)
                    Options.Log($"avg work per poll: {workTicks * 1000.0 / Stopwatch.Frequency / 100:F2} ms, managed heap {GC.GetTotalMemory(false) / 1048576.0:F1} MB (gen0 GCs {GC.CollectionCount(0)}), working set {Environment.WorkingSet / 1048576.0:F1} MB, refreshes {refreshes}");
                if (frames % 100 == 0) workTicks = 0;

                // absolute schedule so coarse Windows sleeps do not lower the effective rate
                double hz = inPlay ? opt.PlayHz : opt.SelectionHz;
                double period = 1000.0 / hz;
                nextDue = Math.Max(nextDue + period, sw.Elapsed.TotalMilliseconds - period);
                double wait = nextDue - sw.Elapsed.TotalMilliseconds;
                if (wait > 1) Thread.Sleep((int)wait);
            }
        }
        finally
        {
            target.Rt.Dispose();
        }
    }
}
