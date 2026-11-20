const { wrap } = require('../db');

// Hono-style middleware: requireAgentToken(c, next)
// Note: agent routes read the JSON body in the route handler itself; to
// support `api_token` in the body (fallback, as in the original Express
// code) we parse the body once here and stash it on the context so route
// handlers can reuse it via c.get('body') instead of calling c.req.json()
// again (Request bodies can only be consumed once).
async function requireAgentToken(c, next) {
  const header = c.req.header('authorization') || c.req.header('Authorization') || '';
  let bodyToken = null;
  let parsedBody = null;
  try {
    parsedBody = await c.req.json();
    bodyToken = parsedBody?.api_token || null;
  } catch (e) {
    parsedBody = {};
  }
  c.set('body', parsedBody);

  const token = header.startsWith('Bearer ') ? header.slice(7) : bodyToken;
  if (!token) return c.json({ error: 'Missing device API token' }, 401);

  const db = wrap(c.env.DB);
  const device = await db.prepare('SELECT * FROM devices WHERE api_token = ?').get(token);
  if (!device) return c.json({ error: 'Invalid device token' }, 401);

  c.set('device', device);
  await next();
}

module.exports = { requireAgentToken };
