using System.Text.Json.Nodes;
using Microsoft.Diagnostics.Runtime;

namespace InterludeReader;

/// <summary>
/// Knows where Interlude keeps its state. Every name here is an F# source name from YAVSRG
/// (interlude-v0.7.28.7); compiled names are resolved at attach time by <see cref="Target"/>.
///
///   Interlude.UI  Screen.fs            module Screen: current_type (ScreenType enum), private current (Screen)
///   Interlude.Features.Gameplay        module SelectedChart: CACHE_DATA (ChartMeta option), _rate (Setting.Bounded&lt;Rate&gt;),
///                                      _selected_mods (Setting&lt;ModState = Map&lt;string,int64&gt;&gt;), autoplay
///   Interlude      Updates.fs          module Updates: short_version
///   Percyqaz.Flux  Audio.fs            module SongPlayerInstance: Song (SongPlayer)
///   During Play: Screen.current is an object expression deriving IPlayScreen; IPlayScreen.state : PlayState;
///                PlayState.scoring : ScoreProcessor (fields judgement_counts, points_scored, max_possible_points,
///                current_combo, best_combo, combo_breaks, max_possible_combo, scoring_events, ruleset, first_note,
///                expired_notes_index, current_pressed_keys, Rate@, Duration@)
/// </summary>
internal sealed class InterludeModel
{
    readonly Target _t;
    readonly Action<string, string> _reportShape; // (key, message) - reported once per key by the caller

    public string Version = "unknown";

    StaticSlot? _screenType, _screenCurrent, _cacheData, _rate, _mods, _autoplay, _song;

    // play tracking survives runtime refreshes (see PlayTracker)
    readonly PlayTracker _pt;

    static readonly string[] ScreenNames =
        ["splash", "mainmenu", "lobby", "levelselect", "play", "practice", "edithud", "replay", "score"];

    public InterludeModel(Target t, PlayTracker pt, Action<string, string> reportShape)
    {
        _t = t;
        _pt = pt;
        _reportShape = reportShape;
    }

    /// <summary>Statics whose declaring file is not initialised yet (F# initialises files lazily): retried after a runtime refresh.</summary>
    public List<string> Pending { get; } = new();

    public void Resolve(string? exeVersion)
    {
        var ver = _t.FindStatic("Interlude", "Interlude.Updates", "Updates", "short_version");
        if (ver?.ReadRef() is { } vs and not 0)
        {
            try { Version = _t.ReadString(vs) ?? Version; } catch { }
        }
        if (Version == "unknown" && exeVersion is not null) Version = exeVersion;

        StaticSlot? Need(string asm, string moduleClass, string stem, params string[] names)
        {
            foreach (var n in names)
            {
                var s = _t.FindStatic(asm, moduleClass, stem, n);
                if (s is not null) return s;
            }
            string what = $"{moduleClass.Split('.').Last().Replace("Module", "")}.{string.Join("/", names)}";
            if (_t.StemLoaded(asm, moduleClass, stem))
                _reportShape("static:" + what, $"field {what} not found (Interlude version {Version})");
            else
                Pending.Add(what);
            return null;
        }

        _screenType = Need("Interlude", "Interlude.UI.ScreenModule", "Screen", "current_type");
        _screenCurrent = Need("Interlude", "Interlude.UI.ScreenModule", "Screen", "current");
        _cacheData = Need("Interlude", "Interlude.Features.Gameplay.SelectedChart", "SelectedChart", "CACHE_DATA");
        _rate = Need("Interlude", "Interlude.Features.Gameplay.SelectedChart", "SelectedChart", "_rate", "rate");
        _mods = Need("Interlude", "Interlude.Features.Gameplay.SelectedChart", "SelectedChart", "_selected_mods", "selected_mods");
        _autoplay = Need("Interlude", "Interlude.Features.Gameplay.SelectedChart", "SelectedChart", "autoplay");
        _song = Need("Percyqaz.Flux", "Percyqaz.Flux.Audio.SongPlayerInstance", "Audio", "Song");
    }

