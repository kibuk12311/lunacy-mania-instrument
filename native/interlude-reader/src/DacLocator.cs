using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Diagnostics.Runtime;

namespace InterludeReader;

/// <summary>Where the DAC (mscordaccore.dll) used to read the target came from.</summary>
internal sealed record DacChoice(string Path, bool Exact, string Source);

internal sealed class DacNotFoundException(string message) : Exception(message);

/// <summary>
/// Finds a DAC (mscordaccore.dll) matching the target's CLR without touching the network by default.
///
/// Interlude ships as a single-file self-contained app (dotnet publish -p:PublishSingleFile=True --self-contained),
/// so the runtime is linked into Interlude.exe and NO mscordaccore.dll exists next to it. Search order:
///   1. --dac &lt;path&gt;
///   2. the paths ClrMD reports in ClrInfo.DebuggingLibraries (framework-dependent targets: the shared framework dir)
///   3. &lt;reader dir&gt;\dac\&lt;version&gt;\mscordaccore.dll       (bundled with the reader, see build.ps1 -DacVersions)
///   4. %LOCALAPPDATA%\interlude-reader\dac\&lt;version&gt;\mscordaccore.dll   (cache filled by --allow-download)
///   5. next to the target exe, and %ProgramFiles%\dotnet\shared\Microsoft.NETCore.App\&lt;version&gt;\
///   6. only with --allow-download: Microsoft's public symbol server (msdl.microsoft.com), result copied into (4)
///   7. fallback: the newest DAC with the same major.minor from (3)-(5), loaded with ignoreMismatch (Exact=false)
/// </summary>
internal static class DacLocator
{
    public static string ReaderDir => AppContext.BaseDirectory;

