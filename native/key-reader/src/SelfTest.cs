namespace KeyReader;

/// <summary>
/// --self-test: the record parsing, the key folding and the protocol, on made-up records only (no keyboard, no
/// window, no Raw Input). Prints "ok"/"FAIL" per check and "self-test ok <n>" or "self-test failed <n>"; exit code 0 / 1.
/// </summary>
internal static class SelfTest
{
    sealed class FakeSource : IInputSource
    {
        public int Starts, Stops;
        public bool Fail;
        public bool On;

        public bool Start(out int error)
        {
            error = Fail ? 5 : 0;
            if (Fail) return false;
            if (On) return true; // like the real one: registered once
            Starts += 1;
            On = true;
            return true;
        }

        public void Stop()
        {
            Stops += 1;
            On = false;
        }

        public readonly HashSet<int> Held = new();
        public bool IsDown(int vk) => Held.Contains(vk);
    }

    const ushort BREAK = RawKey.RI_KEY_BREAK, E0 = RawKey.RI_KEY_E0;

    public static int Run(TextWriter log)
    {
        int passed = 0, failed = 0;
        void Check(bool ok, string what)
        {
            log.WriteLine($"{(ok ? "ok  " : "FAIL")} {what}");
            if (ok) passed += 1;
            else failed += 1;
        }

        // ---- records ----
        var rec = RawRecord.Build(device: 0x1234, makeCode: 0x1E, flags: 0, vkey: 0x41);
        Check(rec.Length == 40, "a keyboard record is 24 + 16 bytes on x64");
        Check(RawRecord.TryParse(rec, 8, out var k) && k.Device == 0x1234 && k.MakeCode == 0x1E && k.VKey == 0x41 && !k.Break && !k.E0,
            "parse: device, make code, vkey, a make");
        var up = RawRecord.Build(7, 0x1E, BREAK | E0, 0x41);
        Check(RawRecord.TryParse(up, 8, out var u) && u.Break && u.E0, "parse: break and E0 flags");
        var rec32 = RawRecord.Build(9, 0x1F, 0, 0x53, pointerSize: 4);
        Check(rec32.Length == 32 && RawRecord.TryParse(rec32, 4, out var k32) && k32.Device == 9 && k32.VKey == 0x53, "parse: a 32-bit layout");
        Check(!RawRecord.TryParse(RawRecord.Build(1, 0, 0, 0x41, type: 0), 8, out _), "a mouse record is not a key");
        Check(!RawRecord.TryParse(rec.AsSpan(0, 30), 8, out _), "a short buffer is not a key");
        var lying = (byte[])rec.Clone();
        lying[4] = 200; // dwSize past the buffer
        Check(!RawRecord.TryParse(lying, 8, out _), "a size past the buffer is refused");

        // ---- candidates ----
        static RawKey Key(ushort vk, ushort flags = 0, ushort make = 0, long dev = 1) => new((IntPtr)dev, make, flags, vk);
        Check(KeyCore.Candidates(Key(0x10, 0, 0x2A)).SequenceEqual([0xA0, 0x10]), "left shift by its make code");
        Check(KeyCore.Candidates(Key(0x10, 0, 0x36)).SequenceEqual([0xA1, 0x10]), "right shift by its make code");
        Check(KeyCore.Candidates(Key(0x10, E0, 0x2A)).Length == 0, "the fake shift around navigation keys is dropped");
        Check(KeyCore.Candidates(Key(0x11)).SequenceEqual([0xA2, 0x11]) && KeyCore.Candidates(Key(0x11, E0)).SequenceEqual([0xA3, 0x11]), "left / right ctrl by E0");
        Check(KeyCore.Candidates(Key(0x12)).SequenceEqual([0xA4, 0x12]) && KeyCore.Candidates(Key(0x12, E0)).SequenceEqual([0xA5, 0x12]), "left / right alt by E0");
        Check(KeyCore.Candidates(Key(0x24)).SequenceEqual([0x67, 0x24]), "numpad 7 with NumLock off: NumPad7, then Home");
        Check(KeyCore.Candidates(Key(0x24, E0)).SequenceEqual([0x24]), "the dedicated Home key is only Home");
        Check(KeyCore.Candidates(Key(0x2E)).SequenceEqual([0x6E, 0x2E]) && KeyCore.Candidates(Key(0x0C)).SequenceEqual([0x65, 0x0C]), "numpad . and 5");
        Check(KeyCore.Candidates(Key(0x63)).SequenceEqual([0x63, 0x22]), "NumPad3 as itself, then PageDown");
        Check(KeyCore.Candidates(Key(0xFF)).Length == 0 && KeyCore.Candidates(Key(0)).Length == 0, "0xFF and 0 are no keys");

        // ---- the protocol ----
        var lines = new List<string>();
        var src = new FakeSource();
        var core = new KeyCore(lines.Add, src);
        string[] Take()
        {
            var r = lines.ToArray();
            lines.Clear();
            return r;
        }
        core.Ready(12.5, "synthetic");
        Check(Take().SequenceEqual(["ready 1 12.500 synthetic"]), "ready line with the protocol version, the clock and the mode");
        core.Key(Key(0x41), 1);
        Check(Take().Length == 0 && !src.On, "before listen: nothing heard, Raw Input off");
        Check(core.Command("listen 65,83,186,222", 2) && Take().SequenceEqual(["listening 4"]) && src.On && src.Starts == 1, "listen: Raw Input on, acknowledged");
        core.Key(Key(0x42), 3);
        Check(Take().Length == 0, "a key not asked for never comes out");
        core.Key(Key(0x41), 10.25);
        core.Key(Key(0x41), 40);
        core.Key(Key(0x41), 70);
        core.Key(Key(0x41, BREAK), 90.5);
        Check(Take().SequenceEqual(["d 65 10.250", "u 65 90.500"]), "a held key is one press: auto-repeat folded");
        core.Key(Key(0x53, BREAK), 95);
        Check(Take().Length == 0, "a release without its press is not reported");
        core.Key(Key(0x41, 0, 0, 1), 100);
        core.Key(Key(0x41, 0, 0, 2), 101);
        core.Key(Key(0x41, BREAK, 0, 1), 102);
        core.Key(Key(0x41, BREAK, 0, 2), 103);
        Check(Take().SequenceEqual(["d 65 100.000", "u 65 103.000"]), "two keyboards holding one key: one press until both let go");
        Check(core.Command("listen 103", 104) && Take().SequenceEqual(["listening 1"]) && src.Starts == 1, "a new set replaces the old one, Raw Input stays on");
        core.Key(Key(0x24), 105);
        core.Key(Key(0x24, BREAK), 106);
        core.Key(Key(0x24, E0), 107);
        Check(Take().SequenceEqual(["d 103 105.000", "u 103 106.000"]), "numpad 7 (NumLock off) heard as NumPad7; the Home key isn't");
        core.Command("listen 160,65", 108);
        Take();
        core.Key(Key(0x10, E0, 0x2A), 109);
        core.Key(Key(0x10, 0, 0x36), 110);
        core.Key(Key(0x10, 0, 0x2A), 111);
        Check(Take().SequenceEqual(["d 160 111.000"]), "left shift: the fake one and the right one are not it");
        core.Key(Key(0x41), 112);
        Check(Take().SequenceEqual(["d 65 112.000"]), "and A, held");
        Check(core.Command("listen 65", 113) && Take().SequenceEqual(["u 160 113.000", "listening 1"]), "a held key no longer listened to is let go at once");
        Check(core.Command("stop", 114) && Take().SequenceEqual(["u 65 114.000", "stopped"]) && !src.On, "stop: held keys let go, Raw Input off");
        core.Key(Key(0x41, BREAK), 115);
        core.Key(Key(0x41), 116);
        Check(Take().Length == 0, "after stop nothing comes out");
        Check(core.Command("listen", 117) && Take().SequenceEqual(["stopped"]), "listen with no keys is stop");
        Check(core.Command("sync 42", 118.0626) && Take().SequenceEqual(["t 42 118.063"]), "sync: the id back with the clock");
        foreach (var bad in new[] { "listen a", "listen 0", "listen 255", "listen 65,,66", "listen -1", "listen " + string.Join(',', Enumerable.Range(1, 33)), "sync x", "sync", "stop now", "hello", new string('x', 600) })
        {
            Check(core.Command(bad, 119) && Take().SequenceEqual(["error bad_command"]), $"refused: {(bad.Length > 30 ? bad[..30] + "…" : bad)}");
        }
        Check(core.ListenCount == 0 && !src.On, "a refused command changes nothing");
        Check(core.Command("", 120) && Take().Length == 0, "an empty line is ignored");
        src.Fail = true;
        Check(core.Command("listen 65", 121) && Take().SequenceEqual(["error register_failed 5"]) && core.ListenCount == 0, "Raw Input refused: an error, nothing heard");
        src.Fail = false;
        core.Command("listen 65", 122);
        core.Key(Key(0x41), 123);
        Take();
        Check(!core.Command("quit", 124) && Take().SequenceEqual(["u 65 124.000"]) && !src.On, "quit: held keys let go, Raw Input off, exit");
        Check(!core.Command(null, 125), "stdin closed: exit");

        // ---- no repeat flag in Raw Input ----
        src = new FakeSource();
        core = new KeyCore(lines.Add, src);
        src.Held.Add(0x41);
        core.Command("listen 65,83", 1000);
        Take();
        core.Key(Key(0x41), 1500);
        core.Key(Key(0x41), 1533);
        Check(Take().Length == 0, "a key held when it was added: its auto-repeat is no press");
        core.Key(Key(0x41, BREAK), 1600);
        Check(Take().Length == 0, "nor is its release");
        core.Key(Key(0x41), 1700);
        Check(Take().SequenceEqual(["d 65 1700.000"]), "its next press is heard");
        src.Held.Add(0x53);
        core.Command("listen 65,83", 1710);
        Take();
        core.Key(Key(0x53), 1720);
        Check(Take().SequenceEqual(["d 83 1720.000"]), "a key already listened to is not held-before when the set comes again");
        core.Key(Key(0x41), 1730);
        core.Key(Key(0x41), 1760);
        core.Key(Key(0x41), 6000);
        Check(Take().SequenceEqual(["u 65 6000.000", "d 65 6000.000"]), "a make long after the last one while held: its release was lost, a new press");
        core.Key(Key(0x41, BREAK), 6100);
        Check(Take().SequenceEqual(["u 65 6100.000"]), "and its release");
        src.Held.Add(0xBA);
        core.Command("listen 65,83,186", 6200);
        Take();
        core.Key(Key(0xBA), 9000);
        Check(Take().SequenceEqual(["d 186 9000.000"]), "a held-before key whose release was lost is heard at its next make after the gap");
        core.Command("stop", 9100);
        Take();
        Check(KeyCore.Ms(1234567.0004) == "1234567.000" && KeyCore.Ms(0.5) == "0.500", "times: three decimals, invariant culture");

        log.WriteLine(failed == 0 ? $"self-test ok {passed}" : $"self-test failed {failed} of {passed + failed}");
        return failed == 0 ? 0 : 1;
    }
}
