const { wrap } = require('./db');

// Marks devices offline if no check-in for 5 min (the device row is refreshed about every 2 min to stay inside D1's free write quota), and raises alerts for >24h offline.
// Called both from the Cron Trigger (src/index.js `scheduled`) and inline
// from dashboard read endpoints, so device status is accurate even if the
// Cron Trigger hasn't fired yet (propagation can lag right after a deploy).
async function sweep(env) {
  const db = wrap(env.DB);
  try {
    await db.prepare(`
      UPDATE devices SET status = 'offline'
      WHERE status = 'online' AND last_checkin IS NOT NULL
        AND datetime(last_checkin) < datetime('now', '-5 minutes')
    `).run();

    const staleDevices = await db.prepare(`
      SELECT * FROM devices
      WHERE status = 'offline' AND last_checkin IS NOT NULL
        AND datetime(last_checkin) < datetime('now', '-24 hours')
    `).all();

    for (const d of staleDevices) {
      const already = await db.prepare(`
        SELECT id FROM alerts WHERE device_id = ? AND type = 'offline' AND resolved = 0
      `).get(d.id);
      if (!already) {
        await db.prepare(`
          INSERT INTO alerts (device_id, type, severity, message) VALUES (?, 'offline', 'critical', ?)
        `).run(d.id, `${d.name} has been offline for more than 24 hours.`);
      }
    }
  } catch (e) {
    console.error('Sweep error:', e.message);
  }
}

module.exports = { sweep };
