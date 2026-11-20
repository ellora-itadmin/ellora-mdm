using System.Diagnostics;

namespace ElloraMdmAgent;

public static class Installer
{
    public const string TaskName = "ElloraMDMAgent";
    public const string WatchdogTaskName = "ElloraMDMAgentWatchdog";

    private static string StartupFolder =>
        Environment.GetFolderPath(Environment.SpecialFolder.Startup);

    private static string StartupLauncherPath =>
        Path.Combine(StartupFolder, "ElloraMdmAgent.cmd");

    internal static string StartupLauncherFile => StartupLauncherPath;
    internal static (bool ok, string output) Schtasks(string args) => RunSchtasks(args);

    public static bool IsElevated
    {
        get
        {
            try
            {
                using var id = System.Security.Principal.WindowsIdentity.GetCurrent();
                return new System.Security.Principal.WindowsPrincipal(id)
                    .IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }
    }

    /// <summary>
    /// Copies the currently running exe to the permanent install location
    /// (if not already running from there) and registers it to auto-start
    /// at logon, then starts it immediately.
    ///
    /// Two auto-start mechanisms are attempted:
    ///   1. Task Scheduler (preferred — survives even if the exe is moved later)
    ///   2. Startup folder launcher script (fallback — works without any elevated
    ///      or Task Scheduler privileges, which some locked-down environments deny)
    /// Either one succeeding is enough for the agent to persist across reboots.
    /// </summary>
    public static (bool ok, string message) InstallPersistent()
    {
        // Preferred: install as a SYSTEM background service so the agent runs for
        // every user and starts at boot. Only possible when setup is elevated.
        string? serviceNote = null;
        if (IsElevated && !AgentConfig.IsSystemAccount)
        {
            var svc = InstallAsService();
            if (svc.ok) return svc;
            serviceNote = svc.message;
        }

        try
        {
            var currentExe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule!.FileName;
            Directory.CreateDirectory(AgentConfig.InstallDir);

            if (!string.Equals(Path.GetFullPath(currentExe), Path.GetFullPath(AgentConfig.ExePath), StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(currentExe, AgentConfig.ExePath, overwrite: true);
            }

            bool persisted = false;
            bool elevatedTaskOk = false;
            var notes = new List<string>();

            // One scheduled task with TWO triggers: at logon, and every 5 minutes
            // as a watchdog (a second instance exits immediately thanks to the
            // single-instance mutex, so overlapping is harmless).
            //
            // It is registered from XML rather than `schtasks /SC` flags because
            // the flag form leaves Windows' defaults, which are wrong for an
            // always-on agent: "don't start on battery", "STOP when the laptop
            // goes on battery" and a hard 72-hour limit. Those silently killed
            // the agent whenever a laptop was unplugged, with no log entry and no
            // restart. Here battery power and time limits are explicitly off.
            // When setup is elevated the task runs at the highest run level, so
            // the agent starts elevated at every logon with no UAC prompt.
            try
            {
                var (createOk, createOut) = RegisterAgentTask(IsElevated);
                if (createOk)
                {
                    persisted = true;
                    elevatedTaskOk = IsElevated;
                    notes.Add(IsElevated
                        ? "Registered elevated scheduled tasks (logon + 5-minute watchdog; run on battery, no time limit)."
                        : "Registered scheduled tasks (logon + 5-minute watchdog; run on battery), NOT elevated.");
                }
                else
                {
                    notes.Add($"Task Scheduler registration skipped: {createOut.Trim()}");
                }
            }
            catch (Exception ex) { notes.Add($"Task Scheduler registration skipped: {ex.Message}"); }
            // Attempt 2: Startup folder launcher — no special privileges required.
            // Skipped when the elevated task exists: a Startup launcher is never
            // elevated, and if it won the single-instance race at logon the agent
            // would silently run without admin rights.
            if (elevatedTaskOk)
            {
                try { File.Delete(StartupLauncherPath); } catch { }
            }
            else
            {
                try
                {
                    Directory.CreateDirectory(StartupFolder);
                    var script = $"@echo off{Environment.NewLine}start \"\" /min \"{AgentConfig.ExePath}\" --run{Environment.NewLine}";
                    File.WriteAllText(StartupLauncherPath, script);
                    persisted = true;
                    notes.Add("Added a Startup-folder launcher (runs at logon for the current user).");
                }
                catch (Exception ex) { notes.Add($"Startup folder launcher failed: {ex.Message}"); }
            }

            if (!persisted)
                return (false, "Could not register any auto-start method: " + string.Join(" ", notes));

            // Stop any older (possibly non-elevated) agent still running, otherwise
            // it keeps the single-instance lock and the new elevated one would exit.
            try
            {
                var self = Environment.ProcessId;
                foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(AgentConfig.ExePath)))
                {
                    if (p.Id == self) continue;
                    try { p.Kill(); p.WaitForExit(3000); } catch { }
                }
            }
            catch { }

            // Start it right now too, so it's active immediately without a reboot/relogin.
            try
            {
                var psi = new ProcessStartInfo(AgentConfig.ExePath, "--run") { UseShellExecute = false, CreateNoWindow = true };
                Process.Start(psi);
            }
            catch (Exception ex) { notes.Add($"Could not start agent immediately (will start at next logon): {ex.Message}"); }

            return (true, "Agent installed and running. " + (serviceNote != null ? "(Service mode unavailable: " + serviceNote + ") " : "") + string.Join(" ", notes));
        }
        catch (Exception ex)
        {
            return (false, $"Install failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Installs the agent as a SYSTEM scheduled task that starts at boot, with its
    /// config and exe in a folder only SYSTEM/Administrators can read.
    /// </summary>
    private static (bool ok, string message) InstallAsService()
    {
        try
        {
            var currentExe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule!.FileName;
            var cfg = AgentConfig.Load();
            if (cfg == null) return (false, "No enrollment found to install as a service.");

            ServiceMode.SecureDataDir();
            File.WriteAllText(Path.Combine(AgentConfig.DataDir, "agent-config.json"),
                System.Text.Json.JsonSerializer.Serialize(cfg, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));

            if (!string.Equals(Path.GetFullPath(currentExe), Path.GetFullPath(ServiceMode.ServiceExe), StringComparison.OrdinalIgnoreCase))
                File.Copy(currentExe, ServiceMode.ServiceExe, overwrite: true);

            // Stop any older agent first, otherwise it keeps the single-instance lock.
            var self = Environment.ProcessId;
            foreach (var p in Process.GetProcessesByName("ElloraMdmAgent"))
            {
                if (p.Id == self) continue;
                try { p.Kill(); p.WaitForExit(3000); } catch { }
            }

            var (ok, outp) = ServiceMode.RegisterTasks();
            if (!ok) return (false, $"Service task registration failed: {outp.Trim()}");

            ServiceMode.RemoveUserLevelTasks();
            RunSchtasks($"/Run /TN \"{ServiceMode.ServiceTask}\"");
            return (true, "Agent installed as a background service: it starts at boot and runs for every user, whoever is signed in.");
        }
        catch (Exception ex) { return (false, $"Service install failed: {ex.Message}"); }
    }
    /// <summary>
    /// Removes all auto-start registration and local config when the server
    /// says this device is no longer enrolled (its api_token was deleted from
    /// the dashboard). Leaves the machine clean and available for future
    /// re-enrollment. The running exe can't delete itself while it's the
    /// active process, so it schedules a delayed cleanup via a detached
    /// helper command after this process exits.
    /// </summary>
    public static void Deregister()
    {
        try { RunSchtasks($"/Delete /TN \"{TaskName}\" /F"); } catch { }
        try { RunSchtasks($"/Delete /TN \"{WatchdogTaskName}\" /F"); } catch { }
        try { RunSchtasks($"/Delete /TN \"{ServiceMode.ServiceTask}\" /F"); } catch { }
        try { RunSchtasks($"/Delete /TN \"{ServiceMode.ServiceWatchdogTask}\" /F"); } catch { }
        try { RunSchtasks("/Delete /TN \"ElloraMDMUsage\" /F"); } catch { }
        try { File.Delete(StartupLauncherPath); } catch { }
        try { File.Delete(AgentConfig.ConfigPath); } catch { }

        AgentCore.Log("Deregistered: removed auto-start entries and local config. This device is now available for re-enrollment.");

        // Delay-delete the install directory (including this running exe) via
        // a detached cmd helper, since a running exe can't delete its own file.
        try
        {
            var installDir = AgentConfig.InstallDir;
            var shared = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ElloraMDM");
            var cmd = $"/c ping -n 4 127.0.0.1 >nul & taskkill /f /fi \"IMAGENAME eq ElloraMdmAgent*\" >nul 2>&1 & ping -n 3 127.0.0.1 >nul & rmdir /s /q \"{installDir}\" & rmdir /s /q \"{shared}\" & rmdir /s /q \"{AgentConfig.LegacyDir}\" & ping -n 5 127.0.0.1 >nul & rmdir /s /q \"{installDir}\" & rmdir /s /q \"{shared}\"";
            var psi = new ProcessStartInfo("cmd.exe", cmd)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(psi);
        }
        catch { /* best-effort cleanup only */ }
    }

    /// <summary>
    /// Registers two tasks with the proven `schtasks` flags (logon trigger plus
    /// a 5-minute watchdog), then corrects their settings. The flag form
    /// leaves Windows' defaults, which are wrong for an always-on agent:
    /// "don't start on battery", "STOP when the laptop goes on battery" and a
    /// hard 72-hour limit. Those silently killed the agent whenever a laptop
    /// was unplugged, with no log entry and no restart.
    /// </summary>
    private static (bool ok, string output) RegisterAgentTask(bool elevated)
    {
        var runLevel = elevated ? "HIGHEST" : "LIMITED";
        var tr = $"\\\"{AgentConfig.ExePath}\\\" --run";

        var (logonOk, logonOut) = RunSchtasks($"/Create /TN \"{TaskName}\" /TR \"{tr}\" /SC ONLOGON /RL {runLevel} /F");
        if (!logonOk) return (false, logonOut);

        // A second instance exits at once (single-instance mutex), so the
        // watchdog overlapping a healthy agent is harmless.
        RunSchtasks($"/Create /TN \"{WatchdogTaskName}\" /TR \"{tr}\" /SC MINUTE /MO 5 /RL {runLevel} /F");

        var fix =
            "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries " +
            "-StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; " +
            $"foreach ($n in '{TaskName}','{WatchdogTaskName}') {{ Set-ScheduledTask -TaskName $n -Settings $s | Out-Null }}";
        var psi = new ProcessStartInfo("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{fix}\"")
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        using var proc = Process.Start(psi)!;
        var err = proc.StandardError.ReadToEnd();
        proc.WaitForExit(30_000);
        if (proc.ExitCode != 0)
            AgentCore.Log($"Could not relax task battery/time-limit settings: {err.Trim()}");
        return (true, "");
    }
    private static (bool ok, string output) RunSchtasks(string args)
    {
        var psi = new ProcessStartInfo("schtasks.exe", args)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using var proc = Process.Start(psi)!;
        string stdout = proc.StandardOutput.ReadToEnd();
        string stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit(15_000);
        return (proc.ExitCode == 0, string.IsNullOrWhiteSpace(stderr) ? stdout : stderr);
    }
}
