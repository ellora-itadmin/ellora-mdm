using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ElloraMdmAgent;

/// <summary>
/// "Digital wellbeing" style app usage: how long each application was the
/// foreground app, per Windows user, per day.
///
/// Privacy by design: only the application name is recorded — never window
/// titles, document names, websites or keystrokes. Time is not counted while
/// the PC is idle (no keyboard/mouse input for 3 minutes) or locked.
///
/// A tracker can only see the Windows session it runs in. The elevated agent
/// tracks its own session; a small per-user helper (`--track`, started at
/// every logon by a scheduled task) covers everyone else. Both write cumulative
/// day totals into a shared folder and only the agent — which holds the device
/// token — uploads them, so other users never get access to that token.
/// </summary>
internal static class UsageTracker
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    private const int SampleSeconds = 5;
    private const int IdleLimitSeconds = 180;
    private const int FlushSeconds = 60;

    // Shell/lock-screen hosts that are never "an app the user is using".
    private static readonly HashSet<string> Ignored = new(StringComparer.OrdinalIgnoreCase)
    {
        "logonui.exe", "lockapp.exe", "searchhost.exe", "startmenuexperiencehost.exe",
        "shellexperiencehost.exe", "elloramdmagent.exe", "idle"
    };

    public static string SharedDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ElloraMDM");
    public static string UsageDir => Path.Combine(SharedDir, "usage");
    public static string BinDir => Path.Combine(SharedDir, "bin");

    public class AppEntry
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("seconds")] public int Seconds { get; set; }
    }

    public class DayData
    {
        [JsonPropertyName("user")] public string User { get; set; } = Environment.UserName;
        [JsonPropertyName("date")] public string Date { get; set; } = "";
        [JsonPropertyName("apps")] public Dictionary<string, AppEntry> Apps { get; set; } = new();
    }

    /// <summary>Creates the shared folder and (when elevated) lets every user write to it.</summary>
    public static void EnsureUsageDir()
    {
        try
        {
            var di = Directory.CreateDirectory(UsageDir);
            if (!Installer.IsElevated) return;
            var sec = di.GetAccessControl();
            var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
            sec.AddAccessRule(new FileSystemAccessRule(users, FileSystemRights.Modify,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            di.SetAccessControl(sec);
        }
        catch (Exception ex) { AgentCore.Log($"Usage folder setup: {ex.Message}"); }
    }

    private static string FileFor(string user, string date)
    {
        var safe = string.Concat(user.Select(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_' ? c : '_'));
        return Path.Combine(UsageDir, $"{safe}_{date.Replace("-", "")}.json");
    }

    private static DayData LoadOrNew(string user, string date)
    {
        try
        {
            var f = FileFor(user, date);
            if (File.Exists(f)) return JsonSerializer.Deserialize<DayData>(File.ReadAllText(f)) ?? new DayData { User = user, Date = date };
        }
        catch { }
        return new DayData { User = user, Date = date };
    }

    private static void Save(DayData d)
    {
        try
        {
            Directory.CreateDirectory(UsageDir);
            var f = FileFor(d.User, d.Date);
            var tmp = f + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(d));
            File.Move(tmp, f, overwrite: true);
        }
        catch (Exception ex) { AgentCore.Log($"Usage save failed: {ex.Message}"); }
    }

    private static int IdleSeconds()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return 0;
        return (int)(((uint)Environment.TickCount - info.dwTime) / 1000);
    }

    private static readonly Dictionary<string, string> NameCache = new(StringComparer.OrdinalIgnoreCase);

    private static string FriendlyName(Process p, string exe)
    {
        if (NameCache.TryGetValue(exe, out var cached)) return cached;
        string name = "";
        try
        {
            var fvi = p.MainModule?.FileVersionInfo;
            name = (fvi?.FileDescription ?? fvi?.ProductName ?? "").Trim();
        }
        catch { /* process is elevated/protected; fall back below */ }
        if (string.IsNullOrWhiteSpace(name))
        {
            var bare = Path.GetFileNameWithoutExtension(exe);
            name = bare.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)
                ? "Windows app (Store/UWP)"
                : char.ToUpper(bare[0]) + bare[1..];
        }
        NameCache[exe] = name;
        return name;
    }

    /// <summary>Diagnostic for `--usage-probe`: what the tracker sees right now.</summary>
    public static string Probe()
    {
        var idle = IdleSeconds();
        var s = Sample();
        return $"idle={idle}s sample={(s == null ? "none (idle/locked/ignored)" : s.Value.exe + " / " + s.Value.name)}";
    }

    /// <summary>Returns the foreground app (exe, friendly name), or null if the user isn't actively using one.</summary>
    private static (string exe, string name)? Sample()
    {
        if (IdleSeconds() > IdleLimitSeconds) return null;
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0) return null;
        try
        {
            using var p = Process.GetProcessById((int)pid);
            var exe = p.ProcessName.ToLowerInvariant() + ".exe";
            if (Ignored.Contains(exe)) return null;
            return (exe, FriendlyName(p, exe));
        }
        catch { return null; }
    }

    private static Mutex? _sessionLock;

    /// <summary>
    /// Only one tracker per Windows session. "Local\" mutexes are per session,
    /// so the agent's built-in tracker and a `--track` helper in the same
    /// session never double-count; whichever starts first owns it.
    /// </summary>
    public static bool TryOwnSession()
    {
        _sessionLock = new Mutex(true, "Local\\ElloraMdmUsageTracker", out var created);
        return created;
    }

    public static async Task RunAsync(CancellationToken ct)
    {
        var user = Environment.UserName;
        var date = DateTime.Now.ToString("yyyy-MM-dd");
        var day = LoadOrNew(user, date);
        var lastTick = DateTime.UtcNow;
        var lastFlush = DateTime.UtcNow;
        AgentCore.Log($"Usage tracking started for '{user}'.");

        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(SampleSeconds), ct); } catch (TaskCanceledException) { break; }

            var now = DateTime.UtcNow;
            // Cap the credited time so a sleep/resume gap never counts as usage.
            var elapsed = (int)Math.Min((now - lastTick).TotalSeconds, SampleSeconds * 3);
            lastTick = now;

            try
            {
                var today = DateTime.Now.ToString("yyyy-MM-dd");
                if (today != day.Date)
                {
                    Save(day);
                    day = LoadOrNew(user, today);
                    lastFlush = now;
                }

                var s = Sample();
                if (s != null && elapsed > 0)
                {
                    if (!day.Apps.TryGetValue(s.Value.exe, out var entry))
                        day.Apps[s.Value.exe] = entry = new AppEntry { Name = s.Value.name };
                    entry.Seconds += elapsed;
                }

                if ((now - lastFlush).TotalSeconds >= FlushSeconds) { Save(day); lastFlush = now; }
            }
            catch (Exception ex) { AgentCore.Log($"Usage sample error (continuing): {ex.Message}"); }
        }
        Save(day);
    }

    /// <summary>Reads every user's recent day files for upload (today and yesterday only).</summary>
    public static List<DayData> ReadRecent()
    {
        var result = new List<DayData>();
        if (!Directory.Exists(UsageDir)) return result;
        var keep = new[] { DateTime.Now.ToString("yyyy-MM-dd"), DateTime.Now.AddDays(-1).ToString("yyyy-MM-dd") };
        foreach (var f in Directory.GetFiles(UsageDir, "*.json"))
        {
            try
            {
                var d = JsonSerializer.Deserialize<DayData>(File.ReadAllText(f));
                if (d != null && keep.Contains(d.Date) && d.Apps.Count > 0) result.Add(d);
                else if (d != null && string.CompareOrdinal(d.Date, DateTime.Now.AddDays(-3).ToString("yyyy-MM-dd")) < 0)
                    File.Delete(f); // already uploaded long ago
            }
            catch { }
        }
        return result;
    }
}
