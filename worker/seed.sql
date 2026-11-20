-- Ported 1:1 from server/src/db/seed.js
-- Admin password is "ChangeMe123!" (bcrypt hash below, cost 10, pre-computed
-- locally with bcryptjs since D1/SQL cannot hash at insert time).
--
-- Run with:
--   wrangler d1 execute ellora-mdm-db --remote --file=./seed.sql
-- (use --local instead of --remote to seed the local dev database)

INSERT OR IGNORE INTO users (email, password_hash, name)
VALUES ('admin@elloraepc.com', '$2a$10$51QGXB.t1ctMq/b8U0JKqOquz5437GPRW/QKTnUpW6KTAMPnuRUGS', 'IT Admin');

-- Devices (ids will be 1..4 on a fresh database)
INSERT INTO devices (device_uuid, name, platform, status, compliance, api_token, serial_number,
  os_version, arch, total_memory_mb, free_memory_mb, cpu_model, uptime_seconds, owner,
  last_checkin, enrolled_at)
VALUES
  ('86a249cd-6f72-403e-8687-80eeb2f65e51', 'ELLORA-FIN-01', 'windows', 'online', 'compliant',
   '231b67b5-e23a-4555-afb0-58a40bcdbbf5', 'SN-WIN-1001', 'Windows 11 Pro 23H2', 'x64',
   16384, 6210, 'Intel Core i7-1265U', 53200, 'Finance Dept',
   datetime('now'), datetime('now')),
  ('8ebae021-6a02-41dd-830a-1d4935b3bbc6', 'ELLORA-ENG-MAC-02', 'macos', 'online', 'compliant',
   '4ac8eefd-7caa-4653-b16e-a95528cafad6', 'SN-MAC-2002', 'macOS 14.5 Sonoma', 'arm64',
   16384, 4096, 'Apple M2', 187400, 'Engineering',
   datetime('now'), datetime('now')),
  ('b5121838-52e7-464c-8bb4-260dea6047f3', 'ELLORA-SITE-WIN-03', 'windows', 'offline', 'non_compliant',
   '6da8aca0-03cc-41d8-8747-fb00628c7fb4', 'SN-WIN-1003', 'Windows 10 Pro 22H2', 'x64',
   8192, 1024, 'Intel Core i5-8250U', 0, 'Site Office - Pune',
   datetime('now'), datetime('now')),
  ('3b717027-a990-490a-8e8f-81bb04507264', 'ELLORA-SALES-AND-04', 'android', 'pending', 'unknown',
   'd12b6484-3df2-4886-98fe-97eaa0a866c3', 'SN-AND-3004', 'Android 14', 'arm64',
   6144, 2048, 'Snapdragon 7 Gen 1', 0, 'Sales',
   NULL, NULL);

-- Software
INSERT INTO device_software (device_id, name, version) VALUES
  (1, 'Microsoft 365 Apps', '16.0.17726'),
  (1, 'Google Chrome', '128.0.6613'),
  (2, 'Xcode', '15.4'),
  (2, 'Google Chrome', '128.0.6613'),
  (3, 'Microsoft 365 Apps', '16.0.16924');

-- Policies (ids will be 1..2 on a fresh database)
INSERT INTO policies (name, platform, require_password, require_encryption, auto_lock_minutes) VALUES
  ('Standard Windows Security', 'windows', 1, 1, 5),
  ('macOS Baseline', 'macos', 1, 1, 10);

-- Policy assignments
INSERT INTO device_policies (device_id, policy_id) VALUES
  (1, 1),
  (3, 1),
  (2, 2);

-- Alerts
INSERT INTO alerts (device_id, type, severity, message) VALUES
  (3, 'offline', 'critical', 'Device has been offline for more than 24 hours.'),
  (3, 'compliance', 'warning', 'Disk encryption is not enabled on this device.'),
  (4, 'enrollment', 'info', 'Device enrolled but pending first check-in.');
