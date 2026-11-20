using System.Drawing;
using System.Windows.Forms;

namespace ElloraMdmAgent;

public class MainForm : Form
{
    private readonly TextBox _codeBox = new();
    private readonly Button _installButton = new();
    private readonly TextBox _logBox = new();
    private readonly Label _statusLabel = new();
    private bool _reRunMode = false;

    // Ellora EPC brand palette
    private static readonly Color Navy = ColorTranslator.FromHtml("#1B2849");
    private static readonly Color Accent = ColorTranslator.FromHtml("#324B8A");
    private static readonly Color Background = ColorTranslator.FromHtml("#F9FAFB");

    public MainForm()
    {
        Text = "Ellora MDM Agent Setup";
        ClientSize = new Size(440, 340);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Background;
        Font = new Font("Segoe UI", 9.5f);

        var title = new Label
        {
            Text = "ELLORA MDM",
            Font = new Font("Segoe UI", 16f, FontStyle.Bold),
            ForeColor = Navy,
            AutoSize = true,
            Location = new Point(24, 20)
        };

        var subtitle = new Label
        {
            Text = "Enroll this device for management",
            Font = new Font("Segoe UI", 9.5f),
            ForeColor = Color.DimGray,
            AutoSize = true,
            Location = new Point(24, 52)
        };

        var codeLabel = new Label
        {
            Text = "Enrollment Code",
            AutoSize = true,
            Location = new Point(24, 90)
        };

        _codeBox.Location = new Point(24, 112);
        _codeBox.Size = new Size(392, 28);
        _codeBox.Font = new Font("Consolas", 12f);
        _codeBox.CharacterCasing = CharacterCasing.Upper;

        _installButton.Text = "Install && Enroll";
        _installButton.Location = new Point(24, 152);
        _installButton.Size = new Size(392, 38);
        _installButton.BackColor = Accent;
        _installButton.ForeColor = Color.White;
        _installButton.FlatStyle = FlatStyle.Flat;
        _installButton.FlatAppearance.BorderSize = 0;
        _installButton.Cursor = Cursors.Hand;
        _installButton.Click += OnInstallClick;

        _statusLabel.Location = new Point(24, 198);
        _statusLabel.Size = new Size(392, 20);
        _statusLabel.ForeColor = Color.DimGray;

        _logBox.Location = new Point(24, 222);
        _logBox.Size = new Size(392, 96);
        _logBox.Multiline = true;
        _logBox.ReadOnly = true;
        _logBox.ScrollBars = ScrollBars.Vertical;
        _logBox.Font = new Font("Consolas", 8.5f);
        _logBox.BackColor = Color.White;

        Controls.AddRange(new Control[] { title, subtitle, codeLabel, _codeBox, _installButton, _statusLabel, _logBox });

        _ = CheckExistingEnrollmentAsync();
    }

    /// <summary>
    /// A local agent-config.json doesn't mean this device is still actually
    /// enrolled — it may have been deleted from the dashboard with no
    /// background agent running at the time to notice and clean up after
    /// itself. Always re-confirm with the server before showing "already
    /// enrolled" instead of trusting the stale file.
    /// </summary>
    private async Task CheckExistingEnrollmentAsync()
    {
        var existing = AgentConfig.Load();
        if (existing == null) return;

        _installButton.Enabled = false;
        _codeBox.Enabled = false;
        _statusLabel.Text = "Checking enrollment status with Ellora MDM…";
        AppendLog($"Found local enrollment for device #{existing.DeviceId}. Verifying with server...");

        var validity = await AgentCore.ValidateTokenAsync(existing);

        if (validity == AgentCore.TokenValidity.Valid)
        {
            AppendLog("Confirmed: this device is still enrolled.");
            _statusLabel.Text = "This device is already enrolled and reporting to Ellora MDM.";
            _codeBox.Enabled = false;
            _installButton.Text = "Re-run Setup";
            _installButton.Enabled = true;
            _reRunMode = true;
        }
        else if (validity == AgentCore.TokenValidity.Invalid)
        {
            // The device was deleted (or its token revoked) on the dashboard side.
            // Clear the stale local state so this machine is available for fresh enrollment.
            AppendLog("This device is no longer enrolled on the server (it may have been deleted from the dashboard). Clearing local state.");
            try { File.Delete(AgentConfig.ConfigPath); } catch { }
            _statusLabel.Text = "Not currently enrolled. Enter an enrollment code to continue.";
            _codeBox.Enabled = true;
            _installButton.Text = "Install && Enroll";
            _installButton.Enabled = true;
        }
        else
        {
            // Network issue — don't destroy local state on an ambiguous result,
            // but don't block the user either; let them retry or proceed.
            AppendLog("Could not reach the server to verify enrollment status (network issue). Showing cached status.");
            _statusLabel.Text = "This device appears enrolled, but status could not be verified (offline?).";
            _codeBox.Enabled = false;
            _installButton.Text = "Re-run Setup";
            _installButton.Enabled = true;
            _reRunMode = true;
        }
    }

