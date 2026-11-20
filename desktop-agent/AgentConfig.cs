using System.Text.Json;
using System.Text.Json.Serialization;

namespace ElloraMdmAgent;

public class AgentConfig
{
    [JsonPropertyName("server_url")]
    public string ServerUrl { get; set; } = "";

    [JsonPropertyName("api_token")]
    public string ApiToken { get; set; } = "";

    [JsonPropertyName("device_id")]
    public long DeviceId { get; set; }

    [JsonPropertyName("device_uuid")]
    public string DeviceUuid { get; set; } = "";

    [JsonPropertyName("last_events_sync_utc")]
    public string? LastEventsSyncUtc { get; set; }

    // Where the agent keeps its config, log and executable.
    //
    // Service mode (the real design): C:\ProgramData\ElloraMDM\agent, readable only
    // by SYSTEM and Administrators (it holds the device token). The agent runs there
    // as a SYSTEM scheduled task that starts at boot, so it works no matter which
    // Windows account (or none) is signed in.
    //
    // Legacy mode: the installing user's LocalAppData. Older installs live there and
    // keep working until they migrate; non-elevated test runs also use it.
    public static string DataDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ElloraMDM", "agent");

    public static string LegacyDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ElloraMDM");

    public static bool IsSystemAccount
    {
        get
        {
            try { using var id = System.Security.Principal.WindowsIdentity.GetCurrent(); return id.IsSystem; }
            catch { return false; }
        }
    }

    public static string InstallDir
    {
        get
        {
            if (IsSystemAccount) return DataDir;
            if (File.Exists(Path.Combine(DataDir, "agent-config.json"))) return DataDir;
            if (File.Exists(Path.Combine(LegacyDir, "agent-config.json"))) return LegacyDir;
            // Fresh install: elevated setup uses the protected service folder,
            // anything else (tests, non-admin) stays in the user's own profile.
            return Installer.IsElevated ? DataDir : LegacyDir;
        }
    }

    public static string ConfigPath => Path.Combine(InstallDir, "agent-config.json");
    public static string ExePath => Path.Combine(InstallDir, "ElloraMdmAgent.exe");
    public static string LogPath => Path.Combine(InstallDir, "agent.log");
    public static AgentConfig? Load()
    {
        try
        {
            if (!File.Exists(ConfigPath)) return null;
            var json = File.ReadAllText(ConfigPath);
            return JsonSerializer.Deserialize<AgentConfig>(json);
        }
        catch
        {
            // A corrupt or inaccessible config file should never crash the
            // caller — treat it the same as "not enrolled".
            return null;
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(InstallDir);
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(ConfigPath, json);
    }
}
