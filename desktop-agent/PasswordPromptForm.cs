using System.Drawing;
using System.Windows.Forms;

namespace ElloraMdmAgent;

/// <summary>
/// A small modal dialog shown on the managed device itself, requiring the
/// Ellora MDM admin password before a factory reset / wipe can proceed.
/// Runs on its own STA thread since the headless agent loop has no message pump.
/// </summary>
public class PasswordPromptForm : Form
{
    private readonly TextBox _passwordBox = new() { UseSystemPasswordChar = true };
    public string? EnteredPassword { get; private set; }

    public PasswordPromptForm(string reason)
    {
        Text = "Ellora MDM — Admin confirmation required";
        ClientSize = new Size(420, 190);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        TopMost = true;
        BackColor = ColorTranslator.FromHtml("#F9FAFB");
        Font = new Font("Segoe UI", 9.5f);

        var warn = new Label
        {
            Text = $"⚠ {reason}",
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            ForeColor = ColorTranslator.FromHtml("#B91C1C"),
            AutoSize = false,
            Size = new Size(376, 40),
            Location = new Point(22, 16)
        };

        var label = new Label
        {
            Text = "Enter the Ellora MDM admin password to continue:",
            AutoSize = true,
            Location = new Point(22, 62)
        };

        _passwordBox.Location = new Point(22, 84);
        _passwordBox.Size = new Size(376, 26);
        _passwordBox.Font = new Font("Consolas", 11f);

        var cancelBtn = new Button { Text = "Cancel", Location = new Point(230, 128), Size = new Size(80, 32) };
        var okBtn = new Button
        {
            Text = "Confirm",
            Location = new Point(318, 128),
            Size = new Size(80, 32),
            BackColor = ColorTranslator.FromHtml("#324B8A"),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat
        };
        okBtn.FlatAppearance.BorderSize = 0;

        cancelBtn.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        okBtn.Click += (_, _) => { EnteredPassword = _passwordBox.Text; DialogResult = DialogResult.OK; Close(); };
        AcceptButton = okBtn;
        CancelButton = cancelBtn;

        Controls.AddRange(new Control[] { warn, label, _passwordBox, cancelBtn, okBtn });

        // Auto-dismiss so an unattended prompt doesn't sit open forever.
        var autoCloseTimer = new System.Windows.Forms.Timer { Interval = 120_000 };
        autoCloseTimer.Tick += (_, _) => { autoCloseTimer.Stop(); DialogResult = DialogResult.Cancel; Close(); };
        autoCloseTimer.Start();
        FormClosed += (_, _) => autoCloseTimer.Dispose();
    }

    /// <summary>
    /// Shows the prompt on a dedicated STA UI thread (the headless agent has
    /// no message loop of its own) and returns the entered password, or null
    /// if the user cancelled or didn't respond within the timeout.
    /// </summary>
    public static string? ShowAndWait(string reason, TimeSpan timeout)
    {
        string? result = null;
        var thread = new Thread(() =>
        {
            using var form = new PasswordPromptForm(reason);
            var dr = form.ShowDialog();
            if (dr == DialogResult.OK) result = form.EnteredPassword;
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();
        thread.Join(timeout);
        return result;
    }
}
