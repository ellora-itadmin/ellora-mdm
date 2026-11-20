# Ellora MDM

A self-hosted Mobile Device Management (MDM) web application built for
**Ellora EPC Pvt. Ltd.** Original codebase and UI design — conceptually
inspired by general MDM dashboard patterns (device inventory, policies,
remote actions, alerts) similar to commercial tools like Miradore, but no
code, assets, or exact layouts were copied.

## Structure

```
ellora-mdm/
  server/   Node.js + Express + better-sqlite3 REST API (JWT auth)
  web/      React + Vite + TypeScript admin dashboard
  agent/    Standalone Node.js check-in agent for Windows/macOS
```

## Quick start

### 1. Server

```
cd server
npm install
copy .env.example .env      # edit ADMIN_EMAIL / ADMIN_PASSWORD / JWT_SECRET
npm run seed                 # creates admin user + demo devices/policies/alerts
npm run dev                  # starts API on http://localhost:4000
```

### 2. Web dashboard

```
cd web
npm install
npm run dev                  # starts Vite dev server on http://localhost:5173
```

Open http://localhost:5173 and log in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD`
from `server/.env`. The dashboard dev server proxies `/api/*` to the Express
server on port 4000 (see `web/vite.config.ts`).

For a production build: `npm run build` (outputs static files to `web/dist`,
which can be served by any static file host or by adding `express.static` to
the server).

### 3. Agent (on a managed Windows/macOS machine)

```
cd agent
node agent.js --enroll http://YOUR_SERVER:4000 THE_ENROLLMENT_CODE
node agent.js
```

Get the enrollment code from **Devices → Add Device** in the dashboard. See
`agent/README.md` for full details, including the dry-run safety flag
(`--allow-actions`).

## Environment variables (`server/.env`)

| Variable         | Description                                      |
|------------------|---------------------------------------------------|
| `PORT`           | API port (default 4000)                          |
| `JWT_SECRET`     | Secret used to sign admin login JWTs — change it  |
| `ADMIN_EMAIL`    | Seeded admin login email                          |
| `ADMIN_PASSWORD` | Seeded admin login password (hashed with bcrypt)  |
| `DB_PATH`        | Path to the SQLite database file                  |

## What's real vs. what's a stub

**Real and functional:**
- Express REST API backed by a genuine SQLite database (`better-sqlite3`),
  persisted to disk — restart the server and your data is still there.
- JWT-based admin authentication with bcrypt-hashed passwords.
- Full device/policy/alert/command CRUD, wired end-to-end from the React UI
  to the API to the database.
- The **Windows/macOS agent** (`agent/agent.js`) genuinely collects live
  system inventory via Node's `os` module (hostname, OS version, arch,
  memory, CPU model, uptime) and POSTs it to the server every ~60 seconds.
  It also genuinely polls for and reports the status of queued remote
  commands.
- Remote "lock" and "restart" commands, when run with `--allow-actions`,
  execute real OS shell commands (`rundll32.exe user32.dll,LockWorkStation` /
  `shutdown /r /t 0` on Windows, `pmset displaysleepnow` / `sudo shutdown -r
  now` on macOS). By default the agent runs in **dry-run mode** and only logs
  what it would execute, so nothing destructive happens by accident.
- A background sweep job on the server marks devices offline after a missed
  check-in window and raises a real alert once a device has been offline
  for more than 24 hours.

**Stubs / not implemented:**
- **Remote wipe** is never actually executed by the agent, even in
  `--allow-actions` mode. A genuine remote wipe requires OS-level MDM
  integration (e.g., BitLocker recovery-key rotation and a wipe trigger on
  Windows, or a macOS MDM "EraseDevice" command signed by an APNs push
  channel) that is out of scope for this lightweight v1 agent. The command
  is accepted, logged, and flagged in the UI for manual IT follow-up.
- `run_script` and `install_software` remote commands exist in the data
  model and UI (you can queue them) but the agent currently acknowledges
  them as no-ops rather than executing arbitrary scripts or installers —
  intentionally, since running arbitrary remote scripts needs a proper
  signing/verification story before it's safe to wire up for real.
- **Android is not actually manageable.** The database schema and UI support
  an `android` platform value (you can create an Android "device" record,
  assign it a policy, see it in the dashboard), but there is no real Android
  enrollment or control path. Genuine Android device management requires
  registering as a Google **Android Enterprise EMM (Enterprise Mobility
  Management) provider** — an external process with Google that involves
  API access approval, a managed Google Play / Android Management API
  integration, and device owner/profile owner provisioning via QR code or
  zero-touch enrollment. None of that external registration or the
  corresponding Android Management API calls are implemented here; it's
  purely a data-model placeholder so the concept is visible in the UI.
- Multi-user/role-based access is not implemented — there is a single seeded
  admin user per server instance.

## Verification notes

Node.js/npm were not available in the environment this project was built in,
so `npm install` and a full `vite build` could not be executed here to
confirm a clean install. All source files were hand-reviewed for syntax
correctness. Before relying on this, run:

```
cd server && npm install && npm run seed && npm run dev
cd web && npm install && npm run build && npm run dev
```

and fix any dependency-resolution issues that surface (none are expected —
the `package.json` files pin recent, standard versions of Express,
better-sqlite3, React, Vite, and TypeScript).
