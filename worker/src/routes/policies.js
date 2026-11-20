const { Hono } = require('hono');
const { wrap } = require('../db');
const { requireAuth } = require('../middleware/auth');

const app = new Hono();
app.use('*', requireAuth);

app.get('/', async (c) => {
  const db = wrap(c.env.DB);
  const policies = await db.prepare('SELECT * FROM policies ORDER BY created_at DESC').all();
  const withCounts = [];
  for (const p of policies) {
    const c2 = (await db.prepare('SELECT COUNT(*) c FROM device_policies WHERE policy_id = ?').get(p.id)).c;
    withCounts.push({ ...p, device_count: c2 });
  }
  return c.json({ policies: withCounts });
});

app.get('/:id', async (c) => {
  const db = wrap(c.env.DB);
  const policy = await db.prepare('SELECT * FROM policies WHERE id = ?').get(c.req.param('id'));
  if (!policy) return c.json({ error: 'Policy not found' }, 404);
  const devices = await db.prepare(`
    SELECT d.* FROM devices d
    JOIN device_policies dp ON dp.device_id = d.id
    WHERE dp.policy_id = ?
  `).all(policy.id);
  return c.json({ policy, devices });
});

app.post('/', async (c) => {
  let body;
  try { body = await c.req.json(); } catch (e) { body = {}; }
  const { name, platform, require_password, require_encryption, auto_lock_minutes } = body || {};
  if (!name) return c.json({ error: 'name is required' }, 400);
  const db = wrap(c.env.DB);
  const info = await db.prepare(`
    INSERT INTO policies (name, platform, require_password, require_encryption, auto_lock_minutes)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, platform || 'windows', require_password ? 1 : 0, require_encryption ? 1 : 0, auto_lock_minutes || 5);
  const policy = await db.prepare('SELECT * FROM policies WHERE id = ?').get(info.lastInsertRowid);
  return c.json({ policy }, 201);
});

app.put('/:id', async (c) => {
  const db = wrap(c.env.DB);
  const existing = await db.prepare('SELECT * FROM policies WHERE id = ?').get(c.req.param('id'));
  if (!existing) return c.json({ error: 'Policy not found' }, 404);
  let body;
  try { body = await c.req.json(); } catch (e) { body = {}; }
  const { name, platform, require_password, require_encryption, auto_lock_minutes } = body || {};
  await db.prepare(`
    UPDATE policies SET name = ?, platform = ?, require_password = ?, require_encryption = ?, auto_lock_minutes = ?
    WHERE id = ?
  `).run(
    name ?? existing.name,
    platform ?? existing.platform,
    require_password !== undefined ? (require_password ? 1 : 0) : existing.require_password,
    require_encryption !== undefined ? (require_encryption ? 1 : 0) : existing.require_encryption,
    auto_lock_minutes ?? existing.auto_lock_minutes,
    c.req.param('id')
  );
  const policy = await db.prepare('SELECT * FROM policies WHERE id = ?').get(c.req.param('id'));
  return c.json({ policy });
});

app.delete('/:id', async (c) => {
  const db = wrap(c.env.DB);
  await db.prepare('DELETE FROM policies WHERE id = ?').run(c.req.param('id'));
  return c.json({ ok: true });
});

module.exports = app;
