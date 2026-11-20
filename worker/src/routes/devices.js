const { Hono } = require('hono');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { wrap } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sweep } = require('../sweep');

const app = new Hono();
app.use('*', requireAuth);

// The new Windows password lives in a pending reset_password command's payload
// only until the device applies it. It must never be echoed back to the browser.
function redact(cmd) {
  if (cmd && cmd.type === 'reset_password' && cmd.payload) {
    try {
      const p = JSON.parse(cmd.payload);
      return { ...cmd, payload: JSON.stringify({ username: p.username }) };
    } catch (e) { return { ...cmd, payload: null }; }
  }
  return cmd;
}

// list with filters
app.get('/', async (c) => {
  await sweep(c.env);
  const { platform, status, compliance, q } = c.req.query();
  let sql = 'SELECT * FROM devices WHERE 1=1';
  const params = [];
  if (platform) { sql += ' AND platform = ?'; params.push(platform); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (compliance) { sql += ' AND compliance = ?'; params.push(compliance); }
  if (q) { sql += ' AND (name LIKE ? OR serial_number LIKE ? OR owner LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  const db = wrap(c.env.DB);
  const rows = await db.prepare(sql).all(...params);
  return c.json({ devices: rows });
});

app.get('/stats/overview', async (c) => {
  await sweep(c.env);
  const db = wrap(c.env.DB);
  const total = (await db.prepare('SELECT COUNT(*) c FROM devices').get()).c;
  const byStatus = await db.prepare('SELECT status, COUNT(*) c FROM devices GROUP BY status').all();
  const byPlatform = await db.prepare('SELECT platform, COUNT(*) c FROM devices GROUP BY platform').all();
  const byCompliance = await db.prepare('SELECT compliance, COUNT(*) c FROM devices GROUP BY compliance').all();
  const alerts = (await db.prepare('SELECT COUNT(*) c FROM alerts WHERE resolved = 0').get()).c;
  // Devices with an agent that has not been heard from for over 2 days: someone needs to act on these.
  const silent = (await db.prepare("SELECT COUNT(*) c FROM devices WHERE last_checkin IS NOT NULL AND last_checkin < datetime('now','-2 days')").get()).c;
  return c.json({ total, byStatus, byPlatform, byCompliance, openAlerts: alerts, silent });
});

// Event log for one device, filtered by severity. ?level=critical (default) | error | all
//   critical = Critical only, error = Critical + Error, all = everything incl. warnings.
app.get('/:id/events', async (c) => {
  const db = wrap(c.env.DB);
  const level = c.req.query('level') || 'critical';
  const levels = level === 'all' ? null : level === 'error' ? ['Critical', 'Error'] : ['Critical'];
  const where = levels ? `AND level IN (${levels.map(() => '?').join(',')})` : '';
  const events = await db.prepare(
    `SELECT * FROM device_events WHERE device_id = ? ${where} ORDER BY logged_at DESC LIMIT 200`
  ).all(c.req.param('id'), ...(levels || []));
  return c.json({ events });
});

// App usage for one device. ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, defaults to the last 7 days).
// Returns per-app totals, per-day totals (for the day-wise chart) and the users seen.
app.get('/:id/usage', async (c) => {
  const db = wrap(c.env.DB);
  const id = c.req.param('id');
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  let { from, to, user } = c.req.query();
  if (!isDate(to)) to = new Date().toISOString().slice(0, 10);
  if (!isDate(from)) from = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);

  const userClause = user ? ' AND windows_user = ?' : '';
  const params = user ? [id, from, to, user] : [id, from, to];

  const apps = await db.prepare(`
    SELECT app_name, exe_name, SUM(seconds) AS seconds
    FROM device_app_usage
    WHERE device_id = ? AND usage_date BETWEEN ? AND ?${userClause}
    GROUP BY exe_name ORDER BY seconds DESC LIMIT 100
  `).all(...params);

  const daily = await db.prepare(`
    SELECT usage_date AS date, SUM(seconds) AS seconds
    FROM device_app_usage
    WHERE device_id = ? AND usage_date BETWEEN ? AND ?${userClause}
    GROUP BY usage_date ORDER BY usage_date
  `).all(...params);

  const users = await db.prepare(
    'SELECT DISTINCT windows_user FROM device_app_usage WHERE device_id = ? ORDER BY windows_user'
  ).all(id);

  return c.json({ from, to, apps, daily, users: users.map((u) => u.windows_user) });
});

app.get('/:id', async (c) => {
  await sweep(c.env);
  const id = c.req.param('id');
  const db = wrap(c.env.DB);
  const device = await db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!device) return c.json({ error: 'Device not found' }, 404);
  const software = await db.prepare('SELECT * FROM device_software WHERE device_id = ? ORDER BY name').all(device.id);
  const policies = await db.prepare(`
    SELECT p.* FROM policies p
    JOIN device_policies dp ON dp.policy_id = p.id
    WHERE dp.device_id = ?
  `).all(device.id);
  const commands = (await db.prepare('SELECT * FROM commands WHERE device_id = ? ORDER BY created_at DESC LIMIT 50').all(device.id)).map(redact);
  const events = await db.prepare('SELECT * FROM device_events WHERE device_id = ? ORDER BY logged_at DESC LIMIT 100').all(device.id);
  return c.json({ device, software, policies, commands, events });
});

