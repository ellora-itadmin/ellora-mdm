const { Hono } = require('hono');
const { cors } = require('hono/cors');
const { sweep } = require('./sweep');

const authRoutes = require('./routes/auth');
const deviceRoutes = require('./routes/devices');
const policyRoutes = require('./routes/policies');
const alertRoutes = require('./routes/alerts');
const agentRoutes = require('./routes/agent');

const app = new Hono();

app.use('*', cors());

app.get('/api/health', (c) => c.json(c.env.DEBUG_WRITES ? { ok: true, service: 'ellora-mdm-server', ...require('./db').stats } : { ok: true, service: 'ellora-mdm-server' }));

app.route('/api/auth', authRoutes);
app.route('/api/devices', deviceRoutes);
app.route('/api/policies', policyRoutes);
app.route('/api/alerts', alertRoutes);
app.route('/api/agent', agentRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

// Use ESM export syntax for the Workers entry point so wrangler/esbuild
// detects this as an ES Module Worker (required for nodejs_compat) instead
// of the legacy Service Worker format.
export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
    // Retention (90 days of app usage, 30 days of events). Hourly rather than every
    // minute: each run scans those tables, and D1's free tier also caps rows READ.
    if (new Date(event.scheduledTime).getUTCMinutes() === 0) {
      ctx.waitUntil(env.DB.batch([
        env.DB.prepare("DELETE FROM device_app_usage WHERE usage_date < date('now','-90 days')"),
        env.DB.prepare("DELETE FROM device_events WHERE received_at < datetime('now','-30 days')")
      ]));
    }  }
};
