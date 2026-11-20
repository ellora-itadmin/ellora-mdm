-- Per-day foreground time per application, per Windows user (a "digital wellbeing"
-- style view). One row per (device, day, user, exe); the agent sends cumulative
-- day totals so re-sending the same data is harmless.
CREATE TABLE IF NOT EXISTS device_app_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,      -- YYYY-MM-DD, the device's local calendar day
  windows_user TEXT NOT NULL,
  exe_name TEXT NOT NULL,        -- e.g. chrome.exe
  app_name TEXT NOT NULL,        -- friendly name, e.g. Google Chrome
  seconds INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(device_id, usage_date, windows_user, exe_name)
);

CREATE INDEX IF NOT EXISTS idx_app_usage_device_date ON device_app_usage(device_id, usage_date);
