# System Pulse — Cloud Server Implementation Plan

## For: Claude instance working on cloudnimbusllc.com infrastructure

## Context

System Pulse is an Electron desktop app (Windows/macOS/Linux) that monitors system health — CPU, memory, processes, network. It has a built-in HTTP client/server for remote monitoring between machines on a LAN.

**Current state**: Machines talk directly to each other over LAN (HTTP, port 9475). The client pushes snapshots every 15 seconds. The server can queue kill commands and arbitrary shell commands for clients to execute.

**Goal**: Replace the LAN server with a cloud-hosted server at `pulse.cloudnimbusllc.com` (or similar) so:
1. Customers install System Pulse → it auto-connects to Cloud Nimbus
2. Cloud Nimbus team can see all connected machines in a web dashboard
3. Team can diagnose issues, kill runaway processes, run commands remotely (with customer consent)
4. Customers can see their own machines from anywhere (not just LAN)

---

## Architecture

```
┌─────────────────┐         HTTPS/WSS          ┌──────────────────────┐
│  System Pulse   │  ───────────────────────▶   │  pulse.cloudnimbus   │
│  (Electron app) │  snapshots every 15s        │  llc.com             │
│  on customer PC │  ◀─────────────────────     │                      │
│                 │  kill/exec commands          │  Node.js server      │
└─────────────────┘                             │  + PostgreSQL/SQLite │
                                                │  + Web dashboard     │
                                                └──────┬───────────────┘
                                                       │
                                                       │ HTTPS
                                                       ▼
                                                ┌──────────────────┐
                                                │  Admin Dashboard  │
                                                │  (React or plain) │
                                                │  cloudnimbusllc   │
                                                │  .com/dashboard   │
                                                └──────────────────┘
```

---

## Server Components Needed

### 1. API Server (Node.js + Express or Fastify)

**Endpoints (mirror what the Electron app already speaks):**

```
POST /snapshot          — Client pushes system health snapshot
GET  /pending-kills     — Client polls for kill commands (header: x-hostname)
GET  /pending-commands  — Client polls for exec commands (header: x-hostname)
POST /command-result    — Client posts command output back
POST /remote-exec       — Dashboard queues a command for a client
POST /remote-kill/:host — Dashboard queues a kill for a client
GET  /clients           — Dashboard lists all connected clients
GET  /command-result/:id — Dashboard polls for command result
GET  /ping              — Health check
```

**Auth model:**
- Each customer gets an **API key** (UUID) generated on signup or first install
- Client sends `Authorization: Bearer <api-key>` header on every request
- API key maps to an `organization` — one org can have many machines
- Admin dashboard uses separate JWT auth for Cloud Nimbus staff
- Customer dashboard uses the same API key or a separate customer login

**The Electron app already implements the client side of all these endpoints.** The only change needed in the Electron app is:
1. Change `DEFAULT_SERVER` from `192.168.1.172:9475` to `pulse.cloudnimbusllc.com`
2. Use HTTPS instead of HTTP
3. Add an API key field to the settings (stored in electron-store)
4. Send `Authorization` header on all requests

### 2. Database (PostgreSQL recommended, SQLite for MVP)

**Tables:**

```sql
-- Organizations (customers)
CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  api_key     UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  plan        TEXT DEFAULT 'free'  -- free, pro, enterprise
);

-- Machines registered under an org
CREATE TABLE machines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id),
  hostname    TEXT NOT NULL,
  last_seen   TIMESTAMPTZ,
  os_platform TEXT,  -- win32, darwin, linux
  cpu_model   TEXT,
  total_mem_mb INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Snapshots (recent only — keep 24-48h, archive or delete older)
CREATE TABLE snapshots (
  id          BIGSERIAL PRIMARY KEY,
  machine_id  UUID REFERENCES machines(id),
  ts          TIMESTAMPTZ NOT NULL,
  cpu         INTEGER,
  mem_pct     INTEGER,
  mem_used_mb INTEGER,
  top_cpu     JSONB,     -- array of {name, pid, cpu, memMb}
  top_mem     JSONB,
  duplicates  JSONB,
  events      JSONB,
  net_up      REAL,
  net_down    REAL
);

-- Pending commands (queue)
CREATE TABLE pending_commands (
  id          TEXT PRIMARY KEY,  -- cmd_<timestamp>
  machine_id  UUID REFERENCES machines(id),
  command     TEXT NOT NULL,
  type        TEXT DEFAULT 'exec',  -- 'exec' or 'kill'
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  picked_up   BOOLEAN DEFAULT FALSE
);

-- Command results
CREATE TABLE command_results (
  cmd_id      TEXT PRIMARY KEY REFERENCES pending_commands(id),
  stdout      TEXT,
  stderr      TEXT,
  exit_code   INTEGER,
  completed_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3. Web Dashboard

**Admin view (Cloud Nimbus staff):**
- List all organizations and their machines
- Click a machine → see live CPU/mem graph, process list, events
- "Run Command" input → queues via `/remote-exec`
- "Kill Process" button on each process row
- Alert feed — machines with high CPU/mem flagged automatically
- Historical graphs per machine (query snapshots table)

**Customer view (self-service):**
- Customer logs in → sees only their machines
- Same live view: CPU, memory, processes
- Can kill their own processes remotely
- Can't run arbitrary commands (safety)
- Alert settings: email/SMS when CPU > threshold for > N minutes

### 4. WebSocket Upgrade (Phase 2)

The current polling model (client hits server every 15s) works fine up to ~500 machines. For scale:
- Upgrade to WebSocket connections
- Client connects once, pushes snapshots over WS
- Server pushes kill/exec commands instantly over WS (no polling delay)
- Fallback to HTTP polling if WS connection drops

---

## Electron App Changes

In `C:\Projects\system-pulse\main.js`, the `pushSnapshotToServer()` function already does everything. Changes needed:

```javascript
// 1. Change DEFAULT_SERVER
const DEFAULT_SERVER = 'pulse.cloudnimbusllc.com';

