# Ellora MDM — User & Administrator Manual

A device management system for Ellora EPC Pvt. Ltd., built to track and manage company laptops (Windows, macOS) and mobile devices (Android — inventory only, see limitations below).

- **Dashboard (web app):** https://ellora-mdm-web.it-admin-cf1.workers.dev
- **API (backend):** https://ellora-mdm-api.it-admin-cf1.workers.dev
- **Default login:** `admin@elloraepc.com` / `ChangeMe123!` — **change this immediately** (see Section 6).

---

## 1. How the system works (architecture in plain terms)

There are three moving parts:

1. **The API** — runs on Cloudflare Workers, stores all data in a Cloudflare D1 database (a cloud SQL database). This is the single source of truth: every device, policy, command, and alert lives here.
2. **The Dashboard** — a website (also hosted on Cloudflare) that IT staff log into to view devices, send commands, and manage policies. It only talks to the API — it holds no data itself.
3. **The Agent** — a small program (`agent.js`) that runs on each company laptop. It checks in with the API roughly once a minute, reports real hardware/software info, and asks "is there anything you want me to do?" If IT queued a command (like Lock), the agent picks it up on its next check-in and carries it out (or, by default, logs what it *would* do without doing it — a safety feature, see Section 5).

```
 [Laptop running agent.js] --checks in every 60s--> [API on Cloudflare Workers] <--HTTPS-- [Dashboard website]
                                                              |
                                                     [D1 database: devices,
                                                      policies, commands, alerts]
```

Nothing runs on any particular office machine — the API and dashboard are cloud-hosted and reachable from anywhere with internet access. Only the agent needs to be installed on each managed laptop.

---

## 2. Logging into the dashboard

1. Open https://ellora-mdm-web.it-admin-cf1.workers.dev in any browser.
2. Enter the admin email and password.
3. You'll land on the **Dashboard** page — an overview of all devices, their online/offline status, compliance, and open alerts.

The sidebar has four sections:
- **Dashboard** — summary stats and recent alerts
- **Devices** — the full device list, searchable/filterable, click into any device for detail
- **Policies** — security policy definitions (password requirements, encryption, auto-lock) you can assign to devices
- **Alerts** — a feed of things needing attention (device offline >24h, non-compliant device, etc.)

---

## 3. Enrolling a new laptop (step by step)

This is the process to bring a new company laptop under management.

