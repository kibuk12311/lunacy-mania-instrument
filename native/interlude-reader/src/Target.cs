using System.Text.RegularExpressions;
using Microsoft.Diagnostics.Runtime;

namespace InterludeReader;

/// <summary>A field/type that the reader expects but could not find (game update renamed something).</summary>
internal sealed class ShapeException(string what) : Exception(what)
{
    public string What { get; } = what;
}

/// <summary>Memory moved under us (GC) or the object is being replaced; skip this frame.</summary>
internal class TransientReadException(string what) : Exception(what);

/// <summary>
/// The DAC instance caches target state: modules/types loaded after we attached have no metadata (null names).
/// ClrRuntime.FlushCachedData() would invalidate ClrMD's metadata importers (AccessViolation), so the caller
/// recreates the whole ClrRuntime (fresh DAC instance) instead.
/// </summary>
internal sealed class StaleMetadataException(string what) : TransientReadException(what);

/// <summary>
/// Thin read-only accessor over a live process. All memory reads go straight through the data reader
/// (ReadProcessMemory), never through the DAC cache, so values are fresh on every poll. Field layouts and static
/// slot addresses are resolved once through ClrMD/DAC and cached. Objects are re-walked from static roots every
/// poll because a compacting GC may move them.
/// </summary>
internal sealed class Target : IDisposable
{
    public readonly DataTarget Dt;
    public readonly ClrRuntime Rt;
    public ClrHeap Heap => Rt.Heap;
    public readonly IDataReader R;
    public readonly ClrAppDomain Domain;
    public readonly int Pid;

    readonly Dictionary<(ulong mt, string name), ClrInstanceField?> _fieldCache = new();
    readonly Dictionary<string, List<ClrType>> _startupTypes = new(StringComparer.OrdinalIgnoreCase);

    public Target(DataTarget dt, ClrRuntime rt, int pid)
    {
        Dt = dt;
        Rt = rt;
        R = dt.DataReader;
        Domain = rt.AppDomains.Length > 0 ? rt.AppDomains[0] : rt.SystemDomain!;
        Pid = pid;
    }

    public void Dispose()
    {
        Rt.Dispose();
        Dt.Dispose();
    }

    // ---------------------------------------------------------------- types & fields

    public static bool NameMatches(string? actual, string wanted) =>
        actual is not null &&
        (actual == wanted || actual == wanted + "@" || FsSuffix.IsMatch(actual) && actual.StartsWith(wanted + "@", StringComparison.Ordinal));

    // F# appends "@<line>" (and sometimes "-<n>") to compiler-generated backing fields: CACHE_DATA@42, scoring@9
    static readonly Regex FsSuffix = new(@"@\d*(-\d+)?$", RegexOptions.Compiled);

    public ClrType? TypeOf(ulong obj)
    {
        if (obj == 0) return null;
        var t = Heap.GetObjectType(obj);
        if (t is not null && t.Name is null) throw new StaleMetadataException($"type without metadata at 0x{obj:x}");
        return t;
    }

    /// <summary>Instance field by F# source name (tries name, name@, name@123). Includes inherited fields.</summary>
    public ClrInstanceField? FindField(ClrType t, string name)
    {
        var key = (t.MethodTable, name);
        if (_fieldCache.TryGetValue(key, out var f)) return f;
        CheckMetadata(t);
        f = t.Fields.FirstOrDefault(x => x.Name == name)
            ?? t.Fields.FirstOrDefault(x => x.Name == name + "@")
            ?? t.Fields.FirstOrDefault(x => NameMatches(x.Name, name));
        _fieldCache[key] = f;
        return f;
    }

    public ClrInstanceField? FindFieldByType(ClrType t, string typeName)
    {
        var key = (t.MethodTable, "type:" + typeName);
        if (_fieldCache.TryGetValue(key, out var f)) return f;
        CheckMetadata(t);
        f = t.Fields.FirstOrDefault(x => x.Type?.Name == typeName);
        _fieldCache[key] = f;
        return f;
    }

    static void CheckMetadata(ClrType t)
    {
        if (t.Name is null || t.Fields.Length > 0 && t.Fields.All(x => x.Name is null))
            throw new StaleMetadataException($"metadata not available for type {t.Name ?? "0x" + t.MethodTable.ToString("x")}");
    }

    public ClrInstanceField Field(ClrType t, string name) =>
        FindField(t, name) ?? throw new ShapeException($"{ShortName(t.Name)}.{name}");

    public static string ShortName(string? typeName)
    {
        if (typeName is null) return "?";
        int lt = typeName.IndexOf('<');
        string head = lt > 0 ? typeName[..lt] : typeName;
        int dot = head.LastIndexOf('.');
        return dot >= 0 ? typeName[(dot + 1)..] : typeName;
    }

    // ---------------------------------------------------------------- object reads

