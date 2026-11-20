# Ellora MDM Agent

A small, dependency-free Node.js script that runs on a managed Windows or macOS
machine, reports real hardware/OS inventory to the Ellora MDM server, and polls
for pending remote-management commands.

## Requirements

- Node.js 18+ (needs built-in `fetch`)

## 1. Enroll the device

In the web dashboard, go to **Devices → Add Device** to generate an enrollment
code, then run:

```
node agent.js --enroll http://YOUR_SERVER:4000 THE_ENROLLMENT_CODE
```

This writes `agent-config.json` next to `agent.js` containing the server URL
and a per-device API token issued by the server. Do not commit or share this
file — it authenticates this specific device.

## 2. Start checking in

```
node agent.js
```

The agent will:
- Collect real inventory every 60 seconds using Node's `os` module: hostname,
  platform, OS version, architecture, total/free memory, CPU model, and uptime.
- POST it to `/api/agent/checkin`.
- Receive any pending commands (lock, restart, wipe, run_script, install_software).

## 3. Safety: dry-run by default

By default the agent **does not execute** any destructive action. For `lock`
and `restart` it only logs the exact shell command it *would* run, e.g.:

```
[DRY-RUN] Would execute: shutdown /r /t 0
```

To actually execute lock/restart commands, start the agent with:

```
node agent.js --allow-actions
```

`wipe` is never auto-executed by this agent even with `--allow-actions` — a
real remote wipe requires OS-level MDM APIs (BitLocker key rotation, macOS
MDM erase profiles, etc.) that this lightweight script does not implement.
It is acknowledged and flagged for manual IT follow-up instead.

`run_script` and `install_software` commands are accepted and acknowledged
but are no-ops in this v1 agent (stub only).

## Running as a background/startup service

For real use, wrap `node agent.js --allow-actions` with your OS's service
manager (Windows Task Scheduler / NSSM, or macOS `launchd`) so it starts on
boot and restarts on failure. This is left to the deploying admin and is not
included here.
