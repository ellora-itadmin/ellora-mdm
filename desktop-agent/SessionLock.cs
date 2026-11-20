using System.Runtime.InteropServices;

namespace ElloraMdmAgent;

/// <summary>
/// Locks every interactive Windows session that is currently on screen.
/// LockWorkStation only locks the session of the process calling it, and the
/// elevated agent lives in the administrator's session — so when a different
/// (standard) user is the one signed in, that call would lock the wrong
/// session. For other users' sessions we disconnect the session instead:
/// Windows then shows the lock/sign-in screen and requires the password to
/// resume, while the user's open programs keep running.
/// </summary>
internal static class SessionLock
{
    private const int WTSActive = 0;
    private const int WTSUserName = 5;

    [StructLayout(LayoutKind.Sequential)]
    private struct WTS_SESSION_INFO
    {
        public int SessionId;
        public IntPtr pWinStationName;
        public int State;
    }

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSEnumerateSessions(IntPtr hServer, int reserved, int version, out IntPtr ppSessionInfo, out int pCount);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr pMemory);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int infoClass, out IntPtr buffer, out int bytesReturned);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSDisconnectSession(IntPtr hServer, int sessionId, bool wait);

    [DllImport("kernel32.dll")]
    private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    /// <summary>
    /// The account that is actually signed in at the screen. A background
    /// service runs as SYSTEM, so Environment.UserName would just say "SYSTEM".
    /// </summary>
    public static string? CurrentUserName()
    {
        try
        {
            if (!AgentConfig.IsSystemAccount) return Environment.UserName;
            var sessions = ListInteractiveSessions().Where(s => s.Active).ToList();
            var console = WTSGetActiveConsoleSessionId();
            return (sessions.FirstOrDefault(s => s.Id == (int)console) ?? sessions.FirstOrDefault())?.User;
        }
        catch { return null; }
    }

    /// <summary>Session to show UI in: the physical console if someone is signed in there, otherwise any active session.</summary>
    public static int? ActiveSessionId()
    {
        var sessions = ListInteractiveSessions().Where(s => s.Active).ToList();
        if (sessions.Count == 0) return null;
        var console = (int)WTSGetActiveConsoleSessionId();
        return sessions.Any(s => s.Id == console) ? console : sessions[0].Id;
    }

    public record SessionInfo(int Id, string User, bool Active);

    public static List<SessionInfo> ListInteractiveSessions()
    {
        var result = new List<SessionInfo>();
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var ptr, out var count)) return result;
        try
        {
            int size = Marshal.SizeOf<WTS_SESSION_INFO>();
            for (int i = 0; i < count; i++)
            {
                var info = Marshal.PtrToStructure<WTS_SESSION_INFO>(ptr + i * size);
                if (info.SessionId == 0) continue; // services session, never interactive

                string user = "";
                if (WTSQuerySessionInformation(IntPtr.Zero, info.SessionId, WTSUserName, out var buf, out _))
                {
                    user = Marshal.PtrToStringAnsi(buf) ?? "";
                    WTSFreeMemory(buf);
                }
                if (string.IsNullOrWhiteSpace(user)) continue; // sign-in screen, nobody signed in
                result.Add(new SessionInfo(info.SessionId, user, info.State == WTSActive));
            }
        }
        finally { WTSFreeMemory(ptr); }
        return result;
    }

    /// <summary>Locks all active sessions; returns a human-readable summary.</summary>
    public static string LockActiveSessions(bool dryRun)
    {
        ProcessIdToSessionId((uint)Environment.ProcessId, out var ownSession);
        var targets = ListInteractiveSessions().Where(s => s.Active).ToList();
        var notes = new List<string>();

        if (targets.Count == 0)
        {
            // Couldn't identify a session; fall back to locking our own.
            if (!dryRun) RunLockWorkStation();
            return "No active session found; locked the agent's own session.";
        }

        foreach (var s in targets)
        {
            if (dryRun) { notes.Add($"[dry-run] would lock '{s.User}' (session {s.Id})"); continue; }

            if (s.Id == (int)ownSession)
            {
                RunLockWorkStation();
                notes.Add($"Locked '{s.User}' (session {s.Id})");
            }
            else if (WTSDisconnectSession(IntPtr.Zero, s.Id, false))
            {
                notes.Add($"Locked '{s.User}' (session {s.Id}, via session disconnect)");
            }
            else
            {
                notes.Add($"Could NOT lock '{s.User}' (session {s.Id}): Windows error {Marshal.GetLastWin32Error()}");
            }
        }
        return string.Join("; ", notes);
    }

    private static void RunLockWorkStation()
    {
        var psi = new System.Diagnostics.ProcessStartInfo("rundll32.exe", "user32.dll,LockWorkStation")
        { UseShellExecute = false, CreateNoWindow = true };
        using var p = System.Diagnostics.Process.Start(psi);
        p?.WaitForExit(5000);
    }
}