    public ulong RefField(ulong obj, ClrType t, string name) => RefField(obj, Field(t, name));

    public ulong RefField(ulong obj, ClrInstanceField f) => R.ReadPointer(f.GetAddress(obj));

    public T ValField<T>(ulong obj, ClrType t, string name) where T : unmanaged => R.Read<T>(Field(t, name).GetAddress(obj));

    public T ValField<T>(ulong obj, ClrInstanceField f) where T : unmanaged => R.Read<T>(f.GetAddress(obj));

    /// <summary>Reads a ref field and resolves the pointed-to object's real type. 0/null if the field is null.</summary>
    public (ulong addr, ClrType? type) Obj(ulong obj, ClrType t, string name)
    {
        ulong p = RefField(obj, t, name);
        if (p == 0) return (0, null);
        var pt = TypeOf(p) ?? throw new TransientReadException($"{ShortName(t.Name)}.{name} -> bad object 0x{p:x}");
        return (p, pt);
    }

    public string? ReadString(ulong strObj, int maxLen = 2048)
    {
        if (strObj == 0) return null;
        var t = TypeOf(strObj);
        if (t is null || !t.IsString) throw new TransientReadException($"not a string at 0x{strObj:x}");
        return Heap.GetObject(strObj).AsString(maxLen);
    }

    public string? StringField(ulong obj, ClrType t, string name) => ReadString(RefField(obj, t, name));

    /// <summary>FSharpOption&lt;T&gt; (null = None) -> the Some value as object address.</summary>
    public (ulong addr, ClrType? type) OptionValue(ulong optObj)
    {
        if (optObj == 0) return (0, null);
        var ot = TypeOf(optObj) ?? throw new TransientReadException("bad option");
        return Obj(optObj, ot, "value");
    }

    public string? OptionString(ulong obj, ClrType t, string name)
    {
        ulong opt = RefField(obj, t, name);
        if (opt == 0) return null;
        var (v, _) = OptionValue(opt);
        return ReadString(v);
    }

    public int ArrayLength(ulong arr) => arr == 0 ? 0 : R.Read<int>(arr + (ulong)IntPtr.Size);

    public ulong ArrayData(ulong arr) => arr + (ulong)(IntPtr.Size * 2);

    public int[] ReadIntArray(ulong arr, int max = 64)
    {
        int n = Math.Min(ArrayLength(arr), max);
        if (n <= 0) return [];
        var res = new int[n];
        ulong data = ArrayData(arr);
        for (int i = 0; i < n; i++) res[i] = R.Read<int>(data + (ulong)(i * 4));
        return res;
    }

    public ulong ArrayRef(ulong arr, int i) => R.ReadPointer(ArrayData(arr) + (ulong)(i * IntPtr.Size));

    // ---------------------------------------------------------------- statics

    IEnumerable<ClrModule> ModulesFor(string assembly)
    {
        var all = Rt.EnumerateModules().ToList();
        var matching = all.Where(m => string.Equals(ModuleStem(m), assembly, StringComparison.OrdinalIgnoreCase)).ToList();
        return matching.Count > 0 ? matching : all;
    }

