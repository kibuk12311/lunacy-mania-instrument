# top-level windows of the given process ids, top of the Z order first: hwnd, topmost, x y w h, title (read only)
param([string]$Pids)
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class Z {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb c, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$want = $Pids -split ',' | ForEach-Object { [uint32]$_ }
$out = New-Object System.Collections.ArrayList
$cb = [Z+Cb]{ param($h,$l)
  [uint32]$p = 0; [void][Z]::GetWindowThreadProcessId($h,[ref]$p)
  if ($want -contains $p -and [Z]::IsWindowVisible($h)) {
    $r = New-Object Z+R; [void][Z]::GetWindowRect($h,[ref]$r)
    $s = New-Object System.Text.StringBuilder 200; [void][Z]::GetWindowText($h,$s,200)
    $top = ([Z]::GetWindowLong($h,-20) -band 8) -ne 0
    [void]$out.Add(@{ hwnd=[string]$h.ToInt64(); topmost=$top; x=$r.L; y=$r.T; w=$r.Rt-$r.L; h=$r.B-$r.T; title=$s.ToString() })
  }
  $true }
[void][Z]::EnumWindows($cb,[IntPtr]::Zero)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out | ConvertTo-Json -Compress
