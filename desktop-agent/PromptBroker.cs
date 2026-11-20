using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace ElloraMdmAgent;

/// <summary>
/// Shows the "enter the admin password" box (used before a factory reset) to
/// whoever is sitting at the laptop.
///
/// When the agent runs as a SYSTEM service it lives in Windows' session 0, which
/// has no screen, so the box is started inside the signed-in user's own session
/// by a small helper (`--prompt`). The typed password comes back through a named
/// pipe that only SYSTEM and that one user can open — it never touches disk.
/// </summary>
internal static class PromptBroker
{
    [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
    [DllImport("userenv.dll", SetLastError = true)] private static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
    [DllImport("userenv.dll", SetLastError = true)] private static extern bool DestroyEnvironmentBlock(IntPtr env);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr token, string? app, string cmdLine, IntPtr procAttr, IntPtr threadAttr,
        bool inheritHandles, uint flags, IntPtr env, string? cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW_NOT_USED = 0;

    /// <summary>Copy of this build in the shared folder, runnable by standard users.</summary>
    private static readonly object SharedExeLock = new();

    public static string SharedExe()
    {
        // Serialised: the usage-helper setup and the per-session tracker launcher both
        // need this file at start-up, and copying it twice at once fails.
        lock (SharedExeLock)
        {
            var shared = Path.Combine(UsageTracker.BinDir, $"ElloraMdmAgent-{AgentCore.AgentVersion}.exe");
            Directory.CreateDirectory(UsageTracker.BinDir);
            var self = Environment.ProcessPath!;
            if (!File.Exists(shared) || new FileInfo(shared).Length != new FileInfo(self).Length)
                File.Copy(self, shared, overwrite: true);
            return shared;
        }
    }
    /// <summary>(SYSTEM only) Starts a command line inside a signed-in user's session, as that user.</summary>
    public static bool LaunchInSession(int sessionId, string cmdLine)
    {
        if (!WTSQueryUserToken((uint)sessionId, out var token)) return false;
        try
        {
            CreateEnvironmentBlock(out var env, token, false);
            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = "winsta0\\default" };
            var ok = CreateProcessAsUser(token, null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT, env, null, ref si, out var pi);
            if (ok) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
            return ok;
        }
        finally { CloseHandle(token); }
    }

    /// <summary>
    /// (SYSTEM only) Makes sure every signed-in session has its usage tracker. A
    /// tracker that is already running there just exits (one per session), so
    /// this is safe to repeat; it also covers users who stay signed in for days.
    /// </summary>
    public static void EnsureTrackersInAllSessions()
    {
        try
        {
            var exe = SharedExe();
            foreach (var s in SessionLock.ListInteractiveSessions().Where(x => x.Active))
                LaunchInSession(s.Id, $"\"{exe}\" --track");
        }
        catch (Exception ex) { AgentCore.Log($"Starting usage trackers in user sessions failed: {ex.Message}"); }
    }

    public static async Task<string?> AskPasswordAsync(string reason, TimeSpan timeout)
    {
        // Not a service (a user-level agent has its own desktop): show it directly.
        if (!AgentConfig.IsSystemAccount)
            return await Task.Run(() => PasswordPromptForm.ShowAndWait(reason, timeout));

        var sessionId = SessionLock.ActiveSessionId();
        if (sessionId == null) { AgentCore.Log("Wipe: nobody is signed in to show the password box to."); return null; }

        if (!WTSQueryUserToken((uint)sessionId.Value, out var userToken))
        { AgentCore.Log($"Wipe: could not reach the signed-in user's session (error {Marshal.GetLastWin32Error()})."); return null; }

        try
        {
            using var identity = new WindowsIdentity(userToken);
            var pipeName = "ellora_prompt_" + Guid.NewGuid().ToString("N");

            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(identity.User!, PipeAccessRights.Write | PipeAccessRights.Synchronize, AccessControlType.Allow));

            using var server = NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.In, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, security);

            var shared = SharedExe();
            var reasonB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(reason));
            var cmd = $"\"{shared}\" --prompt {pipeName} {reasonB64}";

            CreateEnvironmentBlock(out var env, userToken, false);
            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = "winsta0\\default" };
            if (!CreateProcessAsUser(userToken, null, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT, env, null, ref si, out var pi))
            {
                AgentCore.Log($"Wipe: could not start the password box in the user's session (error {Marshal.GetLastWin32Error()}).");
                if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
                return null;
            }
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);

            using var cts = new CancellationTokenSource(timeout + TimeSpan.FromSeconds(10));
            try { await server.WaitForConnectionAsync(cts.Token); }
            catch (OperationCanceledException) { return null; }

            using var reader = new StreamReader(server, Encoding.UTF8);
            var line = await reader.ReadLineAsync();
            return string.IsNullOrEmpty(line) ? null : line;
        }
        finally { CloseHandle(userToken); }
    }

    /// <summary>Runs inside the user's session (`--prompt`): shows the box and sends the answer back through the pipe.</summary>
    public static void RunHelper(string pipeName, string reasonB64)
    {
        string reason;
        try { reason = Encoding.UTF8.GetString(Convert.FromBase64String(reasonB64)); }
        catch { reason = "An administrator has requested a factory reset of this device."; }

        var password = PasswordPromptForm.ShowAndWait(reason, TimeSpan.FromMinutes(2));
        try
        {
            using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out);
            client.Connect(5000);
            using var writer = new StreamWriter(client, Encoding.UTF8) { AutoFlush = true };
            writer.WriteLine(password ?? "");
        }
        catch { /* the agent side times out and treats this as "cancelled" */ }
    }
}