app.post('/', async (c) => {
  let body;
  try { body = await c.req.json(); } catch (e) { body = {}; }
  const { name, platform, owner } = body || {};
  if (!name) return c.json({ error: 'name is required' }, 400);
  const device_uuid = uuidv4();
  const enrollment_code = uuidv4().slice(0, 8).toUpperCase();
  const db = wrap(c.env.DB);
  const info = await db.prepare(`
    INSERT INTO devices (device_uuid, name, platform, owner, enrollment_code, status, compliance)
    VALUES (?, ?, ?, ?, ?, 'pending', 'unknown')
  `).run(device_uuid, name, platform || 'windows', owner || null, enrollment_code);
  const device = await db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
  return c.json({ device }, 201);
});

app.delete('/:id', async (c) => {
  const db = wrap(c.env.DB);
  await db.prepare('DELETE FROM devices WHERE id = ?').run(c.req.param('id'));
  return c.json({ ok: true });
});

// commands
app.post('/:id/commands', async (c) => {
  let body;
  try { body = await c.req.json(); } catch (e) { body = {}; }
  const { type, payload } = body || {};
  const validTypes = ['lock', 'restart', 'wipe', 'run_script', 'install_software', 'update_agent', 'reset_password', 'get_log'];
  if (!validTypes.includes(type)) return c.json({ error: 'Invalid command type' }, 400);

  const db = wrap(c.env.DB);
  const device = await db.prepare('SELECT * FROM devices WHERE id = ?').get(c.req.param('id'));
  if (!device) return c.json({ error: 'Device not found' }, 404);

  const user = c.get('user');

  if (type === 'reset_password') {
    const { username, new_password } = payload || {};
    if (!username || !new_password) return c.json({ error: 'username and new_password are required' }, 400);
    if (String(new_password).length < 8) return c.json({ error: 'New password must be at least 8 characters' }, 400);
    if (device.local_users) {
      let known = [];
      try { known = JSON.parse(device.local_users); } catch (e) { /* ignore */ }
      if (known.length && !known.some((u) => u.toLowerCase() === String(username).toLowerCase())) {
        return c.json({ error: `"${username}" is not a local account on this device` }, 400);
      }
    }
    // Re-authenticate the admin: a stolen dashboard session alone must not be
    // enough to take over a laptop's login.
    const admin = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get(user.email);
    if (!admin || !bcrypt.compareSync(String(body.admin_password || ''), admin.password_hash)) {
      return c.json({ error: 'Your admin password is incorrect' }, 403);
    }
  }
  const info = await db.prepare(`
    INSERT INTO commands (device_id, type, payload, status, created_by) VALUES (?, ?, ?, 'pending', ?)
  `).run(device.id, type, payload ? JSON.stringify(payload) : null, user.email);
  const command = await db.prepare('SELECT * FROM commands WHERE id = ?').get(info.lastInsertRowid);
  return c.json({ command: redact(command) }, 201);
});

// Rollout: queues an 'update_agent' command for every currently-enrolled
// Windows device not already on the given target version. The command's
// payload carries the download URL so the agent doesn't need it hardcoded
// to a single location (future-proofs moving the hosted exe).
app.post('/rollout-update', async (c) => {
  let body;
  try { body = await c.req.json(); } catch (e) { body = {}; }
  const { target_version, download_url } = body || {};
  if (!target_version || !download_url) {
    return c.json({ error: 'target_version and download_url are required' }, 400);
  }

  const db = wrap(c.env.DB);
  const user = c.get('user');
  const targets = await db.prepare(`
    SELECT id FROM devices
    WHERE platform = 'windows' AND api_token IS NOT NULL
      AND (agent_version IS NULL OR agent_version != ?)
  `).all(target_version);

  for (const d of targets) {
    // Only the newest update matters: supersede any older pending/sent one so they never stack up
    // (a stale command for an older version would make the update's health check fail).
    await db.prepare("UPDATE commands SET status = 'failed', result = ?, completed_at = datetime('now') WHERE device_id = ? AND type = 'update_agent' AND status IN ('pending','sent')").run(JSON.stringify({ note: 'Superseded by a newer update' }), d.id);
    await db.prepare(`
      INSERT INTO commands (device_id, type, payload, status, created_by) VALUES (?, 'update_agent', ?, 'pending', ?)
    `).run(d.id, JSON.stringify({ download_url, target_version }), user.email);
  }

  return c.json({ ok: true, queued: targets.length });
});

app.get('/:id/commands', async (c) => {
  const db = wrap(c.env.DB);
  const commands = (await db.prepare('SELECT * FROM commands WHERE device_id = ? ORDER BY created_at DESC').all(c.req.param('id'))).map(redact);
  return c.json({ commands });
});

// policy assignment
app.post('/:id/policies/:policyId', async (c) => {
  const db = wrap(c.env.DB);
  try {
    await db.prepare('INSERT INTO device_policies (device_id, policy_id) VALUES (?, ?)').run(c.req.param('id'), c.req.param('policyId'));
  } catch (e) { /* already assigned */ }
  return c.json({ ok: true });
});

app.delete('/:id/policies/:policyId', async (c) => {
  const db = wrap(c.env.DB);
  await db.prepare('DELETE FROM device_policies WHERE device_id = ? AND policy_id = ?').run(c.req.param('id'), c.req.param('policyId'));
  return c.json({ ok: true });
});

module.exports = app;