    public void ReportPending()
    {
        foreach (var what in Pending)
            _reportShape("static:" + what, $"field {what} not found: its module was never initialised (Interlude version {Version})");
    }

    public JsonObject ResolvedNames()
    {
        var o = new JsonObject();
        foreach (var (n, s) in new[] { ("Screen.current_type", _screenType), ("Screen.current", _screenCurrent), ("SelectedChart.CACHE_DATA", _cacheData),
                     ("SelectedChart._rate", _rate), ("SelectedChart._selected_mods", _mods), ("SelectedChart.autoplay", _autoplay), ("SongPlayerInstance.Song", _song) })
            o[n] = s is null ? null : s.CompiledName + (s.Ready ? $" [{s.Storage}]" : " [not initialised]");
        return o;
    }

    public static bool IsPlayScreen(int screen) => screen is 4 or 5 or 7; // Play, Practice, Replay

    public int ReadScreen()
    {
        if (_screenType is null || !_screenType.Ready) return -1;
        return _screenType.Read<int>();
    }

    public static string ScreenName(int id) => id >= 0 && id < ScreenNames.Length ? ScreenNames[id] : id < 0 ? "unknown" : $"unknown:{id}";

    // ------------------------------------------------------------------ selection

    public JsonObject? ReadChart()
    {
        if (_cacheData is null) return null;
        var (meta, mt) = _t.OptionValue(_cacheData.ReadRef());
        if (meta == 0 || mt is null) return null;

        var c = new JsonObject();
        Section("chart", () =>
        {
            c["hash"] = _t.StringField(meta, mt, "Hash");
            c["title"] = _t.StringField(meta, mt, "Title");
            if (_t.OptionString(meta, mt, "TitleNative") is { } tn) c["titleNative"] = tn;
            c["artist"] = _t.StringField(meta, mt, "Artist");
            if (_t.OptionString(meta, mt, "ArtistNative") is { } an) c["artistNative"] = an;
            c["diff"] = _t.StringField(meta, mt, "DifficultyName");
            c["creator"] = _t.StringField(meta, mt, "Creator");
            c["keys"] = _t.ValField<int>(meta, mt, "Keys");
            c["lengthMs"] = Round(_t.ValField<float>(meta, mt, "Length"), 1);
            c["bpm"] = _t.ValField<int>(meta, mt, "BPM");
            c["rating"] = Round(_t.ValField<float>(meta, mt, "Rating"), 4);
        });
        Section("rate", () =>
        {
            if (_rate is null) return;
            var cell = SettingCell(_rate.ReadRef());
            if (cell.addr != 0) c["rate"] = Round(_t.ValField<float>(cell.addr, cell.type!, "contents"), 3);
        });
        Section("mods", () =>
        {
            if (_mods is null) return;
            var cell = SettingCell(_mods.ReadRef());
            if (cell.addr == 0) return;
            var (map, mapT) = _t.Obj(cell.addr, cell.type!, "contents");
            var arr = new JsonArray();
            if (map != 0) ReadMapTree(arr, _t.Obj(map, mapT!, "tree"), 0);
            c["mods"] = arr;
        });
        return c;
    }

    public bool? ReadAutoplay() => _autoplay is not null && _autoplay.Ready ? _autoplay.Read<byte>() != 0 : null;

    void ReadMapTree(JsonArray arr, (ulong addr, ClrType? type) node, int depth)
    {
        if (node.addr == 0 || depth > 32) return;
        var t = node.type!;
        if (_t.FindField(t, "left") is not null) ReadMapTree(arr, _t.Obj(node.addr, t, "left"), depth + 1);
        arr.Add((JsonNode)new JsonObject
        {
            ["id"] = _t.StringField(node.addr, t, "k"),
            ["state"] = _t.ValField<long>(node.addr, t, "v"),
        });
        if (_t.FindField(t, "right") is not null) ReadMapTree(arr, _t.Obj(node.addr, t, "right"), depth + 1);
    }

