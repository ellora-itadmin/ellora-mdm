using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;

namespace ElloraMdmAgent;

/// <summary>
/// Runs the agent as a SYSTEM scheduled task that starts at boot, instead of as
/// whichever Windows user happened to install it. A user-level agent only runs
/// while that one user is signed in, so on a laptop where staff use a different
/// account the device simply vanished from the dashboard.
/// </summary>
internal static class ServiceMode
{
    public const string ServiceTask = "ElloraMDMService";
    public const string ServiceWatchdogTask = "ElloraMDMServiceWatchdog";

    /// <summary>Creates the service folder readable only by SYSTEM and Administrators (it holds the device token).</summary>
    public static void SecureDataDir()
    {
        var di = Directory.CreateDirectory(AgentConfig.DataDir);
        var sec = new DirectorySecurity();
        sec.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        di.SetAccessControl(sec);
    }

    public static string ServiceExe => Path.Combine(AgentConfig.DataDir, "ElloraMdmAgent.exe");

    /// <summary>Registers the two SYSTEM tasks (at boot + 5-minute watchdog) with battery/time-limit defaults removed.</summary>
    public static (bool ok, string output) RegisterTasks()
    {
        var tr = $"\\\"{ServiceExe}\\\" --run";
        var (ok1, out1) = Installer.Schtasks($"/Create /TN \"{ServiceTask}\" /TR \"{tr}\" /SC ONSTART /RU SYSTEM /RL HIGHEST /F");
        if (!ok1) return (false, out1);
        Installer.Schtasks($"/Create /TN \"{ServiceWatchdogTask}\" /TR \"{tr}\" /SC MINUTE /MO 5 /RU SYSTEM /RL HIGHEST /F");

        var fix =
            "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries " +
            "-StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; " +
            $"foreach ($n in '{ServiceTask}','{ServiceWatchdogTask}') {{ Set-ScheduledTask -TaskName $n -Settings $s | Out-Null }}";
        var psi = new ProcessStartInfo("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{fix}\"")
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        using var proc = Process.Start(psi)!;
        var err = proc.StandardError.ReadToEnd();
        proc.WaitForExit(30_000);
        if (proc.ExitCode != 0) AgentCore.Log($"Could not relax service task settings: {err.Trim()}");
        return (true, "");
    }

    /// <summary>Removes the old per-user tasks and Startup launcher once the service has taken over.</summary>
    public static void RemoveUserLevelTasks()
    {
        Installer.Schtasks($"/Delete /TN \"{Installer.TaskName}\" /F");
        Installer.Schtasks($"/Delete /TN \"{Installer.WatchdogTaskName}\" /F");
        try { File.Delete(Installer.StartupLauncherFile); } catch { }
    }

    /// <summary>
    /// Called by an already-running ELEVATED user-level agent (after its first
    /// successful check-in). Sets up the service beside it, hands over, and
    /// verifies: if the service hasn't reported healthy within 90 seconds, the
    /// service tasks are removed and the user-level agent is started again, so
    /// a failed migration can never leave a laptop without an agent.
    /// </summary>
    public static void MigrateFromUserAgent()
    {
        try
        {
            if (AgentConfig.IsSystemAccount || !Installer.IsElevated) return;
            if (Path.GetFullPath(AgentConfig.InstallDir).Equals(Path.GetFullPath(AgentConfig.DataDir), StringComparison.OrdinalIgnoreCase)
                && Path.GetFullPath(Environment.ProcessPath ?? "").StartsWith(Path.GetFullPath(AgentConfig.DataDir), StringComparison.OrdinalIgnoreCase))
                return; // already running from the service folder

            var legacyDir = AgentConfig.LegacyDir;
            var failedMarker = Path.Combine(legacyDir, "service-failed.txt");
            if (File.Exists(failedMarker) && File.ReadAllText(failedMarker).Trim() == AgentCore.AgentVersion) return;

            var config = AgentConfig.Load();
            var self = Environment.ProcessPath;
            if (config == null || string.IsNullOrEmpty(self)) return;

            AgentCore.Log("Setting up background service mode (runs for every user, starts at boot)...");
            SecureDataDir();
            File.Copy(self, ServiceExe, overwrite: true);

            // Same device identity in the protected folder.
            Directory.CreateDirectory(AgentConfig.DataDir);
            File.WriteAllText(Path.Combine(AgentConfig.DataDir, "agent-config.json"),
                System.Text.Json.JsonSerializer.Serialize(config, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            try { File.Delete(Path.Combine(AgentConfig.DataDir, "healthy.txt")); } catch { }

            var (ok, outp) = RegisterTasks();
            if (!ok) { AgentCore.Log($"Service tasks could not be registered ({outp.Trim()}); staying in user mode."); File.WriteAllText(failedMarker, AgentCore.AgentVersion); return; }

            var healthy = Path.Combine(AgentConfig.DataDir, "healthy.txt");
            var batch =
                "@echo off\r\n" +
                "ping -n 4 127.0.0.1 >nul\r\n" +
                $"schtasks /Run /TN \"{ServiceTask}\" >nul 2>&1\r\n" +
                "ping -n 91 127.0.0.1 >nul\r\n" +
                $"if exist \"{healthy}\" goto ok\r\n" +
                $"schtasks /Delete /TN \"{ServiceTask}\" /F >nul 2>&1\r\n" +
                $"schtasks /Delete /TN \"{ServiceWatchdogTask}\" /F >nul 2>&1\r\n" +
                "taskkill /f /im ElloraMdmAgent.exe >nul 2>&1\r\n" +
                $"echo {AgentCore.AgentVersion}> \"{failedMarker}\"\r\n" +
                $"start \"\" \"{self}\" --run\r\n" +
                "goto end\r\n" +
                ":ok\r\n" +
                $"schtasks /Delete /TN \"{Installer.TaskName}\" /F >nul 2>&1\r\n" +
                $"schtasks /Delete /TN \"{Installer.WatchdogTaskName}\" /F >nul 2>&1\r\n" +
                $"del /q \"{Installer.StartupLauncherFile}\" >nul 2>&1\r\n" +
                // An update started by an older agent checks legacy\healthy.txt about 2 minutes after
                // launch. Keep that folder until well after, then remove the leftover per-user install.
                "ping -n 91 127.0.0.1 >nul\r\n" +
                $"rmdir /s /q \"{legacyDir}\" >nul 2>&1\r\n" +
                ":end\r\n";
            var batchPath = Path.Combine(Path.GetTempPath(), $"ellora_service_{Guid.NewGuid():N}.cmd");
            File.WriteAllText(batchPath, batch);
            Process.Start(new ProcessStartInfo("cmd.exe", $"/c \"{batchPath}\"")
            { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });

            AgentCore.Log("Handing over to the background service; this user-level agent is exiting.");
            Environment.Exit(0); // releases the single-instance lock so the service instance can start
        }
        catch (Exception ex) { AgentCore.Log($"Service migration failed (staying in user mode): {ex.Message}"); }
    }
}