    public static string SymbolCache =>
        System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "interlude-reader", "symcache");

    public static string CacheRoot =>
        System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "interlude-reader", "dac");

    public static ClrRuntime CreateRuntime(DataTarget dt, ClrInfo clr, Options opt, string? targetExe, out DacChoice choice)
    {
        // ClrInfo.Version is coreclr's *file* version (e.g. 8.0.3126.42015); folders/packages use the product version 8.0.31
        string ver = ProductVersion(clr.Version);
        var tried = new List<string>();

        ClrRuntime? TryExact(string path, string source, out DacChoice? c)
        {
            c = null;
            if (!File.Exists(path)) return null;
            tried.Add(path);
            try
            {
                var rt = clr.CreateRuntime(path, ignoreMismatch: false);
                c = new DacChoice(path, true, source);
                return rt;
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                return null;
            }
        }

        if (opt.DacPath is not null)
        {
            if (!File.Exists(opt.DacPath)) throw new DacNotFoundException($"--dac file not found: {opt.DacPath}");
            var r = clr.CreateRuntime(opt.DacPath, ignoreMismatch: true);
            choice = new DacChoice(opt.DacPath, IsExactVersion(opt.DacPath, clr.Version), "--dac");
            return r;
        }

        foreach (var lib in clr.DebuggingLibraries)
        {
            if (lib.Kind != DebugLibraryKind.Dac || lib.Platform != OSPlatform.Windows) continue;
            if (!System.IO.Path.IsPathRooted(lib.FileName)) continue;
            var rt = TryExact(lib.FileName, "runtime-dir", out var c);
            if (rt is not null) { choice = c!; return rt; }
        }

        var exactDirs = new List<(string dir, string source)>
        {
            (System.IO.Path.Combine(ReaderDir, "dac", ver), "bundled"),
            (System.IO.Path.Combine(CacheRoot, ver), "cache"),
        };
        if (targetExe is not null) exactDirs.Add((System.IO.Path.GetDirectoryName(targetExe)!, "target-dir"));
        foreach (var sharedRoot in SharedFrameworkRoots())
            exactDirs.Add((System.IO.Path.Combine(sharedRoot, ver), "installed-runtime"));

        foreach (var (dir, source) in exactDirs)
        {
            var rt = TryExact(System.IO.Path.Combine(dir, "mscordaccore.dll"), source, out var c);
            if (rt is not null) { choice = c!; return rt; }
        }

        if (opt.AllowDownload)
        {
            var downloaded = TryDownload(dt, clr, ver);
            if (downloaded is not null)
            {
                var rt = TryExact(downloaded, "symbol-server", out var c);
                if (rt is not null) { choice = c!; return rt; }
            }
        }

        if (!opt.NoMismatchFallback)
        {
            // Same major.minor servicing releases almost never change the DAC-visible data layout;
            // we accept a mismatched DAC but report exact=false so the consumer can warn.
            var candidates = new List<(Version v, string path)>();
            void Scan(string root)
            {
                if (!Directory.Exists(root)) return;
                foreach (var d in Directory.GetDirectories(root))
                {
                    if (!Version.TryParse(System.IO.Path.GetFileName(d), out var v)) continue;
                    if (v.Major != clr.Version.Major || v.Minor != clr.Version.Minor) continue;
                    if (ProductVersion(clr.Version) == d[(d.LastIndexOfAny(['\\', '/']) + 1)..]) continue; // exact ones were tried already
                    var p = System.IO.Path.Combine(d, "mscordaccore.dll");
                    if (File.Exists(p)) candidates.Add((v, p));
                }
            }
            Scan(System.IO.Path.Combine(ReaderDir, "dac"));
            Scan(CacheRoot);
            foreach (var s in SharedFrameworkRoots()) Scan(s);

            foreach (var (v, path) in candidates.OrderByDescending(c => c.v))
            {
                try
                {
                    var rt = clr.CreateRuntime(path, ignoreMismatch: true);
                    choice = new DacChoice(path, false, $"mismatch-fallback {v}");
                    return rt;
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    tried.Add(path + " (" + e.Message + ")");
                }
            }
        }

        throw new DacNotFoundException(
            $"no mscordaccore.dll for .NET {ver} found (tried: {string.Join("; ", tried.DefaultIfEmpty("nothing"))}). " +
            $"Put it in {System.IO.Path.Combine(ReaderDir, "dac", ver)} (build.ps1 -DacVersions {ver}), " +
            $"or run once with --allow-download.");
    }

    public static string ProductVersion(Version fileVersion) =>
        fileVersion.Build >= 100 ? $"{fileVersion.Major}.{fileVersion.Minor}.{fileVersion.Build / 100}" : $"{fileVersion.Major}.{fileVersion.Minor}.{fileVersion.Build}";

    static bool IsExactVersion(string path, Version v)
    {
        try
        {
            var fvi = FileVersionInfo.GetVersionInfo(path);
            return fvi.FileMajorPart == v.Major && fvi.FileMinorPart == v.Minor && fvi.FileBuildPart == v.Build && fvi.FilePrivatePart == v.Revision;
        }
        catch { return false; }
    }

    static IEnumerable<string> SharedFrameworkRoots()
    {
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        yield return System.IO.Path.Combine(pf, "dotnet", "shared", "Microsoft.NETCore.App");
        var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrEmpty(dotnetRoot))
            yield return System.IO.Path.Combine(dotnetRoot, "shared", "Microsoft.NETCore.App");
    }

    /// <summary>Downloads the DAC from Microsoft's public symbol server via ClrMD's own locator and caches it.</summary>
    static string? TryDownload(DataTarget dt, ClrInfo clr, string ver)
    {
        var locator = dt.FileLocator;
        if (locator is null) return null;
        foreach (var lib in clr.DebuggingLibraries)
        {
            if (lib.Kind != DebugLibraryKind.Dac || lib.Platform != OSPlatform.Windows) continue;
            if (lib.IndexTimeStamp == 0 || lib.IndexFileSize == 0) continue;
            string? got = null;
            try
            {
                got = locator.FindPEImage(System.IO.Path.GetFileName(lib.FileName), lib.IndexTimeStamp, lib.IndexFileSize, checkProperties: false);
            }
            catch { }
            if (got is null || !File.Exists(got)) continue;
            var dir = System.IO.Path.Combine(CacheRoot, ver);
            Directory.CreateDirectory(dir);
            var dest = System.IO.Path.Combine(dir, "mscordaccore.dll");
            File.Copy(got, dest, overwrite: true);
            return dest;
        }
        return null;
    }
}
