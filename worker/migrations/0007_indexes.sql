-- Every agent check-in looks up pending commands by device. Without an index D1
-- scans the whole commands table each time (D1 free tier: 5M rows read per day).
CREATE INDEX IF NOT EXISTS idx_commands_device_status ON commands(device_id, status);
CREATE INDEX IF NOT EXISTS idx_events_received ON device_events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_device_level ON device_events(device_id, level, logged_at);