    /// <summary>
    /// Setting&lt;T&gt; is a record of closures {Set; Get; Config}. Setting.simple keeps its value in an
    /// FSharpRef captured by the Get closure; wrappers (bound/trigger/map) keep the same Get or capture the inner
    /// setting. Walk Get@ until an FSharpRef is found; returns the ref cell (read field "contents").
    /// </summary>
    (ulong addr, ClrType? type) SettingCell(ulong setting)
    {
        if (setting == 0) return (0, null);
        var st = _t.TypeOf(setting) ?? throw new TransientReadException("bad Setting");
        var (fn, fnT) = _t.Obj(setting, st, "Get");
        for (int depth = 0; depth < 4 && fn != 0; depth++)
        {
            ClrInstanceField? next = null;
            foreach (var f in fnT!.Fields)
            {
                if (f.Type?.Name?.StartsWith("Microsoft.FSharp.Core.FSharpRef", StringComparison.Ordinal) == true)
                {
                    ulong r = _t.RefField(fn, f);
                    return (r, _t.TypeOf(r));
                }
                if (f.IsObjectReference && next is null) next = f;
            }
            if (next is null) break;
            ulong inner = _t.RefField(fn, next);
            var innerT = _t.TypeOf(inner);
            if (innerT?.Name?.StartsWith("Percyqaz.Common.Setting", StringComparison.Ordinal) == true)
                (fn, fnT) = _t.Obj(inner, innerT, "Get");
            else
                (fn, fnT) = (inner, innerT);
        }
        throw new ShapeException("Setting value cell (Setting.simple closure)");
    }

    // ------------------------------------------------------------------ play

