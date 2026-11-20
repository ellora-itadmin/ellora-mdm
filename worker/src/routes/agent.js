const { Hono } = require('hono');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { wrap } = require('../db');
const { requireAgentToken } = require('../middleware/agentAuth');

const app = new Hono();

// Enrollment: agent presents enrollment_code, gets back a permanent api_token
app.post('/enroll', async (c) => {
  let body;
  try { body = await c.req.json(); } catch (e) { body = {}; }
  const { enrollment_code, hostname, platform } = body || {};
  if (!enrollment_code) return c.json({ error: 'enrollment_code is required' }, 400);

  const db = wrap(c.env.DB);
  const device = await db.prepare('SELECT * FROM devices WHERE enrollment_code = ?').get(enrollment_code);
  if (!device) return c.json({ error: 'Invalid enrollment code' }, 404);

  const api_token = device.api_token || uuidv4();
  await db.prepare(`
    UPDATE devices SET api_token = ?, status = 'online', name = COALESCE(?, name),
      platform = COALESCE(?, platform), enrolled_at = datetime('now'), last_checkin = datetime('now')
    WHERE id = ?
  `).run(api_token, hostname, platform, device.id);

  return c.json({ api_token, device_id: device.id, device_uuid: device.device_uuid });
});

// Cheap validity check for a device's api_token — used by the GUI setup
// wizard to confirm a locally-cached enrollment is still real on the server
// (e.g. the device may have been deleted from the dashboard since), without
// the side effects (history snapshot, command dispatch) a full check-in has.
app.get('/validate', requireAgentToken, async (c) => {
  const device = c.get('device');
  return c.json({ ok: true, device_id: device.id, device_uuid: device.device_uuid, device_name: device.name });
});

// Check-in: agent reports inventory, receives pending commands
app.post('/checkin', requireAgentToken, async (c) => {
  const device = c.get('device');
  const body = c.get('body') || {};
  const inv = body?.inventory || {};

  const db = wrap(c.env.DB);
  const hasLocation = inv.latitude != null && inv.longitude != null;

  // D1's free tier allows only 100,000 row writes a day. A device checks in every
  // 15s (so commands arrive quickly), but its row only needs refreshing about every
  // 2 minutes, so most check-ins are read-only. Writes still happen immediately when
  // the device was offline or its agent version changed.
  const lastMs = device.last_checkin ? Date.parse(device.last_checkin.replace(' ', 'T') + 'Z') : 0;
  const ageSec = (Date.now() - lastMs) / 1000;
  const versionChanged = inv.agent_version && inv.agent_version !== device.agent_version;
  const needsWrite = device.status !== 'online' || !lastMs || ageSec >= 110 || versionChanged;

  if (needsWrite) await db.prepare(`
    UPDATE devices SET
      status = 'online',
      os_version = COALESCE(?, os_version),
      arch = COALESCE(?, arch),
      total_memory_mb = COALESCE(?, total_memory_mb),
      free_memory_mb = COALESCE(?, free_memory_mb),
      cpu_model = COALESCE(?, cpu_model),
      uptime_seconds = COALESCE(?, uptime_seconds),
      serial_number = COALESCE(?, serial_number),
      latitude = COALESCE(?, latitude),
      longitude = COALESCE(?, longitude),
      location_label = COALESCE(?, location_label),
      location_updated_at = CASE WHEN ? THEN datetime('now') ELSE location_updated_at END,
      agent_version = COALESCE(?, agent_version),
      logged_in_user = COALESCE(?, logged_in_user),
      local_users = COALESCE(?, local_users),
      agent_elevated = COALESCE(?, agent_elevated),
      last_checkin = datetime('now')
    WHERE id = ?
  `).run(
    inv.os_version || null,
    inv.arch || null,
    inv.total_memory_mb || null,
    inv.free_memory_mb || null,
    inv.cpu_model || null,
    inv.uptime_seconds || null,
    inv.serial_number || null,
    hasLocation ? inv.latitude : null,
    hasLocation ? inv.longitude : null,
    inv.location_label || null,
    hasLocation ? 1 : 0,
    inv.agent_version || null,
    inv.logged_in_user || null,
    Array.isArray(inv.local_users) && inv.local_users.length ? JSON.stringify(inv.local_users.slice(0, 100)) : null,
    typeof inv.is_elevated === 'boolean' ? (inv.is_elevated ? 1 : 0) : null,
    device.id
  );

  const pending = await db.prepare(`
    SELECT * FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at ASC
  `).all(device.id);

  if (pending.length) {
    const ids = pending.map(cmd => cmd.id);
    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`UPDATE commands SET status = 'sent' WHERE id IN (${placeholders})`).run(...ids);
  }

  return c.json({
    ok: true,
    commands: pending.map(cmd => ({ id: cmd.id, type: cmd.type, payload: cmd.payload ? JSON.parse(cmd.payload) : null }))
  });
});

