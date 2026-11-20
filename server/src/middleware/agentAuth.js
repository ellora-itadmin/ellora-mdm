const db = require('../db/connection');

function requireAgentToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.body?.api_token;
  if (!token) return res.status(401).json({ error: 'Missing device API token' });
  const device = db.prepare('SELECT * FROM devices WHERE api_token = ?').get(token);
  if (!device) return res.status(401).json({ error: 'Invalid device token' });
  req.device = device;
  next();
}

module.exports = { requireAgentToken };