// 2. Add API key to store defaults
const store = new Store({
  defaults: {
    // ... existing ...
    remote: {
      serverEnabled: true,   // local server still available for LAN use
      serverPort: 9475,
      clientEnabled: true,
      serverAddress: 'pulse.cloudnimbusllc.com',  // cloud by default
      machineName: os.hostname(),
      apiKey: '',  // generated on first connection or entered by user
    },
  },
});

// 3. In pushSnapshotToServer(), use https and add auth header:
const https = require('https');
// ... change http.request to https.request
// ... add header: 'Authorization': 'Bearer ' + store.get('remote.apiKey')

// 4. Add auto-registration: if no API key, POST to /register
//    Server returns a new API key, store it
```

In the UI (`index.html`), add an API key field to the Remote tab:
```html
<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
  <span>API Key:</span>
  <input type="text" id="remoteApiKey" placeholder="Auto-generated on first connect">
</div>
```

---

## Hosting & Infrastructure

**MVP (cheapest, fastest to deploy):**
- Single VPS: DigitalOcean $6/mo or Railway free tier
- Node.js server + SQLite file database
- Nginx reverse proxy with Let's Encrypt SSL
- Domain: `pulse.cloudnimbusllc.com` (CNAME to VPS IP)

**Production:**
- Railway or Render for auto-deploy from GitHub
- PostgreSQL (Supabase free tier or Railway addon)
- CloudFlare for DDoS protection + SSL
- Uptime monitoring (UptimeRobot free)

**Scaling (if it takes off):**
- Move to managed Kubernetes or AWS ECS
- Redis for command queue (instead of in-memory)
- TimescaleDB for time-series snapshot data
- S3 for archived logs

---

## Security Considerations

1. **API keys** — rotate-able, revoke-able from admin dashboard
2. **Command execution** — admin-only, logged, with audit trail. Consider allowlisting safe commands (tasklist, systeminfo, netstat) vs full shell access
3. **Rate limiting** — max 10 snapshots/minute per client, max 5 commands/minute per admin
4. **Data privacy** — snapshots contain process names which could reveal what software customers run. Privacy policy needed. Option to redact process names
5. **TLS everywhere** — never send snapshots or commands over plain HTTP to cloud
6. **Customer consent** — remote exec requires explicit opt-in toggle in the Electron app. Default OFF for cloud connections (ON only for LAN/trusted servers)

---

## Implementation Order

1. **Server MVP** — Express app with the 8 endpoints above, SQLite, deployed to Railway
2. **DNS** — Point `pulse.cloudnimbusllc.com` to the server
3. **Electron update** — Switch DEFAULT_SERVER, add HTTPS, add API key
4. **Admin dashboard** — Simple HTML page (same style as System Pulse) showing connected machines
5. **Customer portal** — Login page, machine list, alerts
6. **WebSocket upgrade** — Replace polling with persistent connections
7. **Billing** — Stripe integration for pro/enterprise tiers

---

## Repo Structure Suggestion

```
cloud-nimbus-pulse-server/
├── package.json
├── server.js            — Express app, all endpoints
├── db.js                — SQLite/Postgres connection + queries
├── auth.js              — API key + JWT middleware
├── dashboard/
│   ├── index.html       — Admin dashboard (single page)
│   ├── customer.html    — Customer self-service view
│   └── login.html
├── migrations/
│   └── 001_init.sql
└── README.md
```

---

## Existing Protocol Reference

The Electron app (`system-pulse/main.js`) already implements these exact request formats. The cloud server just needs to accept and respond to them identically. Here's what the client sends:

**Snapshot push (every 15s):**
```json
POST /snapshot
{
  "hostname": "GlenRogStrix7K",
  "ts": "2026-03-12T23:07:43.285Z",
  "cpu": 4,
  "memUsedMb": 13660,
  "memTotalMb": 64730,
  "memPct": 21,
  "topCpu": [{"name":"dwm.exe","pid":2548,"cpu":1}, ...],
  "topMem": [{"name":"dwm.exe","pid":2548,"memMb":150}, ...],
  "duplicates": [],
  "events": [{"type":"high-cpu","value":82}],
  "uptime": 3077
}
```

**Command poll (every 15s, piggybacks on snapshot push):**
```
GET /pending-commands
Header: x-hostname: GlenRogStrix7K
Response: [{"id":"cmd_1710288000000","command":"tasklist","ts":1710288000000}]
```

**Command result post:**
```json
POST /command-result
{
  "hostname": "GlenRogStrix7K",
  "cmdId": "cmd_1710288000000",
  "stdout": "...",
  "stderr": "",
  "exitCode": 0
}
```

The cloud server is essentially a hosted version of what's already in `startRemoteServer()` in main.js (lines 769-934), but with auth, persistence, and a web dashboard on top.
