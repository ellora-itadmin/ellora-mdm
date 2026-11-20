using System.Diagnostics.Eventing.Reader;
using System.Linq;
using System.Management;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ElloraMdmAgent;

/// <summary>
/// Core agent logic shared by the GUI enrollment flow and the headless
/// background check-in loop. Mirrors the behavior of the Node.js agent
/// (agent/agent.js) so both stay compatible with the same API.
/// </summary>
public static class AgentCore
{
    // Bumped by hand each time a new build is rolled out. Reported on every
    // check-in so the dashboard can show per-device version and target a
    // rollout's "update_agent" command only at devices actually behind.
    public const string AgentVersion = "2026.10.26.6";

    public const string DefaultServerUrl = "https://ellora-mdm-api.it-admin-cf1.workers.dev";
    // Where the agent downloads its own replacement from when it receives an
    // "update_agent" command. The compiled exe (~70MB) exceeds Cloudflare
    // Workers' 25MB static-asset limit, so it's hosted as numbered chunks
    // (chunk-0.bin, chunk-1.bin, ...) plus a manifest.json describing how
    // many there are and the expected SHA-256 of the reassembled file —
    // all under this base folder URL.
    public const string UpdateDownloadUrl = "https://ellora-mdm-web.it-admin-cf1.workers.dev/agent-update/";
    // Lowered from 60s so dashboard-issued commands (Lock/Restart/Wipe) and
    // fresh inventory land within ~15s typically, worst case one interval,
    // instead of up to a minute. Still a single small POST — negligible load.
    public const int CheckinIntervalMs = 15_000;

