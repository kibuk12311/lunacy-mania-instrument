using System.Buffers.Binary;
using System.Globalization;

namespace KeyReader;

/// <summary>One keyboard record of Raw Input (RAWINPUTHEADER + RAWKEYBOARD), as GetRawInputData returns it.</summary>
public readonly record struct RawKey(IntPtr Device, ushort MakeCode, ushort Flags, ushort VKey)
{
    public const ushort RI_KEY_BREAK = 1;
    public const ushort RI_KEY_E0 = 2;
    public const ushort RI_KEY_E1 = 4;
    public bool Break => (Flags & RI_KEY_BREAK) != 0;
    public bool E0 => (Flags & RI_KEY_E0) != 0;
}

public static class RawRecord
{
    public const uint RIM_TYPEKEYBOARD = 1;
    const int KeyboardSize = 16; // MakeCode, Flags, Reserved, VKey (u16 each), Message, ExtraInformation (u32 each)

    /// <summary>RAWINPUTHEADER: dwType, dwSize (u32), hDevice, wParam (pointers).</summary>
    public static int HeaderSize(int pointerSize) => 8 + 2 * pointerSize;

    /// <summary>A RAWINPUT buffer → its keyboard record; false for a mouse or HID record, or a short buffer.</summary>
    public static bool TryParse(ReadOnlySpan<byte> data, int pointerSize, out RawKey key)
    {
        key = default;
        int header = HeaderSize(pointerSize);
        if (data.Length < header + KeyboardSize) return false;
        uint type = BinaryPrimitives.ReadUInt32LittleEndian(data);
        uint size = BinaryPrimitives.ReadUInt32LittleEndian(data[4..]);
        if (type != RIM_TYPEKEYBOARD || size < header + KeyboardSize || size > data.Length) return false;
        long device = pointerSize == 8 ? BinaryPrimitives.ReadInt64LittleEndian(data[8..]) : BinaryPrimitives.ReadInt32LittleEndian(data[8..]);
        var kb = data[header..];
        key = new RawKey(
            (IntPtr)device,
            BinaryPrimitives.ReadUInt16LittleEndian(kb),
            BinaryPrimitives.ReadUInt16LittleEndian(kb[2..]),
            BinaryPrimitives.ReadUInt16LittleEndian(kb[6..]));
        return true;
    }

    /// <summary>A RAWINPUT keyboard buffer from its parts (the self-test and the synthetic mode build their records with it).</summary>
    public static byte[] Build(long device, ushort makeCode, ushort flags, ushort vkey, int pointerSize = 8, uint type = RIM_TYPEKEYBOARD)
    {
        int header = HeaderSize(pointerSize);
        var b = new byte[header + KeyboardSize];
        BinaryPrimitives.WriteUInt32LittleEndian(b, type);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(4), (uint)b.Length);
        if (pointerSize == 8) BinaryPrimitives.WriteInt64LittleEndian(b.AsSpan(8), device);
        else BinaryPrimitives.WriteInt32LittleEndian(b.AsSpan(8), (int)device);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(header), makeCode);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(header + 2), flags);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(header + 6), vkey);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(header + 8), (flags & RawKey.RI_KEY_BREAK) != 0 ? 0x101u : 0x100u);
        return b;
    }
}

/// <summary>Turns Raw Input on and off (the real one registers the keyboard for this process's hidden window).</summary>
public interface IInputSource
{
    bool Start(out int error);
    void Stop();
    /// <summary>Whether this key is held down right now (asked only of keys being listened to, as they are added).</summary>
    bool IsDown(int vk);
}

/// <summary>
/// The whole behaviour of the helper, without Windows: the commands of protocol v1 (see README.md), which keys are
/// heard, and the presses that go out. A key is reported only while it is in the set the app asked for; a held key is
/// one press (the keyboard's auto-repeat makes are folded). Raw Input does not mark a make as a repeat, so: a key
/// already held down when it is added to the set is not reported until it has been let go (its auto-repeat would
/// look like a press), and a make that comes more than LostReleaseMs after the key's last one while it is held is a
/// new press whose release was never seen (the secure desktop or Win+L took it): "u" then "d" at that make.
/// Nothing is ever kept but the keys held down right now and the time of their last make.
/// </summary>
public sealed class KeyCore
{
    public const int ProtocolVersion = 1;
    public const int MaxKeys = 32;
    public const int MaxLine = 512;
    // longer than any keyboard's auto-repeat delay (Windows' is 1 s at most, FilterKeys' 2 s) and its slowest repeat
    public const double LostReleaseMs = 2500;