    private void AppendLog(string line)
    {
        if (_logBox.InvokeRequired) { _logBox.Invoke(() => AppendLog(line)); return; }
        _logBox.AppendText(line + Environment.NewLine);
    }

    private async void OnInstallClick(object? sender, EventArgs e)
    {
        if (_reRunMode)
        {
            await ReRunPersistenceAsync();
            return;
        }

        var code = _codeBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(code))
        {
            MessageBox.Show(this, "Please enter the enrollment code shown in the Ellora MDM dashboard.",
                "Enrollment code required", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        _installButton.Enabled = false;
        _codeBox.Enabled = false;
        _statusLabel.Text = "Enrolling device...";
        AppendLog($"Enrolling with code {code}...");

        var enroll = await AgentCore.EnrollAsync(code, AgentCore.DefaultServerUrl);
        if (!enroll.Ok)
        {
            AppendLog($"Enrollment failed: {enroll.Error}");
            _statusLabel.Text = "Enrollment failed. Check the code and try again.";
            _installButton.Enabled = true;
            _codeBox.Enabled = true;
            return;
        }

        AppendLog($"Enrolled. Device #{enroll.DeviceId}.");
        var config = new AgentConfig
        {
            ServerUrl = AgentCore.DefaultServerUrl,
            ApiToken = enroll.ApiToken!,
            DeviceId = enroll.DeviceId,
            DeviceUuid = enroll.DeviceUuid ?? ""
        };

        _statusLabel.Text = "Installing background agent...";
        AppendLog("Installing agent to run automatically at logon...");

        bool ok;
        string message;
        try
        {
            // Save config to the FINAL install location before Installer copies the exe there,
            // so the copied exe finds its config immediately.
            config.Save();
            (ok, message) = await Task.Run(Installer.InstallPersistent);
        }
        catch (Exception ex)
        {
            // Enrollment with the server already succeeded at this point — don't
            // lose that device record over a local file/permissions problem.
            // Surface it plainly instead of letting it crash the whole app.
            ok = false;
            message = $"Enrolled on the server (device #{enroll.DeviceId}), but local setup failed: {ex.Message}";
            AgentCore.Log($"Local install step failed after successful enrollment: {ex}");
        }
        AppendLog(message);

        if (ok)
        {
            _statusLabel.Text = "Done. This device is now managed by Ellora MDM.";
            MessageBox.Show(this,
                "This device is enrolled and the Ellora MDM agent is now running in the background.\n\n" +
                "You can close this window.",
                "Setup complete", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        else
        {
            _statusLabel.Text = "Enrollment succeeded but background install failed — see log.";
            _installButton.Enabled = true;
            _codeBox.Enabled = true;
        }
    }

    /// <summary>
    /// For an already-enrolled device: just re-registers the auto-start
    /// mechanisms (useful if a watchdog task or Startup entry was somehow
    /// removed) using the existing config, without re-enrolling.
    /// </summary>
    private async Task ReRunPersistenceAsync()
    {
        _installButton.Enabled = false;
        _statusLabel.Text = "Re-registering background agent...";
        AppendLog("Re-running background install for existing enrollment...");

        bool ok;
        string message;
        try
        {
            (ok, message) = await Task.Run(Installer.InstallPersistent);
        }
        catch (Exception ex)
        {
            ok = false;
            message = $"Re-run failed: {ex.Message}";
            AgentCore.Log($"Re-run persistence failed: {ex}");
        }
        AppendLog(message);
        _statusLabel.Text = ok
            ? "Done. This device is managed by Ellora MDM."
            : "Re-run failed — see log.";
        _installButton.Enabled = true;
    }
}
