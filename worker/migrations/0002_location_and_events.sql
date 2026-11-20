-- Approximate (IP-based) device location, refreshed by the agent every ~15 min.
ALTER TABLE devices ADD COLUMN latitude REAL;
ALTER TABLE devices ADD COLUMN longitude REAL;
ALTER TABLE devices ADD COLUMN location_label TEXT;      -- e.g. "Pune, Maharashtra, IN"
ALTER TABLE devices ADD COLUMN location_updated_at TEXT;
ALTER TABLE devices ADD COLUMN location_accuracy TEXT DEFAULT 'ip';  -- 'ip' = approximate, city-level

-- Windows OS audit/event log entries shipped by the agent, for the dashboard's audit trail.
CREATE TABLE IF NOT EXISTS device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  log_name TEXT NOT NULL,       -- System | Application | Security
  level TEXT NOT NULL,          -- Information | Warning | Error | Critical
  source TEXT,                  -- the Windows event provider, e.g. "Microsoft-Windows-Kernel-Power"
  event_id INTEGER,
  message TEXT NOT NULL,
  logged_at TEXT NOT NULL,      -- when Windows recorded the event
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events(device_id, logged_at DESC);
