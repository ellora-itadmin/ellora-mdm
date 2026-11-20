require('dotenv').config();
const express = require('express');
const cors = require('cors');
require('./db/schema'); // ensures tables exist
const db = require('./db/connection');

const authRoutes = require('./routes/auth');
const deviceRoutes = require('./routes/devices');
const policyRoutes = require('./routes/policies');
const alertRoutes = require('./routes/alerts');
const agentRoutes = require('./routes/agent');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ellora-mdm-server' }));

app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/policies', policyRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/agent', agentRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Periodic sweep: mark devices offline if no check-in for 10 min, raise alerts for >24h offline
function sweep() {
  try {
    db.prepare(`
      UPDATE devices SET status = 'offline'
      WHERE status = 'online' AND last_checkin IS NOT NULL
        AND datetime(last_checkin) < datetime('now', '-10 minutes')
    `).run();

    const staleDevices = db.prepare(`
      SELECT * FROM devices
      WHERE status = 'offline' AND last_checkin IS NOT NULL
        AND datetime(last_checkin) < datetime('now', '-24 hours')
    `).all();

    for (const d of staleDevices) {
      const already = db.prepare(`
        SELECT id FROM alerts WHERE device_id = ? AND type = 'offline' AND resolved = 0
      `).get(d.id);
      if (!already) {
        db.prepare(`
          INSERT INTO alerts (device_id, type, severity, message) VALUES (?, 'offline', 'critical', ?)
        `).run(d.id, `${d.name} has been offline for more than 24 hours.`);
      }
    }
  } catch (e) {
    console.error('Sweep error:', e.message);
  }
}
setInterval(sweep, 5 * 60 * 1000);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Ellora MDM server listening on http://localhost:${PORT}`);
});

module.exports = app;