    // virtual keys (winuser.h)
    const int VK_CLEAR = 0x0C, VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12;
    const int VK_PRIOR = 0x21, VK_NEXT = 0x22, VK_END = 0x23, VK_HOME = 0x24, VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
    const int VK_INSERT = 0x2D, VK_DELETE = 0x2E, VK_NUMPAD0 = 0x60, VK_DECIMAL = 0x6E;
    const int VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3, VK_LMENU = 0xA4, VK_RMENU = 0xA5;
    const int SCAN_LSHIFT = 0x2A, SCAN_RSHIFT = 0x36;

    // the numpad's keys as the navigation keys they also are (NumLock off, or the raw VKey of a numpad key): 0..9, '.'
    static readonly int[] NumpadNav = [VK_INSERT, VK_END, VK_DOWN, VK_NEXT, VK_LEFT, VK_CLEAR, VK_RIGHT, VK_HOME, VK_UP, VK_PRIOR];

    readonly Action<string> _emit;
    readonly IInputSource _source;
    HashSet<int> _listen = new();
    // listened key → the keyboards holding it down (two keyboards holding one key are one press)
    readonly Dictionary<int, HashSet<IntPtr>> _down = new();
    // listened keys that were already held down when they were added: not heard until they come up
    readonly HashSet<int> _heldBefore = new();
    // held key (or held-before key) → ms of its last make
    readonly Dictionary<int, double> _lastMake = new();

    public KeyCore(Action<string> emit, IInputSource source)
    {
        _emit = emit;
        _source = source;
    }

    public int ListenCount => _listen.Count;

    public static string Ms(double ms) => ms.ToString("F3", CultureInfo.InvariantCulture);

    public void Ready(double nowMs, string mode) => _emit($"ready {ProtocolVersion} {Ms(nowMs)} {mode}");

    /// <summary>One line from the app. → false when the helper should exit.</summary>
    public bool Command(string? line, double nowMs)
    {
        if (line is null) return false;
        line = line.Trim();
        if (line.Length == 0) return true;
        if (line.Length > MaxLine)
        {
            _emit("error bad_command");
            return true;
        }
        int space = line.IndexOf(' ');
        string word = space < 0 ? line : line[..space];
        string arg = space < 0 ? "" : line[(space + 1)..].Trim();
        switch (word)
        {
            case "listen":
                Listen(arg, nowMs);
                return true;
            case "stop":
                if (arg.Length != 0) { _emit("error bad_command"); return true; }
                Listen("", nowMs);
                return true;
            case "sync":
                if (!uint.TryParse(arg, NumberStyles.None, CultureInfo.InvariantCulture, out uint id)) { _emit("error bad_command"); return true; }
                _emit($"t {id} {Ms(nowMs)}");
                return true;
            case "quit":
                ReleaseAll(nowMs, null);
                _source.Stop();
                return false;
            default:
                _emit("error bad_command");
                return true;
        }
    }

    // "listen 65,83,186,222": these keys and no others from now on; "listen" (nothing) or "stop": none, Raw Input off
    void Listen(string arg, double nowMs)
    {
        var next = ParseKeys(arg);
        if (next is null)
        {
            _emit("error bad_command");
            return;
        }
        // a key held down that is not heard any more is let go now (only keys the app had asked for ever come out)
        ReleaseAll(nowMs, next);
        _heldBefore.RemoveWhere((vk) => !next.Contains(vk));
        foreach (int vk in _lastMake.Keys.Where((vk) => !next.Contains(vk)).ToList()) _lastMake.Remove(vk);
        if (next.Count == 0)
        {
            _listen = next;
            Forget();
            _source.Stop();
            _emit("stopped");
            return;
        }
        // a key added while it is held down: its auto-repeat is no press, it is heard once it has come up
        foreach (int vk in next)
        {
            if (_listen.Contains(vk) || !_source.IsDown(vk)) continue;
            _heldBefore.Add(vk);
            _lastMake[vk] = nowMs;
        }
        if (!_source.Start(out int error))
        {
            _listen = new();
            Forget();
            _emit($"error register_failed {error}");
            return;
        }
        _listen = next;
        _emit($"listening {next.Count}");
    }