    public JsonObject? ReadPlay(int screen, bool withEvents)
    {
        if (!IsPlayScreen(screen))
        {
            _pt.WasInPlay = false;
            return null;
        }
        if (!_pt.WasInPlay)
        {
            _pt.WasInPlay = true;
            _pt.PlayId++;
            _pt.LastEventCount = 0;
        }

        ulong scr = _screenCurrent?.ReadRef() ?? 0;
        var scrT = _t.TypeOf(scr);
        if (scrT is null) return null;
        var stateF = _t.FindField(scrT, "state");
        if (stateF is null)
        {
            // a transition may briefly leave the old screen object in place; only report if it persists
            _pt.MissingStateFrames++;
            if (_pt.MissingStateFrames > 30)
                _reportShape("field:IPlayScreen.state", $"field IPlayScreen.state not found on {Target.ShortName(scrT.Name)} (Interlude version {Version})");
            return null;
        }
        _pt.MissingStateFrames = 0;
        ulong ps = _t.RefField(scr, stateF);
        var psT = _t.TypeOf(ps) ?? throw new TransientReadException("bad PlayState");
        var scF = _t.FindField(psT, "scoring") ?? _t.FindFieldByType(psT, "Prelude.Gameplay.Scoring.ScoreProcessor")
                  ?? throw new ShapeException("PlayState.scoring");
        ulong sp = _t.RefField(ps, scF);
        var spT = _t.TypeOf(sp) ?? throw new TransientReadException("bad ScoreProcessor");

        var p = new JsonObject();
        p["playId"] = _pt.PlayId;
        int count = 0;
        ulong list = 0;
        ClrType? listT = null;
        float firstNote = 0;

        Section("play.events", () =>
        {
            // scoring_events: ResizeArray<ScoringEvent>; a smaller count means a new ScoreProcessor (retry)
            (list, listT) = _t.Obj(sp, spT, "scoring_events");
            count = list == 0 ? 0 : _t.ValField<int>(list, listT!, "_size");
            if (count < _pt.LastEventCount)
            {
                _pt.PlayId++;
                _pt.LastEventCount = 0;
                p["playId"] = _pt.PlayId;
            }
        });
        Section("play.time", () =>
        {
            firstNote = _t.ValField<float>(sp, spT, "first_note");
            ReadSongTime(p, firstNote);
            // a retry restarts the clock at the lead-in: time jumping back means a new play even if the
            // new ScoreProcessor already caught up with the old event count
            if (p["timeMs"] is JsonValue tv && tv.TryGetValue<double>(out var tms))
            {
                if (tms < _pt.LastTimeMs - 1000 && _pt.LastEventCount > 0 && count > 0 && count >= _pt.LastEventCount)
                {
                    _pt.PlayId++;
                    _pt.LastEventCount = 0;
                    p["playId"] = _pt.PlayId;
                }
                _pt.LastTimeMs = tms;
            }
            p["durationMs"] = Round(_t.ValField<float>(sp, spT, "Duration"), 1);
            p["rate"] = Round(_t.ValField<float>(sp, spT, "Rate"), 3);
        });
        Section("play.judgements", () =>
        {
            var (rs, rsT) = _t.Obj(sp, spT, "ruleset");
            ulong judgArr = 0;
            if (rs != 0)
            {
                p["ruleset"] = _t.StringField(rs, rsT!, "Name");
                judgArr = _t.RefField(rs, rsT!, "Judgements");
            }
            var counts = _t.ReadIntArray(_t.RefField(sp, spT, "judgement_counts"));
            int nJ = Math.Min(counts.Length, _t.ArrayLength(judgArr));
            var hits = new JsonObject();
            var arr = new JsonArray();
            for (int i = 0; i < counts.Length; i++)
            {
                string name = $"j{i}";
                if (i < nJ)
                {
                    ulong j = _t.ArrayRef(judgArr, i);
                    if (_t.TypeOf(j) is { } jt) name = _t.StringField(j, jt, "Name") ?? name;
                }
                if (hits.ContainsKey(name)) name += "#" + i;
                hits[name] = counts[i];
                arr.Add((JsonNode)JsonValue.Create(counts[i]));
            }
            p["hits"] = hits;
            p["judgements"] = arr;
        });
        Section("play.score", () =>
        {
            double pts = _t.ValField<double>(sp, spT, "points_scored");
            double maxPts = _t.ValField<double>(sp, spT, "max_possible_points");
            p["accuracy"] = maxPts == 0 ? 1.0 : Math.Round(pts / maxPts, 6);
            p["points"] = Math.Round(pts, 4);
            p["maxPoints"] = Math.Round(maxPts, 4);
            p["combo"] = _t.ValField<int>(sp, spT, "current_combo");
            p["bestCombo"] = _t.ValField<int>(sp, spT, "best_combo");
            p["comboBreaks"] = _t.ValField<int>(sp, spT, "combo_breaks");
            p["maxPossibleCombo"] = _t.ValField<int>(sp, spT, "max_possible_combo");
        });
        Section("play.progress", () =>
        {
            p["notesPassed"] = _t.ValField<int>(sp, spT, "expired_notes_index");
            p["eventCount"] = count;
        });
        Section("play.keys", () =>
        {
            // Bitmask struct { Value: uint16 } embedded in KeyPressReader
            var keysF = _t.Field(spT, "current_pressed_keys");
            ushort mask = _t.R.Read<ushort>(keysF.GetAddress(sp));
            p["keyMask"] = mask;
            var down = new JsonArray();
            for (int k = 0; k < 16; k++) if ((mask & (1 << k)) != 0) down.Add((JsonNode)JsonValue.Create(k));
            p["keysDown"] = down;
        });
        if (withEvents)
            Section("play.eventlist", () => p["events"] = ReadEvents(list, listT, count));
        _pt.LastEventCount = count;
        return p;
    }


