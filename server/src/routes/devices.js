const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// list with filters
router.get('/', (req, res) => {
  const { platform, status, compliance, q } = req.query;
  let sql = 'SELECT * FROM devices WHERE 1=1';
  const params = [];
  if (platform) { sql += ' AND platform = ?'; params.push(platform); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (compliance) { sql += ' AND compliance = ?'; params.push(compliance); }
  if (q) { sql += ' AND (name LIKE ? OR serial_number LIKE ? OR owner LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json({ devices: rows });
});

router.get('/stats/overview', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM devices').get().c;
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM devices GROUP BY status').all();
  const byPlatform = db.prepare('SELECT platform, COUNT(*) c FROM devices GROUP BY platform').all();
  const byCompliance = db.prepare('SELECT compliance, COUNT(*) c FROM devices GROUP BY compliance').all();
  const alerts = db.prepare('SELECT COUNT(*) c FROM alerts WHERE resolved = 0').get().c;
  res.json({ total, byStatus, byPlatform, byCompliance, openAlerts: alerts });
});

router.get('/:id', (req, res) => {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const software = db.prepare('SELECT * FROM device_software WHERE device_id = ? ORDER BY name').all(device.id);
  const policies = db.prepare(`
    SELECT p.* FROM policies p
    JOIN device_policies dp ON dp.policy_id = p.id
    WHERE dp.device_id = ?
  `).all(device.id);
  const commands = db.prepare('SELECT * FROM commands WHERE device_id = ? ORDER BY created_at DESC LIMIT 50').all(device.id);
  res.json({ device, software, policies, commands });
});

router.post('/', (req, res) => {
  const { name, platform, owner } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const device_uuid = uuidv4();
  const enrollment_code = uuidv4().slice(0, 8).toUpperCase();
  const info = db.prepare(`
    INSERT INTO devices (device_uuid, name, platform, owner, enrollment_code, status, compliance)
    VALUES (?, ?, ?, ?, ?, 'pending', 'unknown')
  `).run(device_uuid, name, platform || 'windows', owner || null, enrollment_code);
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ device });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// commands
router.post('/:id/commands', (req, res) => {
  const { type, payload } = req.body || {};
  const validTypes = ['lock', 'restart', 'wipe', 'run_script', 'install_software'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid command type' });
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const info = db.prepare(`
    INSERT INTO commands (device_id, type, payload, status, created_by) VALUES (?, ?, ?, 'pending', ?)
  `).run(device.id, type, payload ? JSON.stringify(payload) : null, req.user.email);
  const command = db.prepare('SELECT * FROM commands WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ command });
});

router.get('/:id/commands', (req, res) => {
  const commands = db.prepare('SELECT * FROM commands WHERE device_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ commands });
});

// policy assignment
router.post('/:id/policies/:policyId', (req, res) => {
  try {
    db.prepare('INSERT INTO device_policies (device_id, policy_id) VALUES (?, ?)').run(req.params.id, req.params.policyId);
  } catch (e) { /* already assigned */ }
  res.json({ ok: true });
});

router.delete('/:id/policies/:policyId', (req, res) => {
  db.prepare('DELETE FROM device_policies WHERE device_id = ? AND policy_id = ?').run(req.params.id, req.params.policyId);
  res.json({ ok: true });
});

module.exports = router;