    static HashSet<int>? ParseKeys(string arg)
    {
        var set = new HashSet<int>();
        if (arg.Length == 0) return set;
        foreach (var part in arg.Split(','))
        {
            if (!int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out int vk) || vk < 1 || vk > 254) return null;
            set.Add(vk);
        }
        return set.Count <= MaxKeys ? set : null;
    }

    void Forget()
    {
        _down.Clear();
        _heldBefore.Clear();
        _lastMake.Clear();
    }

    void ReleaseAll(double nowMs, HashSet<int>? keep)
    {
        foreach (var vk in _down.Where((p) => p.Value.Count > 0 && (keep is null || !keep.Contains(p.Key))).Select((p) => p.Key).OrderBy((v) => v).ToList())
        {
            _down.Remove(vk);
            _lastMake.Remove(vk);
            _emit($"u {vk} {Ms(nowMs)}");
        }
    }

    /// <summary>
    /// The virtual keys a record may stand for, the most exact first: left and right Shift / Ctrl / Alt told apart,
    /// a numpad key as its numpad key (then as the navigation key it is with NumLock off), the fake Shift that
    /// some keyboards wrap around the navigation keys and the 0xFF of escape sequences dropped.
    /// </summary>
    public static int[] Candidates(in RawKey k)
    {
        int vk = k.VKey;
        if (vk == 0 || vk == 0xFF) return [];
        switch (vk)
        {
            case VK_SHIFT:
                if (k.E0) return []; // a fake shift (E0 2A / E0 AA)
                return k.MakeCode == SCAN_RSHIFT ? [VK_RSHIFT, VK_SHIFT] : [VK_LSHIFT, VK_SHIFT];
            case VK_CONTROL:
                return k.E0 ? [VK_RCONTROL, VK_CONTROL] : [VK_LCONTROL, VK_CONTROL];
            case VK_MENU:
                return k.E0 ? [VK_RMENU, VK_MENU] : [VK_LMENU, VK_MENU];
        }
        int nav = Array.IndexOf(NumpadNav, vk);
        if (vk == VK_DELETE) nav = 10;
        if (nav >= 0)
        {
            if (k.E0) return [vk]; // the dedicated key, not the numpad
            int pad = nav == 10 ? VK_DECIMAL : VK_NUMPAD0 + nav;
            return [pad, vk];
        }
        if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD0 + 9) return [vk, NumpadNav[vk - VK_NUMPAD0]];
        if (vk == VK_DECIMAL) return [vk, VK_DELETE];
        return [vk];
    }

    int Heard(in RawKey k)
    {
        foreach (int vk in Candidates(k)) if (_listen.Contains(vk)) return vk;
        return 0;
    }

    /// <summary>One keyboard record at time ms (the helper's clock): a press or release out, if it is heard and new.</summary>
    public void Key(in RawKey k, double ms)
    {
        if (_listen.Count == 0) return;
        int vk = Heard(k);
        if (vk == 0) return;
        bool stale = _lastMake.TryGetValue(vk, out double last) && ms - last > LostReleaseMs;
        if (!k.Break)
        {
            if (_heldBefore.Contains(vk))
            {
                _lastMake[vk] = ms;
                if (!stale) return; // the auto-repeat of a key held since before it was listened to
                _heldBefore.Remove(vk); // its release was never seen: this is a press
            }
            if (!_down.TryGetValue(vk, out var devices)) _down[vk] = devices = new HashSet<IntPtr>();
            else if (stale && devices.Count > 0)
            {
                // held, and no make for longer than any auto-repeat: it came up unseen, this is a new press
                devices.Clear();
                _emit($"u {vk} {Ms(ms)}");
            }
            bool first = devices.Count == 0;
            devices.Add(k.Device);
            _lastMake[vk] = ms;
            if (first) _emit($"d {vk} {Ms(ms)}");
        }
        else if (_heldBefore.Remove(vk))
        {
            _lastMake.Remove(vk); // up at last: heard from its next press on
        }
        else if (_down.TryGetValue(vk, out var devices) && devices.Remove(k.Device) && devices.Count == 0)
        {
            _down.Remove(vk);
            _lastMake.Remove(vk);
            _emit($"u {vk} {Ms(ms)}");
        }
    }
}
