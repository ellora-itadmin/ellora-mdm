using System.Windows.Forms;

namespace ElloraMdmAgent;

internal static class Program
{
    [STAThread]
    private static void Main(string[] rawArgs)
    {
        // "--no-elevate" is a modifier, not a command: strip it so the command
        // stays in position 0 whichever order the flags were typed.
        bool noElevate = Array.IndexOf(rawArgs, "--no-elevate") >= 0;
        var args = rawArgs.Where(a => a != "--no-elevate").ToArray();

        if (args.Length > 2 && args[0] == "--prompt")
        {
            // Started by the background service inside the signed-in user's session
            // to show the admin-password box (see PromptBroker).
            PromptBroker.RunHelper(args[1], args[2]);
            return;
        }

        if (args.Length > 0 && args[0] == "--track")
        {
            // Per-user usage helper, started at every logon by a scheduled task.
            // Runs as the signed-in user, records only app names + foreground time.
            if (!UsageTracker.TryOwnSession()) return; // this session is already being tracked
            UsageTracker.RunAsync(CancellationToken.None).GetAwaiter().GetResult();
            return;
        }

        if (args.Length > 0 && args[0] == "--usage-probe")
        {
            AgentCore.Log("Usage probe: " + UsageTracker.Probe());
            return;
        }

        if (args.Length > 0 && args[0] == "--list-sessions")
        {
            // Diagnostic only: log which sessions a Lock command would target.
            AgentCore.Log("Sessions: " + string.Join(", ", SessionLock.ListInteractiveSessions().Select(s => $"#{s.Id} {s.User} {(s.Active ? "active" : "inactive")}")));
            AgentCore.Log("Lock dry-run: " + SessionLock.LockActiveSessions(dryRun: true));
            return;
        }

        if (args.Length > 0 && args[0] == "--run")
        {
            // Headless mode: launched at logon. No window, just the check-in
            // loop running in the background. Lock/Restart execute for real
            // by default (this is a production IT tool, not a test harness) —
            // pass --dry-run to log intended actions instead of running them.
            bool allowActions = Array.IndexOf(args, "--dry-run") < 0;
            RunHeadless(allowActions).GetAwaiter().GetResult();
            return;
        }

        // Setup (GUI or CLI) must run as an administrator: that is what lets the
        // installed agent later reset local passwords and run elevated at every
        // logon. If we're not elevated, re-launch ourselves once with the
        // standard Windows UAC prompt. "--no-elevate" skips this (automated
        // tests, or if IT knowingly accepts a non-admin install).
        if (!noElevate && !Installer.IsElevated)
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo(Environment.ProcessPath!, string.Join(" ", args.Select(a => $"\"{a}\"")))
                {
                    UseShellExecute = true,
                    Verb = "runas"
                };
                System.Diagnostics.Process.Start(psi);
            }
            catch (System.ComponentModel.Win32Exception)
            {
                // User declined the UAC prompt.
                MessageBox.Show(
                    "Ellora MDM setup needs administrator permission so it can manage this device (for example, reset a forgotten Windows password).\n\nPlease run it again and choose Yes on the permission prompt.",
                    "Administrator permission required", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return;
        }

        if (args.Length > 1 && args[0] == "--enroll")
        {
            // Silent CLI enrollment for scripted/bulk deployment (same logic the GUI button runs).
            RunSilentEnroll(args[1]).GetAwaiter().GetResult();
            return;
        }

        // Default: show the enrollment/setup GUI.
        // Any unhandled exception anywhere in the GUI must show a plain,
        // readable message and let the user retry — never the raw .NET JIT
        // debugger dialog, which looks like the app is broken beyond repair.
        Application.ThreadException += (_, e) => HandleFatalGuiError(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            HandleFatalGuiError(e.ExceptionObject as Exception ?? new Exception("Unknown fatal error"));
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }

    private static void HandleFatalGuiError(Exception ex)
    {
        AgentCore.Log($"Unhandled GUI error: {ex}");
        MessageBox.Show(
            $"Something went wrong: {ex.Message}\n\nThis has been logged. Please try again, or contact IT if it keeps happening.",
            "Ellora MDM Agent Setup",
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
    }

    private static async Task RunHeadless(bool allowActions)
    {
        // Guard against two agent processes running at once (e.g. the Startup
        // supervisor and a Task Scheduler watchdog trigger overlapping) — a
        // second instance just exits immediately rather than double check-in.
        using var singleInstance = new Mutex(initiallyOwned: true, "Global\\ElloraMdmAgent_SingleInstance", out var createdNew);
        if (!createdNew)
        {
            AgentCore.Log("Another agent instance is already running — exiting.");
            return;
        }

        // Top-level safety net: RunLoopAsync already isolates each check-in
        // tick, but if it somehow still throws, restart it after a short
        // delay instead of letting the whole process (and thus monitoring)
        // go silent until the next logon or watchdog trigger.
        while (true)
        {
            using var cts = new CancellationTokenSource();
            try
            {
                await AgentCore.RunLoopAsync(allowActions, cts.Token);
                break; // RunLoopAsync only returns normally on deregistration or cancellation
            }
            catch (Exception ex)
            {
                AgentCore.Log($"Fatal error in agent loop, restarting in 30s: {ex.Message}");
                await Task.Delay(TimeSpan.FromSeconds(30));
            }
        }
    }

    private static async Task RunSilentEnroll(string code)
    {
        Console.WriteLine($"Enrolling with code {code}...");
        var enroll = await AgentCore.EnrollAsync(code, AgentCore.DefaultServerUrl);
        if (!enroll.Ok)
        {
            Console.WriteLine($"Enrollment failed: {enroll.Error}");
            Environment.Exit(1);
            return;
        }

        var config = new AgentConfig
        {
            ServerUrl = AgentCore.DefaultServerUrl,
            ApiToken = enroll.ApiToken!,
            DeviceId = enroll.DeviceId,
            DeviceUuid = enroll.DeviceUuid ?? ""
        };

        try
        {
            config.Save();
            Console.WriteLine($"Enrolled as device #{enroll.DeviceId}.");

            var (ok, message) = Installer.InstallPersistent();
            Console.WriteLine(message);
            Environment.Exit(ok ? 0 : 1);
        }
        catch (Exception ex)
        {
            AgentCore.Log($"Enrollment succeeded on the server but local install failed: {ex}");
            Console.WriteLine($"Enrolled on the server, but local setup failed: {ex.Message}");
            Environment.Exit(1);
        }
    }
}
