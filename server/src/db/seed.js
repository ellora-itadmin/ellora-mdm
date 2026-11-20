require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./schema');

function seed() {
  const email = process.env.ADMIN_EMAIL || 'admin@elloraepc.com';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!existing) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)').run(email, hash, 'IT Admin');
    console.log(`Created admin user: ${email}`);
  } else {
    console.log(`Admin user already exists: ${email}`);
  }

  const deviceCount = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (deviceCount === 0) {
    const now = new Date().toISOString();
    const devices = [
      {
        name: 'ELLORA-FIN-01', platform: 'windows', status: 'online', compliance: 'compliant',
        serial_number: 'SN-WIN-1001', os_version: 'Windows 11 Pro 23H2', arch: 'x64',
        total_memory_mb: 16384, free_memory_mb: 6210, cpu_model: 'Intel Core i7-1265U',
        uptime_seconds: 53200, owner: 'Finance Dept'
      },
      {
        name: 'ELLORA-ENG-MAC-02', platform: 'macos', status: 'online', compliance: 'compliant',
        serial_number: 'SN-MAC-2002', os_version: 'macOS 14.5 Sonoma', arch: 'arm64',
        total_memory_mb: 16384, free_memory_mb: 4096, cpu_model: 'Apple M2',
        uptime_seconds: 187400, owner: 'Engineering'
      },
      {
        name: 'ELLORA-SITE-WIN-03', platform: 'windows', status: 'offline', compliance: 'non_compliant',
        serial_number: 'SN-WIN-1003', os_version: 'Windows 10 Pro 22H2', arch: 'x64',
        total_memory_mb: 8192, free_memory_mb: 1024, cpu_model: 'Intel Core i5-8250U',
        uptime_seconds: 0, owner: 'Site Office - Pune'
      },
      {
        name: 'ELLORA-SALES-AND-04', platform: 'android', status: 'pending', compliance: 'unknown',
        serial_number: 'SN-AND-3004', os_version: 'Android 14', arch: 'arm64',
        total_memory_mb: 6144, free_memory_mb: 2048, cpu_model: 'Snapdragon 7 Gen 1',
        uptime_seconds: 0, owner: 'Sales'
      }
    ];

    const insertDevice = db.prepare(`
      INSERT INTO devices (device_uuid, name, platform, status, compliance, api_token, serial_number,
        os_version, arch, total_memory_mb, free_memory_mb, cpu_model, uptime_seconds, owner,
        last_checkin, enrolled_at)
      VALUES (@device_uuid, @name, @platform, @status, @compliance, @api_token, @serial_number,
        @os_version, @arch, @total_memory_mb, @free_memory_mb, @cpu_model, @uptime_seconds, @owner,
        @last_checkin, @enrolled_at)
    `);
    const insertSoftware = db.prepare('INSERT INTO device_software (device_id, name, version) VALUES (?, ?, ?)');

    const deviceIds = [];
    for (const d of devices) {
      const info = insertDevice.run({
        device_uuid: uuidv4(),
        api_token: uuidv4(),
        last_checkin: d.status === 'pending' ? null : now,
        enrolled_at: d.status === 'pending' ? null : now,
        ...d
      });
      deviceIds.push(info.lastInsertRowid);
    }

    insertSoftware.run(deviceIds[0], 'Microsoft 365 Apps', '16.0.17726');
    insertSoftware.run(deviceIds[0], 'Google Chrome', '128.0.6613');
    insertSoftware.run(deviceIds[1], 'Xcode', '15.4');
    insertSoftware.run(deviceIds[1], 'Google Chrome', '128.0.6613');
    insertSoftware.run(deviceIds[2], 'Microsoft 365 Apps', '16.0.16924');

    const policyInsert = db.prepare(`
      INSERT INTO policies (name, platform, require_password, require_encryption, auto_lock_minutes)
      VALUES (?, ?, ?, ?, ?)
    `);
    const p1 = policyInsert.run('Standard Windows Security', 'windows', 1, 1, 5).lastInsertRowid;
    const p2 = policyInsert.run('macOS Baseline', 'macos', 1, 1, 10).lastInsertRowid;

    const assign = db.prepare('INSERT INTO device_policies (device_id, policy_id) VALUES (?, ?)');
    assign.run(deviceIds[0], p1);
    assign.run(deviceIds[2], p1);
    assign.run(deviceIds[1], p2);

    const alertInsert = db.prepare(`
      INSERT INTO alerts (device_id, type, severity, message) VALUES (?, ?, ?, ?)
    `);
    alertInsert.run(deviceIds[2], 'offline', 'critical', 'Device has been offline for more than 24 hours.');
    alertInsert.run(deviceIds[2], 'compliance', 'warning', 'Disk encryption is not enabled on this device.');
    alertInsert.run(deviceIds[3], 'enrollment', 'info', 'Device enrolled but pending first check-in.');

    console.log(`Seeded ${devices.length} demo devices, 2 policies, 3 alerts.`);
  } else {
    console.log('Devices already exist, skipping demo data seed.');
  }
}

seed();