    private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };

    private static string LogPathOrDefault() => AgentConfig.LogPath;

    public static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(AgentConfig.InstallDir);
            File.AppendAllText(AgentConfig.LogPath, $"[{DateTime.UtcNow:o}] {message}{Environment.NewLine}");
        }
        catch { /* logging must never crash the agent */ }
    }

    public record EnrollResult(bool Ok, string? ApiToken, long DeviceId, string? DeviceUuid, string? Error);

    public static async Task<EnrollResult> EnrollAsync(string enrollmentCode, string serverUrl)
    {
        try
        {
            var payload = JsonSerializer.Serialize(new
            {
                enrollment_code = enrollmentCode.Trim(),
                hostname = Environment.MachineName,
                platform = "windows"
            });
            var content = new StringContent(payload, Encoding.UTF8, "application/json");
            var res = await Http.PostAsync($"{serverUrl.TrimEnd('/')}/api/agent/enroll", content);
            var body = await res.Content.ReadAsStringAsync();

            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;

            if (!res.IsSuccessStatusCode)
            {
                var err = root.TryGetProperty("error", out var e) ? e.GetString() : res.ReasonPhrase;
                return new EnrollResult(false, null, 0, null, err);
            }

            var apiToken = root.GetProperty("api_token").GetString()!;
            var deviceId = root.GetProperty("device_id").GetInt64();
            var deviceUuid = root.GetProperty("device_uuid").GetString();
            return new EnrollResult(true, apiToken, deviceId, deviceUuid, null);
        }
        catch (Exception ex)
        {
            return new EnrollResult(false, null, 0, null, ex.Message);
        }
    }

    public class Inventory
    {
        [JsonPropertyName("hostname")] public string Hostname { get; set; } = Environment.MachineName;
        [JsonPropertyName("platform")] public string Platform { get; set; } = "windows";
        [JsonPropertyName("os_version")] public string OsVersion { get; set; } = "";
        [JsonPropertyName("arch")] public string Arch { get; set; } = "";
        [JsonPropertyName("total_memory_mb")] public long TotalMemoryMb { get; set; }
        [JsonPropertyName("free_memory_mb")] public long FreeMemoryMb { get; set; }
        [JsonPropertyName("cpu_model")] public string CpuModel { get; set; } = "";
        [JsonPropertyName("uptime_seconds")] public long UptimeSeconds { get; set; }
        [JsonPropertyName("serial_number")] public string? SerialNumber { get; set; }
        [JsonPropertyName("latitude")] public double? Latitude { get; set; }
        [JsonPropertyName("longitude")] public double? Longitude { get; set; }
        [JsonPropertyName("location_label")] public string? LocationLabel { get; set; }
        [JsonPropertyName("agent_version")] public string AgentVersion { get; set; } = AgentCore.AgentVersion;
        [JsonPropertyName("logged_in_user")] public string? LoggedInUser { get; set; } = SessionLock.CurrentUserName();
        [JsonPropertyName("is_elevated")] public bool IsElevated { get; set; } = Installer.IsElevated;
        [JsonPropertyName("local_users")] public List<string>? LocalUsers { get; set; }
    }

    // Approximate, IP-based location — NOT precise GPS. Windows laptops have no
    // GPS radio; this is a best-effort city-level lookup via a free geo-IP API.
    private static DateTime _lastLocationCheckUtc = DateTime.MinValue;
    private static readonly TimeSpan LocationRefreshInterval = TimeSpan.FromMinutes(15);
    private static (double lat, double lon, string label)? _cachedLocation;

    private static async Task<(double lat, double lon, string label)?> GetApproxLocationAsync()
    {
        if (DateTime.UtcNow - _lastLocationCheckUtc < LocationRefreshInterval && _cachedLocation != null)
            return _cachedLocation;

        try
        {
            var res = await Http.GetAsync("https://ipwho.is/");
            if (!res.IsSuccessStatusCode) return _cachedLocation;
            var body = await res.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("success", out var s) && !s.GetBoolean()) return _cachedLocation;
            if (!root.TryGetProperty("latitude", out var latEl) || !root.TryGetProperty("longitude", out var lonEl))
                return _cachedLocation;

            var lat = latEl.GetDouble();
            var lon = lonEl.GetDouble();
            var city = root.TryGetProperty("city", out var c) ? c.GetString() : null;
            var region = root.TryGetProperty("region", out var r) ? r.GetString() : null;
            var country = root.TryGetProperty("country", out var co) ? co.GetString() : null;
            var label = string.Join(", ", new[] { city, region, country }.Where(s2 => !string.IsNullOrWhiteSpace(s2)));

            _cachedLocation = (lat, lon, label);
            _lastLocationCheckUtc = DateTime.UtcNow;
        }
        catch (Exception ex) { Log($"IP geolocation lookup failed: {ex.Message}"); }

        return _cachedLocation;
    }

    // Enabled local accounts, for the dashboard's password-reset dropdown.
    // The WMI account query is slowish, so it's cached rather than run on
    // every 15s check-in.
    private static List<string>? _cachedLocalUsers;
    private static DateTime _localUsersAtUtc = DateTime.MinValue;

    private static List<string> GetLocalUsers()
    {
        if (_cachedLocalUsers != null && DateTime.UtcNow - _localUsersAtUtc < TimeSpan.FromMinutes(10))
            return _cachedLocalUsers;

        var users = new List<string>();
        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT Name, Disabled FROM Win32_UserAccount WHERE LocalAccount = True");
            foreach (var obj in searcher.Get())
            {
                var name = obj["Name"]?.ToString();
                var disabled = obj["Disabled"] is bool b && b;
                if (string.IsNullOrWhiteSpace(name) || disabled) continue;
                // Built-in accounts nobody signs in with.
                if (name is "DefaultAccount" or "Guest" or "WDAGUtilityAccount") continue;
                users.Add(name);
            }
            users.Sort(StringComparer.OrdinalIgnoreCase);
            _cachedLocalUsers = users;
            _localUsersAtUtc = DateTime.UtcNow;
        }
        catch (Exception ex) { Log($"Local user enumeration failed: {ex.Message}"); }

        return _cachedLocalUsers ?? users;
    }

    public static Inventory CollectInventory()
    {
        var inv = new Inventory
        {
            LocalUsers = GetLocalUsers(),
            OsVersion = $"{Environment.OSVersion.VersionString}",
            Arch = Environment.Is64BitOperatingSystem ? "x64" : "x86",
            UptimeSeconds = (long)(Environment.TickCount64 / 1000)
        };

        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT TotalVisibleMemorySize, FreePhysicalMemory FROM Win32_OperatingSystem");
            foreach (var obj in searcher.Get())
            {
                inv.TotalMemoryMb = Convert.ToInt64(obj["TotalVisibleMemorySize"]) / 1024;
                inv.FreeMemoryMb = Convert.ToInt64(obj["FreePhysicalMemory"]) / 1024;
            }
        }
        catch (Exception ex) { Log($"WMI memory query failed: {ex.Message}"); }

        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT Name FROM Win32_Processor");
            foreach (var obj in searcher.Get())
            {
                inv.CpuModel = obj["Name"]?.ToString()?.Trim() ?? "unknown";
                break;
            }
        }
        catch (Exception ex) { Log($"WMI CPU query failed: {ex.Message}"); }

        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT SerialNumber FROM Win32_BIOS");
            foreach (var obj in searcher.Get())
            {
                var sn = obj["SerialNumber"]?.ToString()?.Trim();
                // Many VMs/laptops report a placeholder like "System Serial Number" or "To be filled by O.E.M." — treat those as unknown.
                if (!string.IsNullOrWhiteSpace(sn) && !sn.Contains("O.E.M", StringComparison.OrdinalIgnoreCase)
                    && !sn.Equals("System Serial Number", StringComparison.OrdinalIgnoreCase))
                {
                    inv.SerialNumber = sn;
                }
                break;
            }
        }
        catch (Exception ex) { Log($"WMI BIOS serial query failed: {ex.Message}"); }

        return inv;
    }

    public record CheckinCommand(long Id, string Type, JsonElement? Payload);
    public record CheckinResult(bool Ok, List<CheckinCommand> Commands, string? Error, int StatusCode = 0);

    public static async Task<CheckinResult> CheckinAsync(AgentConfig config)
    {
        try
        {
            var inv = CollectInventory();
            var loc = await GetApproxLocationAsync();
            if (loc != null)
            {
                inv.Latitude = loc.Value.lat;
                inv.Longitude = loc.Value.lon;
                inv.LocationLabel = loc.Value.label;
            }
            var payload = JsonSerializer.Serialize(new { inventory = inv });
            var content = new StringContent(payload, Encoding.UTF8, "application/json");
            var req = new HttpRequestMessage(HttpMethod.Post, $"{config.ServerUrl.TrimEnd('/')}/api/agent/checkin") { Content = content };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ApiToken);

            var res = await Http.SendAsync(req);
            var body = await res.Content.ReadAsStringAsync();
            if (!res.IsSuccessStatusCode) return new CheckinResult(false, new(), body, (int)res.StatusCode);

            using var doc = JsonDocument.Parse(body);
            var commands = new List<CheckinCommand>();
            if (doc.RootElement.TryGetProperty("commands", out var cmdsEl))
            {
                foreach (var c in cmdsEl.EnumerateArray())
                {
                    commands.Add(new CheckinCommand(
                        c.GetProperty("id").GetInt64(),
                        c.GetProperty("type").GetString() ?? "",
                        // .Clone() is required: without it this JsonElement stays tied to
                        // the enclosing `using var doc` below, which gets disposed when
                        // CheckinAsync returns — any later read (e.g. HandleUpdateAgentAsync
                        // reading download_url) would throw ObjectDisposedException.
                        c.TryGetProperty("payload", out var p) ? p.Clone() : null
                    ));
                }
            }
            return new CheckinResult(true, commands, null, (int)res.StatusCode);
        }
        catch (Exception ex)
        {
            return new CheckinResult(false, new(), ex.Message);
        }
    }

    private record ShippableEvent(string log_name, string level, string? source, int? event_id, string message, string logged_at);

    /// <summary>
    /// Reads new System/Application (and, if permitted, Security) event log
    /// entries since the last sync and ships them to the dashboard's audit
    /// trail. Only Critical and Error entries are shipped, to keep this
    /// meaningful rather than noisy. Security log access commonly requires
    /// elevated rights; failures there are logged and skipped, not fatal.
    /// </summary>
    private static DateTime _lastEventsShipCheckUtc = DateTime.MinValue;
    private static readonly TimeSpan EventsShipInterval = TimeSpan.FromMinutes(5);

    public static async Task ShipEventLogsAsync(AgentConfig config)
    {
        if (DateTime.UtcNow - _lastEventsShipCheckUtc < EventsShipInterval) return;
        _lastEventsShipCheckUtc = DateTime.UtcNow;

        var sinceUtc = DateTime.TryParse(config.LastEventsSyncUtc, null,
            System.Globalization.DateTimeStyles.RoundtripKind, out var parsed)
            ? parsed
            : DateTime.UtcNow.AddHours(-1);

        var events = new List<ShippableEvent>();
        foreach (var logName in new[] { "System", "Application", "Security" })
        {
            try
            {
                var queryStr = $"*[System[(Level=1 or Level=2) and TimeCreated[@SystemTime >= '{sinceUtc:yyyy-MM-ddTHH:mm:ss.fffZ}']]]";
                var query = new EventLogQuery(logName, PathType.LogName, queryStr) { ReverseDirection = true };
                using var reader = new EventLogReader(query);

                int count = 0;
                for (var rec = reader.ReadEvent(); rec != null && count < 50; rec = reader.ReadEvent())
                {
                    using (rec)
                    {
                        string level = rec.Level switch { 1 => "Critical", 2 => "Error", 3 => "Warning", _ => "Information" };
                        string message;
                        try { message = rec.FormatDescription() ?? $"Event ID {rec.Id}"; }
                        catch { message = $"Event ID {rec.Id} (source: {rec.ProviderName})"; }

                        events.Add(new ShippableEvent(
                            logName, level, rec.ProviderName, rec.Id,
                            message, (rec.TimeCreated ?? DateTime.UtcNow).ToUniversalTime().ToString("o")
                        ));
                    }
                    count++;
                }
            }
            catch (Exception ex)
            {
                Log($"Event log '{logName}' not accessible/queryable: {ex.Message}");
            }
        }

        if (events.Count == 0)
        {
            config.LastEventsSyncUtc = DateTime.UtcNow.ToString("o");
            config.Save();
            return;
        }

        try
        {
            var payload = JsonSerializer.Serialize(new { events });
            var content = new StringContent(payload, Encoding.UTF8, "application/json");
            var req = new HttpRequestMessage(HttpMethod.Post, $"{config.ServerUrl.TrimEnd('/')}/api/agent/events") { Content = content };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ApiToken);
            var res = await Http.SendAsync(req);
            if (res.IsSuccessStatusCode)
            {
                Log($"Shipped {events.Count} event log entries.");
                config.LastEventsSyncUtc = DateTime.UtcNow.ToString("o");
                config.Save();
            }
            else
            {
                Log($"Event log shipping failed: {res.StatusCode}");
            }
        }
        catch (Exception ex) { Log($"Event log shipping failed: {ex.Message}"); }
    }

    private record InstalledApp(string name, string? version);

    /// <summary>
    /// Enumerates installed programs the standard Windows way: the registry
    /// Uninstall keys (64-bit, 32-bit/WOW6432Node, current user, and every
    /// OTHER loaded user profile under HKEY_USERS) that every installer (MSI
    /// or EXE) is expected to populate — the same source Control Panel's
    /// "Programs and Features" reads from. Scanning HKEY_USERS too matters on
    /// shared machines, where software installed under a different Windows
    /// account wouldn't otherwise show up from the currently logged-in user's
    /// HKCU alone.
    /// </summary>
    private static List<InstalledApp> CollectInstalledSoftware()
    {
        var apps = new Dictionary<string, InstalledApp>(StringComparer.OrdinalIgnoreCase);
        var roots = new List<(Microsoft.Win32.RegistryKey hive, string path)>
        {
            (Microsoft.Win32.Registry.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (Microsoft.Win32.Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (Microsoft.Win32.Registry.CurrentUser, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        };

        try
        {
            foreach (var sid in Microsoft.Win32.Registry.Users.GetSubKeyNames())
            {
                // Skip .DEFAULT and the "_Classes" shadow keys — only real loaded user SIDs matter here.
                if (!sid.StartsWith("S-1-5-21", StringComparison.OrdinalIgnoreCase)) continue;
                roots.Add((Microsoft.Win32.Registry.Users, $@"{sid}\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"));
            }
        }
        catch (Exception ex) { Log($"Could not enumerate HKEY_USERS profiles for software scan: {ex.Message}"); }

        foreach (var (hive, path) in roots)
        {
            try
            {
                using var uninstallKey = hive.OpenSubKey(path);
                if (uninstallKey == null) continue;

                foreach (var subKeyName in uninstallKey.GetSubKeyNames())
                {
                    try
                    {
                        using var sub = uninstallKey.OpenSubKey(subKeyName);
                        if (sub == null) continue;

                        var name = sub.GetValue("DisplayName") as string;
                        if (string.IsNullOrWhiteSpace(name)) continue;

                        // Skip OS components/updates, which aren't meaningful "installed software" for IT inventory.
                        var systemComponent = sub.GetValue("SystemComponent");
                        if (systemComponent is int sc && sc == 1) continue;
                        if (sub.GetValue("ParentKeyName") != null) continue; // update sub-entries

                        var version = sub.GetValue("DisplayVersion") as string;
                        apps[name] = new InstalledApp(name.Trim(), version?.Trim());
                    }
                    catch { /* skip unreadable subkey */ }
                }
            }
            catch (Exception ex) { Log($"Registry software scan of '{path}' failed: {ex.Message}"); }
        }

        return apps.Values.OrderBy(a => a.name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static DateTime _lastSoftwareShipCheckUtc = DateTime.MinValue;
    private static readonly TimeSpan SoftwareShipInterval = TimeSpan.FromMinutes(5);

    public static async Task ShipInstalledSoftwareAsync(AgentConfig config)
    {
        if (DateTime.UtcNow - _lastSoftwareShipCheckUtc < SoftwareShipInterval) return;
        _lastSoftwareShipCheckUtc = DateTime.UtcNow;

        try
        {
            var software = CollectInstalledSoftware();
            var payload = JsonSerializer.Serialize(new { software });
            var content = new StringContent(payload, Encoding.UTF8, "application/json");
            var req = new HttpRequestMessage(HttpMethod.Post, $"{config.ServerUrl.TrimEnd('/')}/api/agent/software") { Content = content };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ApiToken);
            var res = await Http.SendAsync(req);
            if (res.IsSuccessStatusCode) Log($"Shipped {software.Count} installed software entries.");
            else Log($"Software inventory shipping failed: {res.StatusCode}");
        }
        catch (Exception ex) { Log($"Software inventory shipping failed: {ex.Message}"); }
    }

    public enum TokenValidity { Valid, Invalid, UnknownNetworkError }

    /// <summary>
    /// Confirms a locally-cached enrollment (agent-config.json) is still
    /// recognized by the server — it may have been deleted from the
    /// dashboard since this file was written, with no background agent
    /// process running at the time to catch the resulting 401 and clean up.
    /// Used by the GUI setup wizard before trusting "already enrolled" state.
    /// Deliberately distinguishes a definite 401 (stale/deleted — safe to
    /// reset) from a network failure (ambiguous — must NOT wipe local state
    /// just because the network blipped).
    /// </summary>
    public static async Task<TokenValidity> ValidateTokenAsync(AgentConfig config)
    {
        try
        {
            var req = new HttpRequestMessage(HttpMethod.Get, $"{config.ServerUrl.TrimEnd('/')}/api/agent/validate");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ApiToken);
            var res = await Http.SendAsync(req);
            if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized || res.StatusCode == System.Net.HttpStatusCode.NotFound)
                return TokenValidity.Invalid;
            return res.IsSuccessStatusCode ? TokenValidity.Valid : TokenValidity.UnknownNetworkError;
        }
        catch (Exception ex)
        {
            Log($"Enrollment validation check failed (network issue, not treated as deregistered): {ex.Message}");
            return TokenValidity.UnknownNetworkError;
        }
    }

    public static async Task<bool> VerifyAdminPasswordAsync(AgentConfig config, string password)
    {
        try
        {
            var payload = JsonSerializer.Serialize(new { password });
            var content = new StringContent(payload, Encoding.UTF8, "application/json");
            var req = new HttpRequestMessage(HttpMethod.Post, $"{config.ServerUrl.TrimEnd('/')}/api/agent/verify-admin-password") { Content = content };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ApiToken);
            var res = await Http.SendAsync(req);
            if (!res.IsSuccessStatusCode) return false;
            var body = await res.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.TryGetProperty("valid", out var v) && v.GetBoolean();
        }
        catch (Exception ex)
        {
            Log($"Admin password verification failed: {ex.Message}");
            return false;
        }
    }

    public static async Task ReportCommandResultAsync(AgentConfig config, long commandId, string status, object result)
    {
        try
        {
            var payload = JsonSerializer.Serialize(new { command_id = commandId, status, result });
            var content = new StringContent(payload, Encoding.UTF8, "application/json");
            var req = new HttpRequestMessage(HttpMethod.Post, $"{config.ServerUrl.TrimEnd('/')}/api/agent/command-result") { Content = content };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ApiToken);
            await Http.SendAsync(req);
        }
        catch (Exception ex) { Log($"Failed to report command result: {ex.Message}"); }
    }

    /// <summary>
    /// Executes (or dry-runs, if explicitly requested) a command from the
    /// server. Lock/Restart run for real by default — this is a production
    /// IT tool, so a Lock click is expected to actually lock the machine.
    /// Wipe is NEVER auto-executed regardless of allowActions — it always
    /// just flags the device for manual IT follow-up, since a genuine
    /// remote wipe needs OS-level integration (BitLocker/FileVault key
    /// rotation, factory reset triggers) this lightweight agent doesn't have.
    /// </summary>
    public static async Task HandleCommandAsync(AgentConfig config, CheckinCommand cmd, bool allowActions)
    {
        Log($"Received command '{cmd.Type}' (id={cmd.Id})");

        if (cmd.Type == "wipe")
        {
            await HandleWipeAsync(config, cmd);
            return;
        }

        if (cmd.Type == "update_agent")
        {
            await HandleUpdateAgentAsync(config, cmd);
            return;
        }

        if (cmd.Type == "reset_password")
        {
            await HandleResetPasswordAsync(config, cmd);
            return;
        }

        if (cmd.Type == "get_log")
        {
            try
            {
                var lines = File.Exists(LogPathOrDefault()) ? File.ReadAllLines(LogPathOrDefault()).TakeLast(200) : new[] { "(no log file yet)" };
                var text = string.Join("\n", lines);
                if (text.Length > 24000) text = text[^24000..];
                await ReportCommandResultAsync(config, cmd.Id, "success", new { note = $"Agent log, last {lines.Count()} lines (v{AgentVersion}, elevated={Installer.IsElevated}, system={AgentConfig.IsSystemAccount})", log = text });
            }
            catch (Exception ex) { await ReportCommandResultAsync(config, cmd.Id, "failed", new { error = ex.Message }); }
            return;
        }
        if (cmd.Type == "lock")
        {
            try
            {
                var summary = SessionLock.LockActiveSessions(dryRun: !allowActions);
                Log($"Lock: {summary}");
                await ReportCommandResultAsync(config, cmd.Id, "success", new { note = summary });
            }
            catch (Exception ex)
            {
                Log($"Lock failed: {ex.Message}");
                await ReportCommandResultAsync(config, cmd.Id, "failed", new { error = ex.Message });
            }
            return;
        }

        if (cmd.Type is "run_script" or "install_software")
        {
            await ReportCommandResultAsync(config, cmd.Id, "success",
                new { note = $"{cmd.Type} acknowledged; not executed (unsupported by desktop agent v1)." });
            return;
        }

        string? exe = null;
        string? args = null;
        if (cmd.Type == "get_log")
        {
            try
            {
                var lines = File.Exists(LogPathOrDefault()) ? File.ReadAllLines(LogPathOrDefault()).TakeLast(200) : new[] { "(no log file yet)" };
                var text = string.Join("\n", lines);
                if (text.Length > 24000) text = text[^24000..];
                await ReportCommandResultAsync(config, cmd.Id, "success", new { note = $"Agent log, last {lines.Count()} lines (v{AgentVersion}, elevated={Installer.IsElevated}, system={AgentConfig.IsSystemAccount})", log = text });
            }
            catch (Exception ex) { await ReportCommandResultAsync(config, cmd.Id, "failed", new { error = ex.Message }); }
            return;
        }
        if (cmd.Type == "lock") { exe = "rundll32.exe"; args = "user32.dll,LockWorkStation"; }
        else if (cmd.Type == "restart") { exe = "shutdown.exe"; args = "/r /t 5"; }

        if (exe == null)
        {
            await ReportCommandResultAsync(config, cmd.Id, "failed", new { note = "Unsupported command type" });
            return;
        }

        if (!allowActions)
        {
            Log($"[DRY-RUN] Would execute: {exe} {args}");
            await ReportCommandResultAsync(config, cmd.Id, "success",
                new { note = $"Dry-run only. Would have executed: {exe} {args}" });
            return;
        }

        try
        {
            Log($"[EXEC] Running: {exe} {args}");
            var psi = new System.Diagnostics.ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true };
            using var proc = System.Diagnostics.Process.Start(psi);
            proc?.WaitForExit(10_000);
            await ReportCommandResultAsync(config, cmd.Id, "success", new { note = $"Executed: {exe} {args}" });
        }
        catch (Exception ex)
        {
            Log($"[EXEC] Failed: {ex.Message}");
            await ReportCommandResultAsync(config, cmd.Id, "failed", new { error = ex.Message });
        }
    }

    /// <summary>
    /// Requires the Ellora MDM admin password (entered locally on this
    /// device, verified server-side without ever exposing the hash) before
    /// starting Windows's own factory-reset flow. Windows still shows its
    /// own confirmation screens after this — no third-party tool can fully
    /// silent-wipe a PC, and that's intentional on Microsoft's part.
    /// </summary>
    private static async Task HandleWipeAsync(AgentConfig config, CheckinCommand cmd)
    {
        Log("Wipe command received. Prompting for admin password on this device...");
        var password = await PromptBroker.AskPasswordAsync(
            "An administrator has requested a factory reset of this device.",
            TimeSpan.FromMinutes(2));

        if (string.IsNullOrEmpty(password))
        {
            Log("Wipe cancelled or no response from device user.");
            await ReportCommandResultAsync(config, cmd.Id, "failed",
                new { note = "Wipe blocked: no admin password entered on device (cancelled or timed out)." });
            return;
        }

        var valid = await VerifyAdminPasswordAsync(config, password);
        if (!valid)
        {
            Log("Wipe blocked: incorrect admin password entered on device.");
            await ReportCommandResultAsync(config, cmd.Id, "failed",
                new { note = "Wipe blocked: incorrect admin password entered on device." });
            return;
        }

        try
        {
            Log("Admin password verified. Starting Windows factory reset (systemreset.exe)...");
            var psi = new System.Diagnostics.ProcessStartInfo("systemreset.exe", "-factoryreset")
            {
                UseShellExecute = true // lets Windows show its own elevation/confirmation UI
            };
            System.Diagnostics.Process.Start(psi);
            await ReportCommandResultAsync(config, cmd.Id, "success",
                new { note = "Admin password verified. Windows factory reset flow started on device — further on-screen confirmation in Windows itself is required to complete it." });
        }
        catch (Exception ex)
        {
            Log($"Failed to start factory reset: {ex.Message}");
            await ReportCommandResultAsync(config, cmd.Id, "failed", new { error = ex.Message });
        }
    }

    /// <summary>
    /// Sets a local Windows account's password via `net user`. Needs
    /// administrator rights and a LOCAL account (not a Microsoft/domain
    /// account) — both limits are reported back plainly rather than hidden.
    /// The password is passed as a discrete argument (no shell parsing) and
    /// is never written to the log or the command result.
    /// </summary>
    private static async Task HandleResetPasswordAsync(AgentConfig config, CheckinCommand cmd)
    {
        string? username = null, newPassword = null;
        bool mustChange = false;
        if (cmd.Payload.HasValue)
        {
            var p = cmd.Payload.Value;
            if (p.TryGetProperty("username", out var u) && u.ValueKind == JsonValueKind.String) username = u.GetString();
            if (p.TryGetProperty("new_password", out var pw) && pw.ValueKind == JsonValueKind.String) newPassword = pw.GetString();
            if (p.TryGetProperty("must_change", out var mc) && mc.ValueKind == JsonValueKind.True) mustChange = true;
        }

        Log($"Password reset requested for local account '{username}'.");

        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrEmpty(newPassword) || newPassword.StartsWith('/'))
        {
            await ReportCommandResultAsync(config, cmd.Id, "failed", new { error = "Invalid username or password in request." });
            return;
        }

        try
        {
            var (code, err) = await RunNetUserAsync(new[] { "user", username!, newPassword! });
            if (code != 0)
            {
                string reason = err.Contains("5") && err.Contains("denied", StringComparison.OrdinalIgnoreCase)
                    ? "Access denied: the agent is not running with administrator rights, so Windows refused the change."
                    : err.Contains("2221") || err.Contains("could not be found", StringComparison.OrdinalIgnoreCase)
                        ? $"No local account named '{username}' on this device (Microsoft-account and domain logins can't be reset this way)."
                        : $"Windows rejected the change: {err.Trim()}";
                Log($"Password reset failed (exit {code}).");
                await ReportCommandResultAsync(config, cmd.Id, "failed", new { error = reason });
                return;
            }

            if (mustChange)
                await RunNetUserAsync(new[] { "user", username!, "/logonpasswordchg:yes" });

            Log($"Password for '{username}' was reset.");
            await ReportCommandResultAsync(config, cmd.Id, "success",
                new { note = $"Password for local account '{username}' was reset." + (mustChange ? " User must set a new password at next sign-in." : "") });
        }
        catch (Exception ex)
        {
            await ReportCommandResultAsync(config, cmd.Id, "failed", new { error = ex.Message });
        }
    }

    private static async Task<(int code, string err)> RunNetUserAsync(string[] args)
    {
        var psi = new System.Diagnostics.ProcessStartInfo("net.exe")
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var proc = System.Diagnostics.Process.Start(psi)!;
        var stderr = await proc.StandardError.ReadToEndAsync();
        var stdout = await proc.StandardOutput.ReadToEndAsync();
        await proc.WaitForExitAsync();
        return (proc.ExitCode, string.IsNullOrWhiteSpace(stderr) ? stdout : stderr);
    }

    // Separate client with a much longer timeout than the default 15s used
    // for small API calls — downloading the ~68MB self-contained exe can
    // take a while on a slow connection.
    private static readonly HttpClient UpdateHttp = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };

    /// <summary>
    /// Downloads the new agent build and self-replaces. A running exe can't
    /// overwrite its own file on Windows, so this spawns a detached cmd
    /// helper that waits for this process to exit, copies the new exe over
    /// the installed one, and relaunches it — then this process exits
    /// immediately to let that happen. The new process picks back up with
    /// the same config (same device, same enrollment) and reports its own
    /// (new) AgentVersion on its next check-in.
    /// </summary>
    private static async Task HandleUpdateAgentAsync(AgentConfig config, CheckinCommand cmd)
    {
        try
        {
            string downloadUrl = UpdateDownloadUrl;
            string? targetVersion = null;
            if (cmd.Payload.HasValue)
            {
                var p = cmd.Payload.Value;
                if (p.TryGetProperty("download_url", out var u) && u.ValueKind == JsonValueKind.String) downloadUrl = u.GetString()!;
                if (p.TryGetProperty("target_version", out var v) && v.ValueKind == JsonValueKind.String) targetVersion = v.GetString();
            }

            if (targetVersion == AgentVersion)
            {
                Log($"Update command received but already on version {AgentVersion} — skipping.");
                await ReportCommandResultAsync(config, cmd.Id, "success", new { note = $"Already on version {AgentVersion}." });
                return;
            }

            // The compiled exe exceeds Cloudflare Workers' 25MB static-asset
            // limit, so it's hosted as numbered chunks + a manifest describing
            // how many there are and the expected SHA-256 of the whole file.
            var baseUrl = downloadUrl.TrimEnd('/') + '/';
            Log($"Update command received. Fetching manifest from {baseUrl}manifest.json...");
            var manifestJson = await UpdateHttp.GetStringAsync($"{baseUrl}manifest.json");
            using var manifestDoc = JsonDocument.Parse(manifestJson);
            var chunkCount = manifestDoc.RootElement.GetProperty("chunk_count").GetInt32();
            var expectedSize = manifestDoc.RootElement.GetProperty("total_size").GetInt64();
            var expectedSha256 = manifestDoc.RootElement.TryGetProperty("sha256", out var shaEl) ? shaEl.GetString() : null;

            var tempPath = Path.Combine(Path.GetTempPath(), $"ElloraMdmAgent_update_{Guid.NewGuid():N}.exe");
            await using (var fileStream = File.Create(tempPath))
            {
                for (int i = 0; i < chunkCount; i++)
                {
                    Log($"Downloading update chunk {i + 1}/{chunkCount}...");
                    var chunkBytes = await UpdateHttp.GetByteArrayAsync($"{baseUrl}chunk-{i}.bin");
                    await fileStream.WriteAsync(chunkBytes);
                }
            }

            var actualSize = new FileInfo(tempPath).Length;
            if (actualSize != expectedSize)
                throw new Exception($"Reassembled file size mismatch: expected {expectedSize} bytes, got {actualSize}.");

            if (!string.IsNullOrEmpty(expectedSha256))
            {
                using var sha = System.Security.Cryptography.SHA256.Create();
                await using var verifyStream = File.OpenRead(tempPath);
                var actualHash = Convert.ToHexString(await sha.ComputeHashAsync(verifyStream));
                if (!actualHash.Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
                    throw new Exception("Downloaded update failed checksum verification — aborting for safety.");
            }

            Log($"Downloaded and verified {actualSize} bytes at {tempPath}.");

            await ReportCommandResultAsync(config, cmd.Id, "success",
                new { note = $"Update downloaded (target version {targetVersion ?? "unknown"}). Restarting into new version now." });

            var exePath = Environment.ProcessPath ?? AgentConfig.ExePath;
            // Safety net: keep a backup of the working build, start the new one,
            // and if it hasn't completed a check-in within 2 minutes (healthy.txt
            // carrying the new version) put the old build back. A bad update then
            // can't leave a laptop without its agent.
            var healthy = Path.Combine(AgentConfig.InstallDir, "healthy.txt");
            var verifyLine = string.IsNullOrEmpty(targetVersion)
                ? $"if not exist \"{healthy}\" goto restore"
                : $"findstr /c:\"{targetVersion}\" \"{healthy}\" >nul 2>&1\r\nif errorlevel 1 goto restore";
            var batch =
                "@echo off\r\n" +
                "ping -n 4 127.0.0.1 >nul\r\n" +
                $"copy /y \"{exePath}\" \"{exePath}.bak\" >nul\r\n" +
                $"del /q \"{healthy}\" >nul 2>&1\r\n" +
                $"copy /y \"{tempPath}\" \"{exePath}\" >nul\r\n" +
                "if errorlevel 1 goto restore\r\n" +
                $"start \"\" \"{exePath}\" --run\r\n" +
                "ping -n 121 127.0.0.1 >nul\r\n" +
                verifyLine + "\r\n" +
                "goto done\r\n" +
                ":restore\r\n" +
                "taskkill /f /im ElloraMdmAgent.exe >nul 2>&1\r\n" +
                "ping -n 3 127.0.0.1 >nul\r\n" +
                $"copy /y \"{exePath}.bak\" \"{exePath}\" >nul\r\n" +
                $"start \"\" \"{exePath}\" --run\r\n" +
                ":done\r\n" +
                $"del /q \"{tempPath}\" >nul 2>&1\r\n";
            var batchPath = Path.Combine(Path.GetTempPath(), $"ellora_update_{Guid.NewGuid():N}.cmd");
            await File.WriteAllTextAsync(batchPath, batch);
            var psi = new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c \"{batchPath}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden
            };
            System.Diagnostics.Process.Start(psi);

            Log("Update helper launched. Exiting current process now so the replacement can complete.");
            Environment.Exit(0);
        }
        catch (Exception ex)
        {
            Log($"Agent self-update failed: {ex.Message}");
            await ReportCommandResultAsync(config, cmd.Id, "failed", new { error = ex.Message });
        }
    }

    private static DateTime _lastUsageShipUtc = DateTime.MinValue;

    /// <summary>Uploads cumulative per-day app usage every ~2 minutes. Re-sending is harmless (the server keeps the max).</summary>
    public static async Task ShipUsageAsync(AgentConfig config)
    {
        if (DateTime.UtcNow - _lastUsageShipUtc < TimeSpan.FromMinutes(2)) return;
        _lastUsageShipUtc = DateTime.UtcNow;
        try
        {
            var days = UsageTracker.ReadRecent()
                .Select(d => new
                {
                    date = d.Date,
                    user = d.User,
                    apps = d.Apps.Select(kv => new { exe = kv.Key, name = kv.Value.Name, seconds = kv.Value.Seconds }).ToList()
                }).ToList();
            if (days.Count == 0) return;

            var payload = JsonSerializer.Serialize(new { days });
            var req = new HttpRequestMessage(HttpMethod.Post, $"{config.ServerUrl.TrimEnd('/')}/api/agent/usage")
            { Content = new StringContent(payload, Encoding.UTF8, "application/json") };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ApiToken);
            var res = await Http.SendAsync(req);
            if (!res.IsSuccessStatusCode) Log($"Usage upload failed: {res.StatusCode}");
        }
        catch (Exception ex) { Log($"Usage upload failed: {ex.Message}"); }
    }

    private static bool _healthyMarked;
    private static bool _migrationTried;

    /// <summary>
    /// Written after the first successful check-in of each start. An update's
    /// helper script looks for it to confirm the new build really works, and
    /// puts the previous build back if it never appears.
    /// </summary>
    private static void MarkHealthy()
    {
        if (_healthyMarked) return;
        try
        {
            File.WriteAllText(Path.Combine(AgentConfig.InstallDir, "healthy.txt"), AgentVersion);
            // Updates started by older agents look for the marker in the old per-user folder.
            if (Directory.Exists(AgentConfig.LegacyDir)) { try { File.WriteAllText(Path.Combine(AgentConfig.LegacyDir, "healthy.txt"), AgentVersion); } catch { } }
            _healthyMarked = true;
        }
        catch { }
    }

    /// <summary>
    /// (Elevated agents only.) Makes a copy of this build in the shared folder —
    /// standard users can't read the administrator's profile — and registers a
    /// logon task that starts `--track` for every user. Version-named file, so a
    /// running helper never blocks an update.
    /// </summary>
    private static void EnsureUsageHelper()
    {
        try
        {
            if (!Installer.IsElevated) return;
            var self = Environment.ProcessPath;
            if (string.IsNullOrEmpty(self)) return;

            var shared = PromptBroker.SharedExe();

            var script =
                $"$a = New-ScheduledTaskAction -Execute '{shared}' -Argument '--track'; " +
                "$t = New-ScheduledTaskTrigger -AtLogOn; " +
                "$p = New-ScheduledTaskPrincipal -GroupId 'BUILTIN\\Users' -RunLevel Limited; " +
                "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable; " +
                "Register-ScheduledTask -TaskName 'ElloraMDMUsage' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null";
            var psi = new System.Diagnostics.ProcessStartInfo("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{script}\"")
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
            using var proc = System.Diagnostics.Process.Start(psi)!;
            var err = proc.StandardError.ReadToEnd();
            proc.WaitForExit(30_000);
            Log(proc.ExitCode == 0 ? $"Usage helper task registered for all users ({AgentVersion})." : $"Usage helper task not registered: {err.Trim()}");

            // Remove helper copies from older versions (skips any still running).
            foreach (var f in Directory.GetFiles(UsageTracker.BinDir, "ElloraMdmAgent-*.exe"))
                if (!string.Equals(f, shared, StringComparison.OrdinalIgnoreCase)) { try { File.Delete(f); } catch { } }
        }
        catch (Exception ex) { Log($"Usage helper setup failed (non-fatal): {ex.Message}"); }
    }

    public static async Task RunLoopAsync(bool allowActions, CancellationToken ct)
    {
        var config = AgentConfig.Load();
        if (config == null)
        {
            Log("No agent-config.json found. Run the enrollment wizard first.");
            return;
        }

        Log($"Ellora MDM Agent {AgentVersion} starting. Server: {config.ServerUrl}. Action mode: {(allowActions ? "LIVE" : "DRY-RUN")}. Elevated (administrator): {Installer.IsElevated}");

        ResetWatcher.ApplySettingsHardening();
        ResetWatcher.Start(config);

        // App-usage tracking for this agent's own Windows session, plus (when
        // elevated) a per-logon helper so other users' sessions are covered too.
        UsageTracker.EnsureUsageDir();
        if (!AgentConfig.IsSystemAccount && UsageTracker.TryOwnSession()) _ = Task.Run(() => UsageTracker.RunAsync(ct));
        _ = Task.Run(EnsureUsageHelper);
        if (AgentConfig.IsSystemAccount)
        {
            // As a service we have no desktop of our own, so start a tracker in each signed-in user's session.
            _ = Task.Run(async () =>
            {
                try { await Task.Delay(TimeSpan.FromSeconds(20), ct); } catch (TaskCanceledException) { return; }
                while (!ct.IsCancellationRequested)
                {
                    PromptBroker.EnsureTrackersInAllSessions();
                    try { await Task.Delay(TimeSpan.FromMinutes(15), ct); } catch (TaskCanceledException) { break; }
                }
            });
        }

        while (!ct.IsCancellationRequested)
        {
            // Every tick is isolated: an unexpected exception here (a bad WMI
            // query, a transient parse error, anything) must never be allowed
            // to kill the whole background process — that's exactly how this
            // agent previously went silent for hours without anyone noticing.
            // Log it and keep the loop alive instead.
            try
            {
                var result = await CheckinAsync(config);
                if (result.Ok)
                {
                    Log($"Check-in ok. {result.Commands.Count} pending command(s).");
                    foreach (var cmd in result.Commands)
                        await HandleCommandAsync(config, cmd, allowActions);

                    await ShipEventLogsAsync(config);
                    await ShipInstalledSoftwareAsync(config);
                    await ShipUsageAsync(config);
                    MarkHealthy();
                    if (!_migrationTried) { _migrationTried = true; ServiceMode.MigrateFromUserAgent(); }
                }
                else if (result.StatusCode == 401)
                {
                    // The device was deleted from the dashboard (or its token was
                    // revoked) — this API token no longer maps to any device.
                    // Deregister locally so the machine is clean for future re-enrollment.
                    Log("Server reports this device is no longer enrolled (401). Deregistering and exiting.");
                    Installer.Deregister();
                    return;
                }
                else
                {
                    Log($"Check-in error: {result.Error}");
                }
            }
            catch (Exception ex)
            {
                Log($"Unexpected error in check-in loop tick (continuing): {ex.Message}");
            }

            try { await Task.Delay(CheckinIntervalMs, ct); } catch (TaskCanceledException) { break; }
        }
    }
}
