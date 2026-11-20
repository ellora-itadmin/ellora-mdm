const { Hono } = require('hono');
const bcrypt = require('bcryptjs');
const { sign } = require('hono/jwt');
const { wrap } = require('../db');
const { requireAuth } = require('../middleware/auth');

const app = new Hono();

app.post('/login', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    body = {};
  }
  const { email, password } = body || {};
  if (!email || !password) return c.json({ error: 'Email and password are required' }, 400);

  const db = wrap(c.env.DB);
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return c.json({ error: 'Invalid credentials' }, 401);

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401);

  // hono/jwt expects `exp` as a unix timestamp (seconds). Replicates '12h' expiry.
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const token = await sign(
    { sub: user.id, email: user.email, name: user.name, exp },
    c.env.JWT_SECRET
  );
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/me', requireAuth, (c) => {
  return c.json({ user: c.get('user') });
});

module.exports = app;