    void ReadSongTime(JsonObject p, float firstNote)
    {
        if (_song is null) return;
        ulong sp = _song.ReadRef();
        var t = _t.TypeOf(sp);
        if (t is null) return;
        float frame = _t.ValField<float>(sp, t, "time_at_start_of_frame");
        float comp = _t.ValField<float>(sp, t, "compensation_at_start_of_frame");
        float rate = _t.ValField<float>(sp, t, "rate");
        float global = _t.ValField<float>(sp, t, "global_offset");
        var (song, songT) = _t.Obj(sp, t, "song");
        float local = song == 0 ? 0 : _t.ValField<float>(song, songT!, "LocalOffset");
        // = SongPlayer.TimeWithOffset, the clock gameplay uses
        float withOffset = frame - comp * rate + local + global * rate;
        p["timeMs"] = Round(withOffset - firstNote, 1);
        p["songTimeMs"] = Round(withOffset, 1);
        var (state, stateT) = _t.Obj(sp, t, "state");
        if (state != 0 && stateT is not null && _t.FindField(stateT, "_tag") is { } tag)
            p["paused"] = _t.ValField<int>(state, tag) == 0;
    }

    JsonArray ReadEvents(ulong list, ClrType? listT, int count)
    {
        var arr = new JsonArray();
        if (list == 0 || count <= _pt.LastEventCount) return arr;
        var (items, _) = _t.Obj(list, listT!, "_items");
        int start = Math.Max(_pt.LastEventCount, count - 512); // cap per frame
        int len = _t.ArrayLength(items);
        for (int i = start; i < count && i < len; i++)
        {
            ulong ev = _t.ArrayRef(items, i);
            var evT = _t.TypeOf(ev);
            if (evT is null) break;
            var e = new JsonObject
            {
                ["i"] = _t.ValField<int>(ev, evT, "Index"),
                ["t"] = Round(_t.ValField<float>(ev, evT, "Time"), 1),
                ["c"] = _t.ValField<int>(ev, evT, "Column"),
            };
            var (inner, innerT) = _t.Obj(ev, evT, "Inner");
            if (innerT is not null)
            {
                string kind = innerT.Name is { } n && n.LastIndexOf('+') is var pos and > 0 ? n[(pos + 1)..] : TagName(inner, innerT);
                e["k"] = kind.ToLowerInvariant();
                if (_t.FindField(innerT, "item") is { } itemF && _t.RefField(inner, itemF) is var item and not 0 && _t.TypeOf(item) is { } itemT)
                {
                    if (_t.FindField(itemT, "Delta") is { } df) e["d"] = Round(_t.ValField<float>(item, df), 2);
                    if (_t.FindField(itemT, "Judgement") is { } jf)
                    {
                        ulong opt = _t.RefField(item, jf);
                        if (opt != 0)
                        {
                            var (tup, tupT) = _t.OptionValue(opt);
                            if (tup != 0) e["j"] = _t.ValField<int>(tup, tupT!, "m_Item1");
                        }
                    }
                    if (_t.FindField(itemT, "Missed") is { } mf) e["m"] = _t.ValField<byte>(item, mf) != 0;
                }
            }
            arr.Add((JsonNode)e);
        }
        return arr;
    }

    string TagName(ulong obj, ClrType t)
    {
        string[] names = ["Hit", "Hold", "Release", "DropHold", "RegrabHold", "GhostTap"];
        if (_t.FindField(t, "_tag") is { } f)
        {
            int tag = _t.ValField<int>(obj, f);
            return tag >= 0 && tag < names.Length ? names[tag] : $"tag{tag}";
        }
        return "unknown";
    }

    // ------------------------------------------------------------------ helpers

    /// <summary>Runs a group of reads; a missing field is reported once (by name) and the group is skipped.</summary>
    void Section(string name, Action body)
    {
        try
        {
            body();
        }
        catch (ShapeException e)
        {
            _reportShape("field:" + e.What, $"field {e.What} not found (Interlude version {Version})");
        }
    }

    static double Round(float f, int digits) => float.IsFinite(f) ? Math.Round((double)f, digits) : 0;
}

/// <summary>Per-process play tracking state, kept across ClrRuntime refreshes.</summary>
internal sealed class PlayTracker
{
    public int PlayId;
    public int LastEventCount;
    public bool WasInPlay;
    public int MissingStateFrames;
    public double LastTimeMs = double.NegativeInfinity;
}