    public static string ModuleStem(ClrModule m)
    {
        string? n = m.Name ?? m.AssemblyName;
        if (string.IsNullOrEmpty(n)) return "";
        n = n.Replace('/', '\\');
        n = n[(n.LastIndexOf('\\') + 1)..];
        return n.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) || n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? n[..^4] : n;
    }

    List<ClrType> StartupTypes(ClrModule m)
    {
        string key = m.Address.ToString("x");
        if (_startupTypes.TryGetValue(key, out var list)) return list;
        list = new List<ClrType>();
        foreach (var (mt, _) in m.EnumerateTypeDefToMethodTableMap())
        {
            var t = Rt.GetTypeByMethodTable(mt);
            if (t?.Name is { } n && n.StartsWith("<StartupCode$", StringComparison.Ordinal) && !n.Contains('+'))
                list.Add(t);
        }
        _startupTypes[key] = list;
        return list;
    }

    /// <summary>
    /// Finds the backing static field of an F# module-level binding.
    ///  F# 8/9 (default): static field "name@line" on &lt;StartupCode$Asm&gt;.$FileStem, with a static property on the module class.
    ///  F# with --realsig+: the static field lives on the module class itself.
    /// We check the module class first, then startup classes for the file (exact stem first, then all).
    /// </summary>
    public StaticSlot? FindStatic(string assembly, string moduleClass, string fileStem, string fieldName)
    {
        foreach (var m in ModulesFor(assembly))
        {
            var mc = m.GetTypeByName(moduleClass);
            var f = mc?.StaticFields.FirstOrDefault(x => NameMatches(x.Name, fieldName));
            if (f is not null) return new StaticSlot(this, mc!, f, $"{moduleClass}.{f.Name}");

            var startups = StartupTypes(m);
            var ordered = startups
                .OrderBy(t => t.Name!.EndsWith("$" + fileStem, StringComparison.Ordinal) || t.Name!.EndsWith("." + fileStem, StringComparison.Ordinal) ? 0 : 1);
            foreach (var st in ordered)
            {
                var sf = st.StaticFields.FirstOrDefault(x => NameMatches(x.Name, fieldName));
                if (sf is not null) return new StaticSlot(this, st, sf, $"{st.Name}.{sf.Name}");
            }
        }
        return null;
    }

    List<(ulong obj, ulong handle)>? _arrayHandles;

    /// <summary>Strong/pinned handles that point at arrays (statics storage). Enumerated once per runtime instance.</summary>
    public List<(ulong obj, ulong handle)> ArrayHandles()
    {
        if (_arrayHandles is not null) return _arrayHandles;
        _arrayHandles = new();
        foreach (var h in Rt.EnumerateHandles())
        {
            if (!h.IsStrong && !h.IsPinned) continue;
            var o = h.Object;
            if (o.IsNull || o.Type is not { IsArray: true }) continue;
            _arrayHandles.Add((o.Address, h.Address));
        }
        return _arrayHandles;
    }

    /// <summary>True when the file's startup class (or the module class with statics) is loaded in the target.</summary>
    public bool StemLoaded(string assembly, string moduleClass, string fileStem)
    {
        foreach (var m in ModulesFor(assembly))
        {
            if (m.GetTypeByName(moduleClass) is { } mc && mc.StaticFields.Length > 0) return true;
            if (StartupTypes(m).Any(t => t.Name!.EndsWith("$" + fileStem, StringComparison.Ordinal) || t.Name!.EndsWith("." + fileStem, StringComparison.Ordinal)))
                return true;
        }
        return false;
    }
}

/// <summary>
/// A resolved static field. The DAC computes its address once. For reference-type statics on .NET 8 the slot lives
/// inside a GC-heap object[] that a strong handle keeps alive - and that array MOVES when the GC compacts. We therefore
/// remember (handle, offset) and re-derive the slot address from the handle on every read: handle memory is native and
/// stable. Slots outside the movable GC heap (non-GC statics, POH/frozen/LOH storage on newer runtimes) are used as-is.
/// </summary>
internal sealed class StaticSlot(Target t, ClrType owner, ClrStaticField field, string compiledName)
{
    ulong _addr;          // address as computed by the DAC (stable, or the slot at resolve time)
    ulong _handle;        // handle whose target is the array containing the slot (0 = slot is stable)
    ulong _offset;        // slot offset inside that array
    long _lastTry;
    public readonly string CompiledName = compiledName;
    public readonly ClrStaticField Field = field;
    public readonly ClrType Owner = owner;
    public string Storage = "unresolved";

    /// <summary>0 while the declaring class is not initialised yet (F# initialises files lazily).</summary>
    public ulong Address
    {
        get
        {
            if (_addr == 0)
            {
                long now = Environment.TickCount64;
                if (now - _lastTry < 500) return 0;
                _lastTry = now;
                try
                {
                    if (Field.IsInitialized(t.Domain)) _addr = Field.GetAddress(t.Domain);
                    if (_addr != 0) Locate();
                }
                catch { _addr = 0; }
                if (_addr == 0) return 0;
            }
            if (_handle == 0) return _addr;
            ulong arr = t.R.ReadPointer(_handle);
            return arr == 0 ? 0 : arr + _offset;
        }
    }

    void Locate()
    {
        Storage = "stable";
        if (Field.Type is { IsObjectReference: false }) { Storage = "non-gc"; return; }
        var seg = t.Heap.GetSegmentByAddress(_addr);
        if (seg is null) { Storage = "native"; return; }
        if (seg.Kind is GCSegmentKind.Pinned or GCSegmentKind.Frozen) { Storage = seg.Kind.ToString().ToLowerInvariant(); return; }
        ulong container = t.Heap.FindPreviousObjectOnSegment(_addr + 1);
        var ct = container == 0 ? null : t.Heap.GetObjectType(container);
        if (ct is null || !ct.IsArray) { Storage = "gc-unknown"; return; }
        foreach (var (obj, handle) in t.ArrayHandles())
        {
            if (obj != container) continue;
            _handle = handle;
            _offset = _addr - container;
            Storage = $"gc-array via handle (seg {seg.Kind})";
            return;
        }
        Storage = $"gc-array without handle (seg {seg.Kind})";
    }

    public ulong ReadRef() { var a = Address; return a == 0 ? 0 : t.R.ReadPointer(a); }
    public T Read<T>() where T : unmanaged { var a = Address; return a == 0 ? default : t.R.Read<T>(a); }
    public bool Ready => Address != 0;
}