using Microsoft.Diagnostics.Runtime;

namespace InterludeReader;

/// <summary>
/// Diagnostic mode (--dump): lists types / static fields of the target whose name matches a filter.
/// Used to discover the real compiled names of F# module bindings. Read-only.
/// </summary>
internal static class Probe
{
    public static int Dump(ClrRuntime rt, string filter, TextWriter o)
    {
        var domain = rt.AppDomains.Length > 0 ? rt.AppDomains[0] : rt.SystemDomain!;
        foreach (var m in rt.EnumerateModules())
        {
            var mname = Path.GetFileName(m.Name ?? m.AssemblyName ?? "?");
            int shown = 0;
            foreach (var (mt, token) in m.EnumerateTypeDefToMethodTableMap())
            {
                var t = rt.GetTypeByMethodTable(mt);
                if (t?.Name is null) continue;
                bool typeMatch = t.Name.Contains(filter, StringComparison.OrdinalIgnoreCase);
                var statics = t.StaticFields.Where(f => typeMatch || (f.Name ?? "").Contains(filter, StringComparison.OrdinalIgnoreCase)).ToList();
                var inst = typeMatch ? t.Fields.ToList() : new List<ClrInstanceField>();
                if (!typeMatch && statics.Count == 0) continue;
                if (shown++ == 0) o.WriteLine($"## module {mname}  (name={m.Name}, asm={m.AssemblyName})");
                o.WriteLine($"type {t.Name}  base={t.BaseType?.Name}");
                foreach (var f in statics)
                {
                    string init = "";
                    try { init = f.IsInitialized(domain) ? $" addr=0x{f.GetAddress(domain):x}" : " (uninitialized)"; } catch (Exception e) { init = " err:" + e.Message; }
                    o.WriteLine($"   static {f.Type?.Name} {f.Name}{init}");
                }
                foreach (var f in inst)
                    o.WriteLine($"   field  {f.Type?.Name} {f.Name} @+{f.Offset}");
            }
        }
        return 0;
    }
}