// Command result reporting
app.post('/command-result', requireAgentToken, async (c) => {
  const body = c.get('body') || {};
  const { command_id, status, result } = body || {};
  if (!command_id || !status) return c.json({ error: 'command_id and status are required' }, 400);

  const device = c.get('device');
  const db = wrap(c.env.DB);
  const command = await db.prepare('SELECT * FROM commands WHERE id = ? AND device_id = ?').get(command_id, device.id);
  if (!command) return c.json({ error: 'Command not found for this device' }, 404);

  await db.prepare(`
    UPDATE commands SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?
  `).run(status, typeof result === 'string' ? result : JSON.stringify(result || {}), command_id);

  if (command.type === 'reset_password') {
    // Done (success or failure): the plaintext password has no reason to stay in the DB.
    await db.prepare('UPDATE commands SET payload = ? WHERE id = ?')
      .run(JSON.stringify({ username: (command.payload ? JSON.parse(command.payload).username : null) }), command_id);
  }

  if (command.type === 'wipe' && status === 'success') {
    await db.prepare("UPDATE devices SET status = 'offline' WHERE id = ?").run(device.id);
  }

  return c.json({ ok: true });
});

// Windows OS event/audit log shipping. Body: { events: [{ log_name, level, source, event_id, message, logged_at }] }
app.post('/events', requireAgentToken, async (c) => {
  const device = c.get('device');
  const body = c.get('body') || {};
  const events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) return c.json({ ok: true, received: 0 });

  const db = wrap(c.env.DB);
  const capped = events.slice(0, 200); // guard against runaway batches
  for (const ev of capped) {
    await db.prepare(`
      INSERT INTO device_events (device_id, log_name, level, source, event_id, message, logged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      device.id,
      ev.log_name || 'System',
      ev.level || 'Information',
      ev.source || null,
      ev.event_id || null,
      String(ev.message || '').slice(0, 2000),
      ev.logged_at || new Date().toISOString()
    );
  }
  return c.json({ ok: true, received: capped.length });
});

// Installed-software inventory. Body: { software: [{ name, version }] }
// The agent sends its full list every few minutes, but it almost never changes.
// D1's free tier caps row WRITES at 100,000/day, so compare with what's stored
// (reads are cheap) and write only the differences — usually nothing at all.
app.post('/software', requireAgentToken, async (c) => {
  const device = c.get('device');
  const body = c.get('body') || {};
  const incoming = new Map();
  for (const s of (Array.isArray(body.software) ? body.software.slice(0, 500) : [])) {
    if (!s.name) continue;
    const name = String(s.name).slice(0, 300);
    const version = s.version ? String(s.version).slice(0, 100) : null;
    incoming.set(`${name}\u0000${version ?? ''}`, { name, version });
  }

  const db = wrap(c.env.DB);
  const existing = await db.prepare('SELECT id, name, version FROM device_software WHERE device_id = ?').all(device.id);
  const have = new Map(existing.map((r) => [`${r.name}\u0000${r.version ?? ''}`, r.id]));

  let removed = 0, added = 0;
  for (const [key, id] of have) {
    if (!incoming.has(key)) { await db.prepare('DELETE FROM device_software WHERE id = ?').run(id); removed++; }
  }
  for (const [key, s] of incoming) {
    if (!have.has(key)) {
      await db.prepare('INSERT INTO device_software (device_id, name, version) VALUES (?, ?, ?)').run(device.id, s.name, s.version);
      added++;
    }
  }
  return c.json({ ok: true, received: incoming.size, added, removed });
});

// App usage. Body: { days: [{ date, user, apps: [{ exe, name, seconds }] }] }
// Totals are cumulative per day, so nothing is lost by writing less often: at most
// once per 30 minutes per device, and only the apps whose total actually grew.
app.post('/usage', requireAgentToken, async (c) => {
  const device = c.get('device');
  const body = c.get('body') || {};
  const days = Array.isArray(body.days) ? body.days.slice(0, 10) : [];
  const db = wrap(c.env.DB);

  const last = await db.prepare('SELECT MAX(updated_at) AS t FROM device_app_usage WHERE device_id = ?').get(device.id);
  if (last && last.t) {
    const ageMin = (Date.now() - Date.parse(last.t.replace(' ', 'T') + 'Z')) / 60000;
    if (ageMin < 30) return c.json({ ok: true, rows: 0, throttled: true });
  }

  const dates = [...new Set(days.map((d) => d.date).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x || '')))];
  const stored = new Map();
  if (dates.length) {
    const rows = await db.prepare(
      `SELECT usage_date, windows_user, exe_name, seconds FROM device_app_usage
       WHERE device_id = ? AND usage_date IN (${dates.map(() => '?').join(',')})`
    ).all(device.id, ...dates);
    for (const r of rows) stored.set(`${r.usage_date}|${r.windows_user}|${r.exe_name}`, r.seconds);
  }

  let written = 0;
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '') || !d.user) continue;
    const user = String(d.user).slice(0, 100);
    for (const a of (Array.isArray(d.apps) ? d.apps.slice(0, 300) : [])) {
      const secs = Math.max(0, Math.min(86400, Math.floor(Number(a.seconds) || 0)));
      if (!a.exe || secs === 0) continue;
      const exe = String(a.exe).slice(0, 120).toLowerCase();
      const prev = stored.get(`${d.date}|${user}|${exe}`);
      if (prev !== undefined && secs <= prev) continue; // nothing new for this app
      await db.prepare(`
        INSERT INTO device_app_usage (device_id, usage_date, windows_user, exe_name, app_name, seconds)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, usage_date, windows_user, exe_name) DO UPDATE SET
          seconds = MAX(seconds, excluded.seconds),
          app_name = excluded.app_name,
          updated_at = datetime('now')
      `).run(device.id, d.date, user, exe, String(a.name || a.exe).slice(0, 160), secs);
      written++;
    }
  }
  return c.json({ ok: true, rows: written });
});
// Lets the agent raise an alert directly (e.g. it detected a local factory
// reset being started). Body: { type, severity, message }
app.post('/alert', requireAgentToken, async (c) => {
  const device = c.get('device');
  const body = c.get('body') || {};
  const { type, severity, message } = body || {};
  if (!type || !message) return c.json({ error: 'type and message are required' }, 400);

  const db = wrap(c.env.DB);
  await db.prepare(`
    INSERT INTO alerts (device_id, type, severity, message) VALUES (?, ?, ?, ?)
  `).run(device.id, type, severity || 'critical', message);

  return c.json({ ok: true });
});

// Verifies the dashboard admin's password without ever exposing the hash to
// the device. Used by the desktop agent to gate a factory-reset/wipe locally
// before it lets Windows's own reset flow start.
app.post('/verify-admin-password', requireAgentToken, async (c) => {
  const body = c.get('body') || {};
  const { password } = body || {};
  if (!password) return c.json({ valid: false, error: 'password is required' }, 400);

  const db = wrap(c.env.DB);
  const admin = await db.prepare('SELECT password_hash FROM users ORDER BY id ASC LIMIT 1').get();
  if (!admin) return c.json({ valid: false }, 200);

  const valid = bcrypt.compareSync(password, admin.password_hash);
  return c.json({ valid });
});

module.exports = app;
