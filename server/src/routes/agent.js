const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/connection');
const { requireAgentToken } = require('../middleware/agentAuth');

const router = express.Router();

// Enrollment: agent presents enrollment_code, gets back a permanent api_token
router.post('/enroll', (req, res) => {
  const { enrollment_code, hostname, platform } = req.body || {};
  if (!enrollment_code) return res.status(400).json({ error: 'enrollment_code is required' });

  const device = db.prepare('SELECT * FROM devices WHERE enrollment_code = ?').get(enrollment_code);
  if (!device) return res.status(404).json({ error: 'Invalid enrollment code' });

  const api_token = device.api_token || uuidv4();
  db.prepare(`
    UPDATE devices SET api_token = ?, status = 'online', name = COALESCE(?, name),
      platform = COALESCE(?, platform), enrolled_at = datetime('now'), last_checkin = datetime('now')
    WHERE id = ?
  `).run(api_token, hostname, platform, device.id);

  res.json({ api_token, device_id: device.id, device_uuid: device.device_uuid });
});

// Check-in: agent reports inventory, receives pending commands
router.post('/checkin', requireAgentToken, (req, res) => {
  const device = req.device;
  const inv = req.body?.inventory || {};

  db.prepare(`
    UPDATE devices SET
      status = 'online',
      os_version = COALESCE(?, os_version),
      arch = COALESCE(?, arch),
      total_memory_mb = COALESCE(?, total_memory_mb),
      free_memory_mb = COALESCE(?, free_memory_mb),
      cpu_model = COALESCE(?, cpu_model),
      uptime_seconds = COALESCE(?, uptime_seconds),
      last_checkin = datetime('now')
    WHERE id = ?
  `).run(
    inv.os_version || null,
    inv.arch || null,
    inv.total_memory_mb || null,
    inv.free_memory_mb || null,
    inv.cpu_model || null,
    inv.uptime_seconds || null,
    device.id
  );

  db.prepare('INSERT INTO device_history (device_id, snapshot) VALUES (?, ?)')
    .run(device.id, JSON.stringify(inv));

  const pending = db.prepare(`
    SELECT * FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at ASC
  `).all(device.id);

  if (pending.length) {
    const ids = pending.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE commands SET status = 'sent' WHERE id IN (${placeholders})`).run(...ids);
  }

  res.json({
    ok: true,
    commands: pending.map(c => ({ id: c.id, type: c.type, payload: c.payload ? JSON.parse(c.payload) : null }))
  });
});

// Command result reporting
router.post('/command-result', requireAgentToken, (req, res) => {
  const { command_id, status, result } = req.body || {};
  if (!command_id || !status) return res.status(400).json({ error: 'command_id and status are required' });

  const command = db.prepare('SELECT * FROM commands WHERE id = ? AND device_id = ?').get(command_id, req.device.id);
  if (!command) return res.status(404).json({ error: 'Command not found for this device' });

  db.prepare(`
    UPDATE commands SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?
  `).run(status, typeof result === 'string' ? result : JSON.stringify(result || {}), command_id);

  if (command.type === 'wipe' && status === 'success') {
    db.prepare("UPDATE devices SET status = 'offline' WHERE id = ?").run(req.device.id);
  }

  res.json({ ok: true });
});

module.exports = router;