### Step A — Register the device in the dashboard
1. Go to **Devices** → click **+ Add Device**.
2. Enter a name (e.g. `ELLORA-HR-01`), pick the platform (Windows/macOS/Android), and an owner (e.g. the employee's name or department).
3. Click **Add**. The device appears with status **Pending** and Ellora MDM generates a one-time **enrollment code** (an 8-character code like `E0B1A4DE`).

   *(You can also register a device via the API directly if scripting bulk enrollment — see Section 7.)*

### Step B — Install the agent on the laptop
1. Copy the `agent` folder (from this project) onto the target laptop — or have IT distribute it via a shared drive/USB. It requires **Node.js** to be installed on that machine (free, from [nodejs.org](https://nodejs.org), LTS version).
2. Open a terminal in that folder and run:

   ```bash
   node agent.js --enroll <ENROLLMENT_CODE>
   ```

   Example:
   ```bash
   node agent.js --enroll E0B1A4DE
   ```

   You do **not** need to specify a server URL — the agent is pre-configured to talk to the live Ellora MDM API (`https://ellora-mdm-api.it-admin-cf1.workers.dev`) by default.

3. You should see:
   ```
   Enrolled successfully. Config written to agent-config.json
   Run "node agent.js" to start checking in.
   ```

### Step C — Start the agent
Run:
```bash
node agent.js
```
This starts the check-in loop (every 60 seconds). Leave this running — see Section 4 for making it start automatically and stay running.

Back in the dashboard, the device's status will flip from **Pending** to **Online** within a minute, and its hardware page will populate with real data (CPU, RAM, OS version, uptime).

---

## 4. Keeping the agent running permanently

Running `node agent.js` in a terminal window only works while that window is open. For real deployment, the agent should run as a background service that starts on boot.

**Windows** — use Task Scheduler:
1. Open Task Scheduler → Create Task
2. Trigger: "At startup" (or "At log on")
3. Action: Start a program → `node.exe`, with argument `agent.js` and "Start in" set to the agent folder path
4. Check "Run whether user is logged on or not" if you want it to run before login

**macOS** — use a `launchd` agent (a `.plist` file in `~/Library/LaunchAgents/`) pointing at `node agent.js` in the same way, set to `RunAtLoad: true` and `KeepAlive: true`.

*(This manual step wasn't automated in v1 — ask IT to set this up per-machine, or request an installer script as a future enhancement.)*

---

## 5. Sending remote commands (Lock / Restart / Wipe)

From a device's detail page in the dashboard, three buttons are available:

| Button | What it does |
|---|---|
| **Lock** | Locks the screen remotely |
| **Restart** | Restarts the machine |
| **Wipe** | Flags the device for a manual wipe — see note below |

**Important safety behavior:** by default, the agent runs in **dry-run mode**. When it receives a Lock or Restart command, it does **not** execute it — it logs exactly what it *would* run (e.g. `rundll32.exe user32.dll,LockWorkStation`) and reports "success" with that note back to the dashboard. This is intentional: it lets you test the whole command pipeline safely before enabling real device control.

To let the agent actually execute Lock/Restart commands, start it with:
```bash
node agent.js --allow-actions
```
Only do this on machines where you're prepared for the action to really happen.

**Wipe** is never auto-executed by the agent, even with `--allow-actions` — a real remote wipe needs OS-level integration (BitLocker key rotation on Windows, FileVault on Mac, or a factory-reset trigger) that this v1 agent doesn't implement. A Wipe command is acknowledged and logged for **manual IT follow-up**.

Command results (success/failure, what ran) appear in the device's **Command History** table.

---

## 6. Changing the admin password

The seeded default password (`ChangeMe123!`) is public-facing since the dashboard is on the open internet — change it now.

The easiest way currently is directly against the database:
```bash
cd worker
node -e "console.log(require('bcryptjs').hashSync('YOUR-NEW-PASSWORD', 10))"
```
Copy the printed hash, then run:
```bash
npx wrangler d1 execute ellora-mdm-db --remote --command="UPDATE users SET password_hash='<PASTE_HASH_HERE>' WHERE email='admin@elloraepc.com'"
```
*(A proper "change password" screen in the dashboard is a good next enhancement — ask if you'd like it added.)*

---

## 7. Managing devices via the API directly (advanced / scripting)

Every dashboard action is just calling the API — useful for bulk operations. All endpoints require the `Authorization: Bearer <token>` header, obtained by logging in:

```bash
curl -X POST https://ellora-mdm-api.it-admin-cf1.workers.dev/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@elloraepc.com","password":"YOUR-PASSWORD"}'
```

Key endpoints:
| Method & Path | Purpose |
|---|---|
| `GET /api/devices` | List devices (supports `?platform=`, `?status=`, `?compliance=`, `?q=` filters) |
| `GET /api/devices/:id` | Full device detail (hardware, software, policies, command history) |
| `POST /api/devices` | Register a new device, returns an enrollment code |
| `DELETE /api/devices/:id` | Remove a device |
| `POST /api/devices/:id/commands` | Queue a command (`{"type":"lock"}`, `"restart"`, `"wipe"`, etc.) |
| `GET /api/devices/stats/overview` | Dashboard summary stats |
| `GET/POST /api/policies` | List/create security policies |
| `GET /api/alerts` | List alerts |

---

## 8. Current limitations — what's real vs. what's not yet

Being transparent about scope, since this is a v1 build:

- ✅ **Windows & macOS**: real inventory reporting and command delivery, fully working via the agent.
- ⚠️ **Command execution**: Lock/Restart work for real once `--allow-actions` is enabled. Wipe is intentionally manual-only.
- ⚠️ **Software deployment / script execution**: acknowledged by the agent but not actually implemented yet (no-op).
- ❌ **Android**: the data model and dashboard UI support Android devices, but there's **no live enrollment or control**. Real Android management requires registering as a **Google Android Enterprise EMM** — a separate, formal registration process with Google that hasn't been started. Until then, Android devices can only be tracked manually (no automatic check-ins).
- ⚠️ **Agent persistence**: the agent doesn't yet install itself as a system service automatically — see Section 4 for manual setup.

---

## 9. Quick reference — common tasks

| I want to... | Do this |
|---|---|
| See all devices | Dashboard → Devices |
| Add a new laptop | Devices → + Add Device → get code → `node agent.js --enroll <code>` on that laptop |
| Lock a lost/stolen laptop | Device detail page → Lock (agent must be running with `--allow-actions`) |
| Check why a device is flagged | Devices → click device → see Compliance + Alerts |
| See what commands were sent to a device | Device detail page → Command History |
| Set a security policy (e.g. require encryption) | Policies → create/edit → assign to device(s) from the device detail page |
| Change the admin password | See Section 6 |
