const express = require('express');
const db = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { resolved } = req.query;
  let sql = `
    SELECT a.*, d.name AS device_name FROM alerts a
    LEFT JOIN devices d ON d.id = a.device_id
    WHERE 1=1
  `;
  const params = [];
  if (resolved !== undefined) { sql += ' AND a.resolved = ?'; params.push(resolved === 'true' ? 1 : 0); }
  sql += ' ORDER BY a.created_at DESC';
  const alerts = db.prepare(sql).all(...params);
  res.json({ alerts });
});

router.post('/:id/resolve', (req, res) => {
  db.prepare('UPDATE alerts SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
