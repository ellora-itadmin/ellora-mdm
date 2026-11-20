using System.Diagnostics;
using System.Management;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace ElloraMdmAgent;

/// <summary>
/// Best-effort local defense against a device user running Windows's own
/// "Reset this PC" without going through the dashboard's password-gated Wipe
/// command. Two layers, both with hard technical limits that are documented
/// inline — this can deter and alert, but cannot guarantee prevention against
/// a local Administrator account (only removing admin rights, or genuine
/// Windows MDM/Intune enrollment, can truly guarantee that):
///
///   1. Hides the "Recovery" page in Settings via registry policy (soft
///      deterrent — a local admin can revert this).
///   2. Watches for the OS reset process starting via a WMI event
///      subscription and, the instant it's seen, tries to kill it (works
///      only if the agent process has sufficient rights) and immediately
///      alerts the dashboard regardless of whether the kill succeeded.
/// </summary>
public static class ResetWatcher
{
    private static readonly string[] ResetProcessNames = { "systemreset.exe", "resetengine.exe", "SystemResetPlatform.exe" };
    private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
    private static ManagementEventWatcher? _watcher;

    /// <summary>
    /// Hides Settings > System > Recovery via the documented SettingsPageVisibility
    /// group policy registry value. Requires the user to sign out/in (or Explorer
    /// restart) to take effect. Silently no-ops if the registry write fails
    /// (e.g. agent not running with sufficient rights) — this is defense in
    /// depth, not the primary safeguard.
    /// </summary>
    public static void ApplySettingsHardening()
    {
        try
        {
            using var key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer");
            key?.SetValue("SettingsPageVisibility", "hide:recovery", RegistryValueKind.String);
            AgentCore.Log("Applied registry policy to hide Settings > Recovery page.");
        }
        catch (Exception ex)
        {
            AgentCore.Log($"Could not hide Recovery settings page (non-fatal): {ex.Message}");
        }
    }

    /// <summary>
    /// Starts a background WMI subscription that fires the instant a reset
    /// process is created. Safe to call once per agent process lifetime.
    /// </summary>
    public static void Start(AgentConfig config)
    {
        try
        {
            var nameFilter = string.Join(" OR ", Array.ConvertAll(ResetProcessNames, n => $"TargetInstance.Name = '{n}'"));
            var query = new WqlEventQuery(
                $"SELECT * FROM __InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process' AND ({nameFilter})");

            _watcher = new ManagementEventWatcher(query);
            _watcher.EventArrived += (sender, e) => OnResetProcessDetected(config, e);
            _watcher.Start();
            AgentCore.Log("Local factory-reset watcher started.");
        }
        catch (Exception ex)
        {
            AgentCore.Log($"Could not start reset watcher (non-fatal, detection disabled): {ex.Message}");
        }
    }

    private static void OnResetProcessDetected(AgentConfig config, EventArrivedEventArgs e)
    {
        try
        {
            var proc = (ManagementBaseObject)e.NewEvent["TargetInstance"];
            var name = proc["Name"]?.ToString() ?? "unknown";
            var pid = Convert.ToInt32(proc["ProcessId"]);

            AgentCore.Log($"DETECTED local reset attempt: process '{name}' (pid={pid}) started. Attempting to block and alerting admin.");

            string blockNote;
            try
            {
                Process.GetProcessById(pid).Kill();
                blockNote = "Agent attempted to terminate the reset process.";
                AgentCore.Log("Reset process terminated by agent.");
            }
            catch (Exception killEx)
            {
                blockNote = $"Agent could NOT terminate the reset process (insufficient rights or already progressed): {killEx.Message}";
                AgentCore.Log(blockNote);
            }

            // Fire-and-forget the alert — don't let this crash the watcher thread.
            _ = RaiseAlertAsync(config,
                "local_reset_attempt",
                "critical",
                $"A factory reset was started locally on this device (process: {name}) without going through the Ellora MDM dashboard. {blockNote}");
        }
        catch (Exception ex)
        {
            AgentCore.Log($"Error handling reset detection event: {ex.Message}");
        }
    }

    private static async Task RaiseAlertAsync(AgentConfig config, string type, string severity, string message)
    {
        try
        {
            var payload = JsonSerializer.Serialize(new { type, severity, message });
            var content = new StringContent(payload, Encoding.UTF8, "application/json");
            var req = new HttpRequestMessage(HttpMethod.Post, $"{config.ServerUrl.TrimEnd('/')}/api/agent/alert") { Content = content };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ApiToken);
            await Http.SendAsync(req);
        }
        catch (Exception ex) { AgentCore.Log($"Failed to send reset-attempt alert: {ex.Message}"); }
    }
}
