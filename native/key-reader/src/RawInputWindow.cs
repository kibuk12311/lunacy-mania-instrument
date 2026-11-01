using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace KeyReader;

/// <summary>
/// Raw Input on a hidden message-only window (HWND_MESSAGE: never shown, no taskbar entry, gets no broadcast messages).
/// The keyboard is registered with RIDEV_INPUTSINK, so its records come while another program (osu!) has the focus.
/// This is a listener, not a hook: Windows hands this process a copy of each keyboard record after the fact, nothing
/// waits for it, nothing is injected, no other process is opened. While the app listens to no key, the keyboard is
/// unregistered (RIDEV_REMOVE) and no record reaches this process at all.
/// </summary>
internal static class RawInputWindow
{
    const uint WM_INPUT = 0x00FF;
    const uint WM_APP_COMMAND = 0x8001; // WM_APP + 1: a line from stdin is waiting
    const uint RID_INPUT = 0x10000003;
    const uint RIDEV_REMOVE = 0x00000001;
    const uint RIDEV_INPUTSINK = 0x00000100;
    const ushort HID_USAGE_PAGE_GENERIC = 0x01;
    const ushort HID_USAGE_GENERIC_KEYBOARD = 0x06;
    static readonly IntPtr HWND_MESSAGE = new(-3);

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE
    {
        public ushort UsagePage;
        public ushort Usage;
        public uint Flags;
        public IntPtr Target;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WNDCLASSEXW
    {
        public uint cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public IntPtr lpszMenuName;
        public IntPtr lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
        public uint lPrivate;
    }

    delegate IntPtr WndProcFn(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices([In] RAWINPUTDEVICE[] devices, uint count, uint size);

    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);

    [DllImport("user32.dll", SetLastError = true)]
    static extern ushort RegisterClassExW(ref WNDCLASSEXW wc);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr CreateWindowExW(uint exStyle, IntPtr className, IntPtr windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll")]
    static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern int GetMessageW(out MSG msg, IntPtr hWnd, uint min, uint max);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessageW(ref MSG msg);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern void PostQuitMessage(int code);

    [DllImport("user32.dll")]
    static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetModuleHandleW(IntPtr name);

    // a read of one key's state: nothing is sent, hooked or kept
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vk);

    static readonly WndProcFn Proc = WndProc; // kept alive for as long as the window
    static readonly ConcurrentQueue<string?> Commands = new();
    static KeyCore? s_core;
    static Source? s_source;
    static IntPtr s_buffer;
    static uint s_bufferSize;
    static byte[] s_bytes = new byte[64];

    sealed class Source(IntPtr hwnd) : IInputSource
    {
        bool _on;

        public bool Start(out int error)
        {
            error = 0;
            if (_on) return true;
            var dev = new[] { new RAWINPUTDEVICE { UsagePage = HID_USAGE_PAGE_GENERIC, Usage = HID_USAGE_GENERIC_KEYBOARD, Flags = RIDEV_INPUTSINK, Target = hwnd } };
            if (!RegisterRawInputDevices(dev, 1, (uint)Marshal.SizeOf<RAWINPUTDEVICE>()))
            {
                error = Marshal.GetLastWin32Error();
                return false;
            }
            _on = true;
            return true;
        }

        public void Stop()
        {
            if (!_on) return;
            var dev = new[] { new RAWINPUTDEVICE { UsagePage = HID_USAGE_PAGE_GENERIC, Usage = HID_USAGE_GENERIC_KEYBOARD, Flags = RIDEV_REMOVE, Target = IntPtr.Zero } };
            RegisterRawInputDevices(dev, 1, (uint)Marshal.SizeOf<RAWINPUTDEVICE>());
            _on = false;
        }

        public bool IsDown(int vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    public static int Run(LineOutput output)
    {
        IntPtr instance = GetModuleHandleW(IntPtr.Zero);
        IntPtr className = Marshal.StringToHGlobalUni("LunacyManiaKeyReader");
        var wc = new WNDCLASSEXW
        {
            cbSize = (uint)Marshal.SizeOf<WNDCLASSEXW>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(Proc),
            hInstance = instance,
            lpszClassName = className,
        };
        if (RegisterClassExW(ref wc) == 0)
        {
            output.Write($"error window_failed {Marshal.GetLastWin32Error()}");
            return 2;
        }
        IntPtr hwnd = CreateWindowExW(0, className, IntPtr.Zero, 0, 0, 0, 0, 0, HWND_MESSAGE, IntPtr.Zero, instance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero)
        {
            output.Write($"error window_failed {Marshal.GetLastWin32Error()}");
            return 2;
        }
        // the records are timed when they are taken off the queue: this thread wakes for them first
        Thread.CurrentThread.Priority = ThreadPriority.AboveNormal;
        s_source = new Source(hwnd);
        s_core = new KeyCore(output.Write, s_source);
        s_buffer = Marshal.AllocHGlobal(256);
        s_bufferSize = 256;

        var stdin = new Thread(() =>
        {
            try
            {
                using var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string? line;
                while ((line = reader.ReadLine()) is not null)
                {
                    Commands.Enqueue(line);
                    PostMessageW(hwnd, WM_APP_COMMAND, IntPtr.Zero, IntPtr.Zero);
                }
            }
            catch
            {
                // the pipe broke: the same as closed
            }
            Commands.Enqueue(null); // stdin closed: the app is gone or stopping us
            PostMessageW(hwnd, WM_APP_COMMAND, IntPtr.Zero, IntPtr.Zero);
        }) { IsBackground = true, Name = "stdin" };
        stdin.Start();

        s_core.Ready(Program.NowMs(), "raw");
        while (GetMessageW(out MSG msg, IntPtr.Zero, 0, 0) > 0) DispatchMessageW(ref msg);
        s_source.Stop();
        return 0;
    }

    static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (msg == WM_INPUT)
            {
                double ms = Program.NowMs();
                if (Read(lParam, out RawKey key)) s_core!.Key(key, ms);
            }
            else if (msg == WM_APP_COMMAND)
            {
                while (Commands.TryDequeue(out string? line))
                {
                    if (!s_core!.Command(line, Program.NowMs()))
                    {
                        s_source?.Stop();
                        DestroyWindow(hWnd);
                        PostQuitMessage(0);
                        return IntPtr.Zero;
                    }
                }
                return IntPtr.Zero;
            }
        }
        catch (IOException)
        {
            // stdout is gone: so is the app
            Environment.Exit(0);
        }
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    static bool Read(IntPtr hRawInput, out RawKey key)
    {
        key = default;
        uint headerSize = (uint)RawRecord.HeaderSize(IntPtr.Size);
        uint size = 0;
        if (GetRawInputData(hRawInput, RID_INPUT, IntPtr.Zero, ref size, headerSize) != 0 || size == 0) return false;
        if (size > s_bufferSize)
        {
            if (size > 4096) return false;
            s_buffer = Marshal.ReAllocHGlobal(s_buffer, (IntPtr)size);
            s_bufferSize = size;
        }
        uint got = GetRawInputData(hRawInput, RID_INPUT, s_buffer, ref size, headerSize);
        if (got == uint.MaxValue || got == 0) return false;
        if (s_bytes.Length < got) s_bytes = new byte[got];
        Marshal.Copy(s_buffer, s_bytes, 0, (int)got);
        bool ok = RawRecord.TryParse(s_bytes.AsSpan(0, (int)got), IntPtr.Size, out key);
        // no record outlives its message: a key that isn't listened to leaves nothing behind
        Array.Clear(s_bytes);
        Marshal.Copy(s_bytes, 0, s_buffer, (int)got);
        return ok;
    }
}

/// <summary>stdout, one ASCII line at a time, flushed at once.</summary>
public sealed class LineOutput(Stream stream)
{
    readonly object _lock = new();

    public void Write(string line)
    {
        var bytes = Encoding.ASCII.GetBytes(line + "\n");
        lock (_lock)
        {
            stream.Write(bytes);
            stream.Flush();
        }
    }
}
