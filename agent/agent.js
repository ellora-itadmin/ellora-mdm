#!/usr/bin/env node
/**
 * Ellora MDM Agent
 * Cross-platform (Windows/macOS) check-in agent. No external dependencies —
 * uses Node's built-in `os`, `fs`, `child_process`, and global `fetch` (Node 18+).
 *
 * Usage:
 *   node agent.js --enroll <enrollment-code> [server-url]    Enroll this machine.
 *                                                              server-url defaults to
 *                                                              DEFAULT_SERVER_URL below
 *                                                              (the live Cloudflare Worker API)
 *                                                              if omitted.
 *   node agent.js                                            Start check-in loop
 *   node agent.js --allow-actions                            Start loop and ACTUALLY execute
 *                                                              destructive commands (restart/wipe).
 *                                                              Without this flag, actions are
 *                                                              logged only (dry-run) for safety.
 *
 * Config is stored in ./agent-config.json next to this script.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'agent-config.json');
const CHECKIN_INTERVAL_MS = 60 * 1000;

// Live Ellora MDM API on Cloudflare Workers. Override by passing an explicit
// server-url as the second argument to --enroll.
const DEFAULT_SERVER_URL = 'https://ellora-mdm-api.it-admin-cf1.workers.dev';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function detectPlatform() {
  const p = os.platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return p;
}

async function enroll(serverUrl, enrollmentCode) {
  const url = serverUrl.replace(/\/$/, '') + '/api/agent/enroll';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enrollment_code: enrollmentCode,
      hostname: os.hostname(),
      platform: detectPlatform()
    })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Enrollment failed:', data.error || res.statusText);
    process.exit(1);
  }
  saveConfig({
    server_url: serverUrl.replace(/\/$/, ''),
    api_token: data.api_token,
    device_id: data.device_id,
    device_uuid: data.device_uuid
  });
  console.log(`Enrolled successfully. Config written to ${CONFIG_PATH}`);
  console.log('Run "node agent.js" to start checking in.');
}

function collectInventory() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: detectPlatform(),
    os_version: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    free_memory_mb: Math.round(os.freemem() / (1024 * 1024)),
    cpu_model: cpus.length ? cpus[0].model : 'unknown',
    cpu_count: cpus.length,
    uptime_seconds: Math.round(os.uptime())
  };
}

async function checkin(config) {
  const url = `${config.server_url}/api/agent/checkin`;
  const inventory = collectInventory();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_token}`
    },
    body: JSON.stringify({ inventory })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Check-in failed: ${data.error || res.statusText}`);
  }
  return res.json();
}

async function reportCommandResult(config, commandId, status, result) {
  const url = `${config.server_url}/api/agent/command-result`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_token}`
    },
    body: JSON.stringify({ command_id: commandId, status, result })
  });
}

function platformCommandFor(type) {
  const platform = detectPlatform();
  if (type === 'restart') {
    return platform === 'windows' ? 'shutdown /r /t 0' : 'sudo shutdown -r now';
  }
  if (type === 'lock') {
    return platform === 'windows'
      ? 'rundll32.exe user32.dll,LockWorkStation'
      : 'pmset displaysleepnow';
  }
  if (type === 'wipe') {
    // Intentionally not a real destructive command even in --allow-actions mode:
    // a genuine remote wipe requires OS-level MDM APIs (BitLocker/FileVault key
    // rotation + factory reset triggers) that this lightweight agent does not
    // implement. We log the intent and mark it for manual IT follow-up.
    return null;
  }
  return null;
}

async function handleCommand(config, command, allowActions) {
  const { id, type, payload } = command;
  console.log(`\n[COMMAND] Received "${type}" (id=${id})`);

  const shellCmd = platformCommandFor(type);

  if (type === 'wipe') {
    console.log('[COMMAND] Remote wipe requested. This agent does not perform destructive');
    console.log('[COMMAND] wipes automatically — flagging for manual IT action.');
    await reportCommandResult(config, id, 'success', {
      note: 'Wipe acknowledged by agent. Manual/OS-level wipe action required — not auto-executed.'
    });
    return;
  }

  if (type === 'run_script' || type === 'install_software') {
    console.log(`[COMMAND] "${type}" is not implemented by this lightweight agent (no-op).`);
    await reportCommandResult(config, id, 'success', { note: `${type} acknowledged; not executed (unsupported by v1 agent).`, payload });
    return;
  }

  if (!shellCmd) {
    await reportCommandResult(config, id, 'failed', { note: 'Unsupported command type' });
    return;
  }

  if (!allowActions) {
    console.log(`[DRY-RUN] Would execute: ${shellCmd}`);
    console.log('[DRY-RUN] Re-run with --allow-actions to actually execute this command.');
    await reportCommandResult(config, id, 'success', { note: `Dry-run only. Would have executed: ${shellCmd}` });
    return;
  }

  try {
    console.log(`[EXEC] Running: ${shellCmd}`);
    const output = execSync(shellCmd, { timeout: 10000 }).toString();
    await reportCommandResult(config, id, 'success', { output });
  } catch (err) {
    console.error(`[EXEC] Failed: ${err.message}`);
    await reportCommandResult(config, id, 'failed', { error: err.message });
  }
}

async function runLoop(allowActions) {
  const config = loadConfig();
  if (!config) {
    console.error('No agent-config.json found. Enroll first:');
    console.error('  node agent.js --enroll <server-url> <enrollment-code>');
    process.exit(1);
  }

  console.log(`Ellora MDM Agent starting. Server: ${config.server_url}`);
  console.log(`Action mode: ${allowActions ? 'LIVE (commands will execute)' : 'DRY-RUN (commands are logged only)'}`);

  async function tick() {
    try {
      const result = await checkin(config);
      console.log(`[${new Date().toISOString()}] Check-in ok. ${result.commands.length} pending command(s).`);
      for (const command of result.commands) {
        await handleCommand(config, command, allowActions);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Check-in error: ${err.message}`);
    }
  }

  await tick();
  setInterval(tick, CHECKIN_INTERVAL_MS);
}

// --- CLI entry ---
const args = process.argv.slice(2);
if (args[0] === '--enroll') {
  const [, a, b] = args;
  if (!a) {
    console.error('Usage: node agent.js --enroll <enrollment-code> [server-url]');
    console.error(`  (server-url defaults to ${DEFAULT_SERVER_URL} if omitted)`);
    process.exit(1);
  }
  // Backward-compatible: if `a` looks like a URL, treat it as server-url and `b` as the code.
  const isUrl = /^https?:\/\//i.test(a);
  const serverUrl = isUrl ? a : (b || DEFAULT_SERVER_URL);
  const enrollmentCode = isUrl ? b : a;
  if (!enrollmentCode) {
    console.error('Usage: node agent.js --enroll <enrollment-code> [server-url]');
    process.exit(1);
  }
  enroll(serverUrl, enrollmentCode);
} else {
  const allowActions = args.includes('--allow-actions');
  runLoop(allowActions);
}
