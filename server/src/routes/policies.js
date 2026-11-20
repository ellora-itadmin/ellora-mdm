const express = require('express');
const db = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const policies = db.prepare('SELECT * FROM policies ORDER BY created_at DESC').all();
  const withCounts = policies.map(p => ({
    ...p,
    device_count: db.prepare('SELECT COUNT(*) c FROM device_policies WHERE policy_id = ?').get(p.id).c
  }));
  res.json({ policies: withCounts });
});

router.get('/:id', (req, res) => {
  const policy = db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
  if (!policy) return res.status(404).json({ error: 'Policy not found' });
  const devices = db.prepare(`
    SELECT d.* FROM devices d
    JOIN device_policies dp ON dp.device_id = d.id
    WHERE dp.policy_id = ?
  `).all(policy.id);
  res.json({ policy, devices });
});

router.post('/', (req, res) => {
  const { name, platform, require_password, require_encryption, auto_lock_minutes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare(`
    INSERT INTO policies (name, platform, require_password, require_encryption, auto_lock_minutes)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, platform || 'windows', require_password ? 1 : 0, require_encryption ? 1 : 0, auto_lock_minutes || 5);
  const policy = db.prepare('SELECT * FROM policies WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ policy });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Policy not found' });
  const { name, platform, require_password, require_encryption, auto_lock_minutes } = req.body || {};
  db.prepare(`
    UPDATE policies SET name = ?, platform = ?, require_password = ?, require_encryption = ?, auto_lock_minutes = ?
    WHERE id = ?
  `).run(
    name ?? existing.name,
    platform ?? existing.platform,
    require_password !== undefined ? (require_password ? 1 : 0) : existing.require_password,
    require_encryption !== undefined ? (require_encryption ? 1 : 0) : existing.require_encryption,
    auto_lock_minutes ?? existing.auto_lock_minutes,
    req.params.id
  );
  const policy = db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
  res.json({ policy });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM policies WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
