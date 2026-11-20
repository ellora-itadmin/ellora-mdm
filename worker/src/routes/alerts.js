const { Hono } = require('hono');
const { wrap } = require('../db');
const { requireAuth } = require('../middleware/auth');

const app = new Hono();
app.use('*', requireAuth);

app.get('/', async (c) => {
  const { resolved } = c.req.query();
  let sql = `
    SELECT a.*, d.name AS device_name FROM alerts a
    LEFT JOIN devices d ON d.id = a.device_id
    WHERE 1=1
  `;
  const params = [];
  if (resolved !== undefined) { sql += ' AND a.resolved = ?'; params.push(resolved === 'true' ? 1 : 0); }
  sql += ' ORDER BY a.created_at DESC';
  const db = wrap(c.env.DB);
  const alerts = await db.prepare(sql).all(...params);
  return c.json({ alerts });
});

app.post('/:id/resolve', async (c) => {
  const db = wrap(c.env.DB);
  await db.prepare('UPDATE alerts SET resolved = 1 WHERE id = ?').run(c.req.param('id'));
  return c.json({ ok: true });
});

module.exports = app;
