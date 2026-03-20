/**
 * @name         System Pulse
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Electron main process — real-time system diagnostics and health monitoring.
 *               Cross-platform: Windows (wmic), macOS (ps), Linux (ps, /proc).
 * @author       Cloud Nimbus LLC
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const guard = require('./process-guard');

const platform = process.platform; // 'win32', 'darwin', 'linux'

const Store = require('electron-store');

const http = require('http');
const https = require('https');

const DEFAULT_SERVER = 'cloudnimbusllc.com';  // Cloud Nimbus hosted server
const LAN_PORT = 9475;

// ─── Connection Mode ────────────────────────────────────────────────────────
// Prefer LAN when available (free, fast), fall back to cloud (costs Redis ops).
const CLOUD_INTERVAL = 300000;  // 5 min when pushing to cloud (saves Redis quota)
const LAN_INTERVAL = 1000;      // 1s over LAN (free, local traffic only)
let connectionMode = 'cloud';   // 'lan' | 'cloud' | 'offline'
let lanPeerAddress = null;      // e.g. '192.168.1.172:9475' — dynamically discovered
let lanProbeTimer = null;

// Get all local IPv4 addresses for this machine
function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// Probe a single host:port to see if it's running System Pulse
function probeHost(host, port, cb) {
  const req = http.request({ hostname: host, port, path: '/ping', method: 'GET', timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        cb(data && data.status === 'ok' && data.hostname !== os.hostname());
      } catch (_) { cb(false); }
    });
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
  req.end();
}

// Discover LAN peers: check known peers from cloud + scan local subnet
function discoverLanPeers(cb) {
  const myIPs = getLocalIPs();
  const candidates = new Set();

  // Add any peers the cloud server told us about
  for (const [, client] of remoteClients) {
    if (client.lastSnapshot && client.lastSnapshot.lanIPs) {
      for (const ip of client.lastSnapshot.lanIPs) {
        if (!myIPs.includes(ip)) candidates.add(ip);
      }
    }
  }

  // Also scan peers we learned from cloud snapshots received via the server
  const knownPeerIPs = store.get('knownPeerIPs') || [];
  for (const ip of knownPeerIPs) {
    if (!myIPs.includes(ip)) candidates.add(ip);
  }

  // Subnet scan: for each of our IPs, try .1-.254 on port 9475
  // Only scan if we have no candidates yet (avoid flooding the network)
  if (candidates.size === 0) {
    for (const myIP of myIPs) {
      const parts = myIP.split('.');
      if (parts.length === 4) {
        const subnet = parts.slice(0, 3).join('.');
        // Quick scan: just check a handful of common addresses
        for (let i = 1; i <= 254; i++) {
          const ip = `${subnet}.${i}`;
          if (!myIPs.includes(ip)) candidates.add(ip);
        }
      }
    }
  }

  if (candidates.size === 0) return cb(null);

  // Probe in batches of 30 to avoid flooding the network
  const ips = [...candidates];
  let found = false;
  let idx = 0;
  const BATCH = 30;

  function probeBatch() {
    if (found || idx >= ips.length) {
      if (!found) cb(null);
      return;
    }
    const batch = ips.slice(idx, idx + BATCH);
    idx += BATCH;
    let pending = batch.length;
    for (const ip of batch) {
      probeHost(ip, LAN_PORT, (ok) => {
        if (ok && !found) {
          found = true;
          cb(`${ip}:${LAN_PORT}`);
        }
        pending--;
        if (pending === 0 && !found) probeBatch();
      });
    }
  }
  probeBatch();
}

function setConnectionMode(mode, peerAddr) {
  const changed = mode !== connectionMode || peerAddr !== lanPeerAddress;
  if (!changed) return;
  const prev = connectionMode;
  connectionMode = mode;
  lanPeerAddress = mode === 'lan' ? peerAddr : null;
  console.log(`[connection] ${prev} → ${mode}${peerAddr ? ` (peer: ${peerAddr})` : ''}`);
  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('connection-mode', { mode, prev, peer: peerAddr });
  }
  // Restart push loop with appropriate interval
  const remote = store.get('remote');
  if (remote.clientEnabled && clientPushInterval) {
    clearInterval(clientPushInterval);
    const target = mode === 'lan' ? peerAddr : remote.serverAddress;
    const interval = mode === 'lan' ? LAN_INTERVAL : CLOUD_INTERVAL;
    pushSnapshotToServer(target);
    clientPushInterval = setInterval(() => pushSnapshotToServer(target), interval);
  }
}

function startLanProbing() {
  if (lanProbeTimer) return;
  // Probe immediately, then every 30s
  const probe = () => {
    // If we already have a known peer, just re-check it
    if (lanPeerAddress) {
      const [host, port] = lanPeerAddress.split(':');
      probeHost(host, parseInt(port), (ok) => {
        if (ok) {
          setConnectionMode('lan', lanPeerAddress);
        } else {
          // Peer went away — fall back to cloud and rediscover
          lanPeerAddress = null;
          setConnectionMode('cloud', null);
        }
      });
    } else {
      // Full discovery
      discoverLanPeers((peerAddr) => {
        if (peerAddr) {
          // Remember this peer for faster reconnect
          const [peerIP] = peerAddr.split(':');
          const known = store.get('knownPeerIPs') || [];
          if (!known.includes(peerIP)) {
            store.set('knownPeerIPs', [...known, peerIP]);
          }
          setConnectionMode('lan', peerAddr);
        } else {
          setConnectionMode('cloud', null);
        }
      });
    }
  };
  probe();
  lanProbeTimer = setInterval(probe, 30000);
}

function stopLanProbing() {
  if (lanProbeTimer) { clearInterval(lanProbeTimer); lanProbeTimer = null; }
}

const store = new Store({
  defaults: {
    windowBounds: { width: 1100, height: 800 },
    autoStart: true,
    startMinimized: true,
    firstRun: true,
    remote: {
      serverEnabled: true,
      serverPort: 9475,
      clientEnabled: true,
      serverAddress: DEFAULT_SERVER,
      apiKey: '',  // assigned by cloud server or entered manually
      machineName: os.hostname(),
    },
  },
});

// Migrate existing installs to cloud server
const currentAddr = store.get('remote.serverAddress');
if (!currentAddr || currentAddr === '192.168.1.172:9475') {
  store.set('remote.serverEnabled', true);
  store.set('remote.clientEnabled', true);
  store.set('remote.serverAddress', DEFAULT_SERVER);
}
if (store.get('autoStart') === false && store.get('firstRun') === undefined) {
  store.set('autoStart', true);
  store.set('startMinimized', true);
  store.set('firstRun', true); // trigger auto-start registration
}

let mainWindow = null;
let tray = null;
let previousCpuTimes = null;
let previousProcessSnap = null; // For Windows CPU% delta calc
let lastNetStats = null;
let lastNetStatsTime = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function runCmd(cmd, timeout = 5000) {
  return guard.execPromise(cmd, timeout).catch(() => '');
}

// ─── CPU Usage (cross-platform via os.cpus()) ───────────────────────────────

function getCpuUsagePercent() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }

  if (previousCpuTimes) {
    const idleDiff = totalIdle - previousCpuTimes.idle;
    const totalDiff = totalTick - previousCpuTimes.total;
    previousCpuTimes = { idle: totalIdle, total: totalTick };
    if (totalDiff === 0) return 0;
    return Math.round((1 - idleDiff / totalDiff) * 100);
  }

  previousCpuTimes = { idle: totalIdle, total: totalTick };
  return 0; // First call, no delta yet
}

// ─── System Info ────────────────────────────────────────────────────────────

function getSystemInfo() {
  const cpuPercent = getCpuUsagePercent();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const uptime = os.uptime();
  const loadAvg = os.loadavg();
  const cpuModel = os.cpus()[0]?.model || 'Unknown';
  const cpuCores = os.cpus().length;

  return {
    cpuPercent,
    totalMem,
    freeMem,
    usedMem,
    uptime,
    loadAvg,
    cpuModel,
    cpuCores,
    platform,
    hostname: os.hostname(),
  };
}

// ─── Process List ───────────────────────────────────────────────────────────

async function getProcessList() {
  if (platform === 'win32') {
    return await getProcessListWindows();
  } else {
    return await getProcessListUnix();
  }
}

async function getProcessListWindows() {
  // Use tasklist (lightweight, no WMI) as the primary method.
  // wmic hammers WmiPrvSE and causes runaway CPU spirals under load.
  const raw = await runCmd('tasklist /fo csv /nh', 10000);
  if (!raw) return [];

  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const processes = [];

  for (const line of lines) {
    const cols = line.replace(/"/g, '').split(',');
    if (cols.length < 5) continue;
    const name = cols[0] || '';
    const pid = parseInt(cols[1], 10) || 0;
    const memKB = parseInt((cols[4] || '').replace(/[, K]/g, ''), 10) || 0;
    if (!name || pid === 0) continue;
    processes.push({ name, pid, cpu: 0, memMB: Math.round(memKB / 1024), status: 'Running' });
  }

  // tasklist doesn't give CPU — use a quick per-process CPU estimate via os.cpus() delta
  // This is imprecise but doesn't touch WMI at all
  const now = Date.now();
  if (previousProcessSnap && previousProcessSnap._timestamp) {
    // Compare total system CPU idle delta to estimate per-process contribution
    // We can't get per-process CPU without WMI, so we tag top-memory processes
    // and rely on the os-level CPU % for the overall number
  }
  previousProcessSnap = { _timestamp: now };

  // Sort by memory descending (best we can do without WMI), take top 20
  processes.sort((a, b) => b.memMB - a.memMB);
  return processes.slice(0, 20);
}

async function getProcessListUnix() {
  const cmd = platform === 'darwin'
    ? 'ps -Arco pid,pcpu,rss,state,comm | head -25'
    : 'ps aux --sort=-%cpu | head -25';

  const raw = await runCmd(cmd, 5000);
  if (!raw) return [];

  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const processes = [];

  if (platform === 'darwin') {
    // ps -Arco: PID %CPU RSS STAT COMM
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 5) continue;
      const pid = parseInt(parts[0], 10);
      const cpu = parseFloat(parts[1]) || 0;
      const rssKB = parseInt(parts[2], 10) || 0;
      const status = parts[3] || 'S';
      const name = parts.slice(4).join(' ');
      processes.push({
        name,
        pid,
        cpu: Math.round(cpu),
        memMB: Math.round(rssKB / 1024),
        status: status.startsWith('R') ? 'Running' : status.startsWith('S') ? 'Sleeping' : status.startsWith('Z') ? 'Zombie' : status,
      });
    }
  } else {
    // ps aux: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 11) continue;
      const pid = parseInt(parts[1], 10);
      const cpu = parseFloat(parts[2]) || 0;
      const rssKB = parseInt(parts[5], 10) || 0;
      const status = parts[7] || 'S';
      const name = parts.slice(10).join(' ').split('/').pop();
      processes.push({
        name,
        pid,
        cpu: Math.round(cpu),
        memMB: Math.round(rssKB / 1024),
        status: status.startsWith('R') ? 'Running' : status.startsWith('S') ? 'Sleeping' : status.startsWith('Z') ? 'Zombie' : status,
      });
    }
  }

  processes.sort((a, b) => b.cpu - a.cpu);
  return processes.slice(0, 20);
}

// ─── Kill Process ───────────────────────────────────────────────────────────

async function killProcess(pid) {
  // Sanitize PID — must be a positive integer
  const safePid = parseInt(pid, 10);
  if (isNaN(safePid) || safePid <= 0) {
    return { success: false, error: 'Invalid PID' };
  }

  // Don't allow killing PID 0, 1, or 4 (system-critical)
  if (safePid <= 4) {
    return { success: false, error: 'Cannot kill system-critical process' };
  }

  try {
    const cmd = platform === 'win32'
      ? `taskkill /F /PID ${safePid}`
      : `kill -9 ${safePid}`;
    await runCmd(cmd, 5000);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function killDuplicates(processName) {
  if (!processName || typeof processName !== 'string') {
    return { success: false, error: 'Invalid process name' };
  }

  const allProcesses = await getProcessList();
  const matches = allProcesses.filter(p => p.name === processName);

  if (matches.length <= 1) {
    return { success: true, killed: 0, message: 'No duplicates found' };
  }

  // Keep the one with lowest PID (oldest), kill the rest
  matches.sort((a, b) => a.pid - b.pid);
  let killed = 0;

  for (let i = 1; i < matches.length; i++) {
    const result = await killProcess(matches[i].pid);
    if (result.success) killed++;
  }

  return { success: true, killed, message: `Killed ${killed} duplicate(s) of ${processName}` };
}

// ─── Network Usage ──────────────────────────────────────────────────────────

async function getNetworkUsage() {
  try {
    if (platform === 'win32') {
      // Use netstat instead of wmic to avoid WMI/WmiPrvSE load
      const raw = await runCmd('netstat -e', 5000);
      if (!raw) return null;

      // netstat -e output:  Bytes   <received>   <sent>
      const bytesMatch = raw.match(/Bytes\s+(\d+)\s+(\d+)/);
      if (!bytesMatch) return null;

      const stats = [{
        Name: 'Total',
        ReceivedBytes: parseInt(bytesMatch[1], 10) || 0,
        SentBytes: parseInt(bytesMatch[2], 10) || 0,
      }];

      return computeNetDelta(stats);

    } else if (platform === 'darwin') {
      const raw = await runCmd('/usr/sbin/netstat -ib', 5000);
      const lines = raw.split('\n');
      const stats = [];
      for (const line of lines.slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;
        if (!parts[3] || !parts[3].startsWith('Link#')) continue;
        stats.push({
          Name: parts[0],
          SentBytes: parseInt(parts[9], 10) || 0,
          ReceivedBytes: parseInt(parts[6], 10) || 0,
        });
      }
      return computeNetDelta(stats);

    } else {
      // Linux: /proc/net/dev
      let raw = '';
      try { raw = fs.readFileSync('/proc/net/dev', 'utf8'); } catch { return null; }
      const lines = raw.split('\n');
      const stats = [];
      for (const line of lines.slice(2)) {
        const match = line.trim().match(/^(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
        if (!match) continue;
        if (match[1] === 'lo') continue;
        stats.push({
          Name: match[1],
          SentBytes: parseInt(match[3], 10),
          ReceivedBytes: parseInt(match[2], 10),
        });
      }
      return computeNetDelta(stats);
    }
  } catch {
    return null;
  }
}

function computeNetDelta(stats) {
  if (!stats || stats.length === 0) return null;
  const now = Date.now();

  if (lastNetStats && lastNetStatsTime) {
    const elapsed = (now - lastNetStatsTime) / 1000;
    let totalUpMbps = 0, totalDownMbps = 0;
    const adapters = stats.map((s) => {
      const prev = lastNetStats.find(p => p.Name === s.Name);
      if (!prev) return { name: s.Name, uploadMbps: 0, downloadMbps: 0 };
      const upBytes = Math.max(0, s.SentBytes - prev.SentBytes);
      const downBytes = Math.max(0, s.ReceivedBytes - prev.ReceivedBytes);
      const uploadMbps = parseFloat(((upBytes * 8 / 1000000) / elapsed).toFixed(2));
      const downloadMbps = parseFloat(((downBytes * 8 / 1000000) / elapsed).toFixed(2));
      totalUpMbps += uploadMbps;
      totalDownMbps += downloadMbps;
      return { name: s.Name, uploadMbps, downloadMbps };
    });
    lastNetStats = stats;
    lastNetStatsTime = now;
    return { adapters, totalUpMbps: totalUpMbps.toFixed(2), totalDownMbps: totalDownMbps.toFixed(2) };
  }

  lastNetStats = stats;
  lastNetStatsTime = now;
  return { adapters: stats.map(s => ({ name: s.Name, uploadMbps: 0, downloadMbps: 0 })), totalUpMbps: '0.00', totalDownMbps: '0.00' };
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

async function runDiagnostic() {
  const findings = [];
  const sysInfo = getSystemInfo();
  const processes = await getProcessList();

  // Check high CPU
  const highCpuProcs = processes.filter(p => p.cpu > 50);
  for (const p of highCpuProcs) {
    findings.push({
      severity: p.cpu > 80 ? 'critical' : 'warning',
      category: 'CPU',
      message: `${p.name} (PID ${p.pid}) is using ${p.cpu}% CPU`,
      suggestion: `Consider killing this process or investigating why it's consuming so much CPU`,
      pid: p.pid,
      processName: p.name,
    });
  }

  // Check memory usage > 90%
  const memPercent = Math.round((sysInfo.usedMem / sysInfo.totalMem) * 100);
  if (memPercent > 90) {
    findings.push({
      severity: 'critical',
      category: 'Memory',
      message: `System memory usage is at ${memPercent}%`,
      suggestion: 'Close unnecessary applications to free memory',
    });
  } else if (memPercent > 75) {
    findings.push({
      severity: 'warning',
      category: 'Memory',
      message: `System memory usage is at ${memPercent}%`,
      suggestion: 'Consider closing some applications',
    });
  }

  // Check for duplicate processes
  const nameCounts = {};
  for (const p of processes) {
    nameCounts[p.name] = (nameCounts[p.name] || 0) + 1;
  }
  for (const [name, count] of Object.entries(nameCounts)) {
    if (count >= 3) {
      // Ignore common system processes that legitimately have many instances
      const systemProcs = platform === 'darwin'
        ? ['kernel_task', 'launchd', 'mds_stores', 'Google Chrome Helper', 'com.apple.WebKit', 'Safari', 'firefox']
        : ['svchost.exe', 'RuntimeBroker.exe', 'conhost.exe', 'csrss.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe'];
      if (!systemProcs.includes(name)) {
        findings.push({
          severity: 'warning',
          category: 'Duplicates',
          message: `${count} instances of ${name} found`,
          suggestion: `Kill duplicates? Keep oldest instance.`,
          processName: name,
          canKillDuplicates: true,
        });
      }
    }
  }

  // Check for zombie processes (Unix only)
  if (platform !== 'win32') {
    const zombies = processes.filter(p => p.status === 'Zombie');
    for (const z of zombies) {
      findings.push({
        severity: 'warning',
        category: 'Zombie',
        message: `Zombie process: ${z.name} (PID ${z.pid})`,
        suggestion: 'This process is defunct and should be cleaned up',
        pid: z.pid,
        processName: z.name,
      });
    }
  }

  // Check top memory hogs
  const topMemProcs = [...processes].sort((a, b) => b.memMB - a.memMB).slice(0, 3);
  for (const p of topMemProcs) {
    if (p.memMB > 1024) { // >1GB
      findings.push({
        severity: 'warning',
        category: 'Memory',
        message: `${p.name} (PID ${p.pid}) is using ${p.memMB} MB of memory`,
        suggestion: 'This process is consuming significant memory',
        pid: p.pid,
        processName: p.name,
      });
    }
  }

  // Overall system health
  const overallCpu = sysInfo.cpuPercent;
  if (overallCpu > 90) {
    findings.push({
      severity: 'critical',
      category: 'CPU',
      message: `Overall CPU usage is at ${overallCpu}%`,
      suggestion: 'System is under heavy load — check top processes',
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'ok',
      category: 'System',
      message: 'System health looks good — no issues detected',
      suggestion: '',
    });
  }

  return findings;
}

// ─── System Health for Tray ─────────────────────────────────────────────────

function getHealthLevel() {
  const cpuPercent = getCpuUsagePercent();
  const memPercent = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);

  if (cpuPercent > 90 || memPercent > 95) return { level: 'critical', cpuPercent, memPercent };
  if (cpuPercent > 70 || memPercent > 85) return { level: 'warning', cpuPercent, memPercent };
  return { level: 'ok', cpuPercent, memPercent };
}

// ─── Tray Icon Generation ───────────────────────────────────────────────────

function createTrayIcon(color) {
  // Create a 16x16 icon using nativeImage
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  const colors = {
    green: [68, 204, 68],
    yellow: [245, 158, 11],
    red: [239, 68, 68],
  };

  const [r, g, b] = colors[color] || colors.green;

  // Draw a filled circle
  const cx = size / 2, cy = size / 2, radius = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const idx = (y * size + x) * 4;
      if (dist <= radius) {
        const alpha = dist > radius - 1 ? Math.round((radius - dist) * 255) : 255;
        canvas[idx] = r;
        canvas[idx + 1] = g;
        canvas[idx + 2] = b;
        canvas[idx + 3] = alpha;
      } else {
        canvas[idx] = 0;
        canvas[idx + 1] = 0;
        canvas[idx + 2] = 0;
        canvas[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

// ─── Window & Tray ──────────────────────────────────────────────────────────

function createWindow() {
  const bounds = store.get('windowBounds');
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0e0b1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'icon.png'),
    show: false,
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('resize', () => {
    const { width, height } = mainWindow.getBounds();
    store.set('windowBounds', { width, height });
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = createTrayIcon('green');
  tray = new Tray(icon);
  tray.setToolTip('System Pulse — CPU: ...');

  const launchClaudeCmd = platform === 'darwin'
    ? 'open -a Terminal --args bash -lc "claude"'
    : 'start "Claude Code" cmd /k "set CLAUDECODE= && claude"';

  const claudeProjectCmd = (dir, label) => {
    if (platform === 'darwin') {
      return `open -a Terminal --args bash -lc "cd '${dir}' && claude"`;
    }
    return `start "${label}" cmd /k "cd /d ${dir} && set CLAUDECODE= && claude"`;
  };

  const launchElectronApp = (appPath) => {
    if (platform === 'darwin') {
      return `cd "${appPath}" && npx electron . &`;
    }
    return `cd /d "${appPath}" && start "" npx electron .`;
  };

  const projectsRoot = platform === 'darwin' ? path.join(os.homedir(), 'Projects') : 'C:\\Projects';

  // Dynamically discover projects on this machine instead of hardcoding
  function buildProjectSubmenu() {
    const items = [
      { label: projectsRoot, click: () => { guard.exec(claudeProjectCmd(projectsRoot, 'Claude'), { shell: true }); }},
    ];
    try {
      const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(projectsRoot, entry.name);
        // Only show directories that look like projects (have package.json, .git, or any code files)
        const hasProject = fs.existsSync(path.join(fullPath, 'package.json')) ||
                           fs.existsSync(path.join(fullPath, '.git')) ||
                           fs.existsSync(path.join(fullPath, 'main.js'));
        if (hasProject) {
          items.push({
            label: entry.name,
            click: () => { guard.exec(claudeProjectCmd(fullPath, `Claude ${entry.name}`), { shell: true }); },
          });
        }
      }
    } catch (_) { /* projectsRoot doesn't exist yet — just show the root entry */ }
    return items;
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show System Pulse', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Launch Claude Code', click: () => {
      guard.exec(launchClaudeCmd, { shell: true, windowsHide: false });
    }},
    { label: 'Launch Claude Code (Projects)', submenu: buildProjectSubmenu() },
    { type: 'separator' },
    { label: 'Launch Resource Governor', click: () => {
      const rgPath = path.join(__dirname, '..', 'resource-governor');
      guard.exec(launchElectronApp(rgPath), { shell: true, windowsHide: true });
    }},
    { label: 'Launch Nimbus Toolbox', click: () => {
      const tbPath = path.join(__dirname, '..', 'nimbus-toolbox');
      guard.exec(launchElectronApp(tbPath), { shell: true, windowsHide: true });
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });

  // Update tray icon color periodically
  setInterval(() => {
    const health = getHealthLevel();
    const colorMap = { ok: 'green', warning: 'yellow', critical: 'red' };
    const newIcon = createTrayIcon(colorMap[health.level]);
    tray.setImage(newIcon);
    tray.setToolTip(`System Pulse — CPU: ${health.cpuPercent}% | Mem: ${health.memPercent}%`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('health-update', health);
    }
  }, 5000);
}

// ─── Background Logger ─────────────────────────────────────────────────────

const logDir = path.join(app.getPath('userData'), 'logs');
let logInterval = null;

function ensureLogDir() {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}

function getLogFilePath() {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(logDir, `pulse-${date}.jsonl`);
}

async function logSnapshot() {
  try {
    ensureLogDir();
    const sys = getSystemInfo();
    const procs = await getProcessList();
    const net = await getNetworkUsage();

    // Top 10 CPU hogs
    const topCpu = procs
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 10)
      .map(p => ({ name: p.name, pid: p.pid, cpu: p.cpu, memMb: p.memMb }));

    // Top 5 memory hogs
    const topMem = procs
      .sort((a, b) => b.memMb - a.memMb)
      .slice(0, 5)
      .map(p => ({ name: p.name, pid: p.pid, memMb: p.memMb }));

    // Duplicate process check
    const nameCounts = {};
    for (const p of procs) {
      nameCounts[p.name] = (nameCounts[p.name] || 0) + 1;
    }
    const duplicates = Object.entries(nameCounts)
      .filter(([name, count]) => count > 3 && !['svchost.exe', 'RuntimeBroker.exe', 'conhost.exe', 'csrss.exe', 'chrome.exe', 'msedge.exe', 'Code.exe', 'kernel_task', 'launchd', 'mds_stores', 'Google Chrome Helper', 'com.apple.WebKit'].includes(name))
      .map(([name, count]) => ({ name, count }));

    // Events/anomalies
    const events = [];
    if (sys.cpuPercent > 75) events.push({ type: 'high-cpu', value: sys.cpuPercent });
    if ((sys.usedMem / sys.totalMem) > 0.9) events.push({ type: 'high-memory', pct: Math.round((sys.usedMem / sys.totalMem) * 100) });
    if (duplicates.length > 0) events.push({ type: 'duplicates', items: duplicates });
    for (const p of topCpu) {
      if (p.cpu > 50) events.push({ type: 'cpu-hog', name: p.name, pid: p.pid, cpu: p.cpu });
    }

    const entry = {
      ts: new Date().toISOString(),
      cpu: sys.cpuPercent,
      memUsedMb: Math.round(sys.usedMem / 1048576),
      memTotalMb: Math.round(sys.totalMem / 1048576),
      memPct: Math.round((sys.usedMem / sys.totalMem) * 100),
      netUp: net?.uploadMbps || 0,
      netDown: net?.downloadMbps || 0,
      topCpu,
      topMem,
      duplicates,
      events,
    };

    fs.appendFileSync(getLogFilePath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    // Don't crash the app if logging fails
  }
}

function startLogging() {
  if (logInterval) return;
  // Log every 30 seconds
  logSnapshot(); // initial snapshot
  logInterval = setInterval(logSnapshot, 30000);
}

function stopLogging() {
  if (logInterval) {
    clearInterval(logInterval);
    logInterval = null;
  }
}

function getLogFiles() {
  ensureLogDir();
  try {
    return fs.readdirSync(logDir)
      .filter(f => f.startsWith('pulse-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch (e) { return []; }
}

function readLogFile(filename) {
  const filePath = path.join(logDir, filename);
  if (!fs.existsSync(filePath)) return [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

function getLogSummary(filename) {
  const entries = readLogFile(filename);
  if (entries.length === 0) return null;

  const cpuValues = entries.map(e => e.cpu);
  const memValues = entries.map(e => e.memPct);
  const allEvents = entries.flatMap(e => e.events || []);

  // Count event types
  const eventCounts = {};
  for (const ev of allEvents) {
    eventCounts[ev.type] = (eventCounts[ev.type] || 0) + 1;
  }

  // Find worst CPU hogs across the day
  const hogCounts = {};
  for (const entry of entries) {
    for (const p of (entry.topCpu || []).filter(p => p.cpu > 20)) {
      hogCounts[p.name] = (hogCounts[p.name] || 0) + 1;
    }
  }
  const frequentHogs = Object.entries(hogCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, appearances: count, pctOfSnapshots: Math.round((count / entries.length) * 100) }));

  return {
    date: filename.replace('pulse-', '').replace('.jsonl', ''),
    snapshots: entries.length,
    duration: entries.length > 1
      ? Math.round((new Date(entries[entries.length - 1].ts) - new Date(entries[0].ts)) / 60000)
      : 0,
    cpu: {
      avg: Math.round(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length),
      max: Math.max(...cpuValues),
      min: Math.min(...cpuValues),
    },
    memory: {
      avg: Math.round(memValues.reduce((a, b) => a + b, 0) / memValues.length),
      max: Math.max(...memValues),
    },
    eventCounts,
    frequentHogs,
    totalEvents: allEvents.length,
  };
}

// ─── Remote Monitoring ─────────────────────────────────────────────────────

let remoteServer = null;
const remoteClients = new Map(); // hostname -> { lastSnapshot, lastSeen }
let clientPushInterval = null;

function startRemoteServer(port) {
  if (remoteServer) return;
  remoteServer = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (req.method === 'POST' && req.url === '/snapshot') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const hostname = data.hostname || 'unknown';
          remoteClients.set(hostname, {
            lastSnapshot: data,
            lastSeen: Date.now(),
          });
          // Forward to renderer
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('remote-snapshot', { hostname, data });
          }
          // Check for alerts
          if (data.cpu > 75 || data.memPct > 90) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('remote-alert', {
                hostname,
                cpu: data.cpu,
                memPct: data.memPct,
                events: data.events || [],
              });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'bad json' }));
        }
      });
    } else if (req.method === 'POST' && req.url === '/kill') {
      // Remote kill command — client polls this
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    } else if (req.method === 'GET' && req.url === '/clients') {
      const clients = {};
      remoteClients.forEach((val, key) => {
        clients[key] = { ...val.lastSnapshot, lastSeen: val.lastSeen };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(clients));
    } else if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', hostname: os.hostname() }));
    } else if (req.method === 'POST' && req.url.startsWith('/remote-kill/')) {
      // Server sends kill command to be picked up by client
      const targetHost = decodeURIComponent(req.url.split('/remote-kill/')[1]);
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { pid, name } = JSON.parse(body);
          const client = remoteClients.get(targetHost);
          if (client) {
            if (!client.pendingKills) client.pendingKills = [];
            client.pendingKills.push({ pid: parseInt(pid), name, ts: Date.now() });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'queued' }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'bad request' }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/pending-kills') {
      // Client polls for kill commands
      const hostname = req.headers['x-hostname'] || '';
      const client = remoteClients.get(hostname);
      const kills = (client && client.pendingKills) || [];
      if (client) client.pendingKills = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(kills));
    } else if (req.method === 'POST' && req.url === '/remote-exec') {
      // Queue a command for a remote client to execute
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { hostname: target, command } = JSON.parse(body);
          const client = remoteClients.get(target);
          if (client) {
            if (!client.pendingCommands) client.pendingCommands = [];
            const cmdId = 'cmd_' + Date.now();
            client.pendingCommands.push({ id: cmdId, command, ts: Date.now() });
            if (!client.commandResults) client.commandResults = {};
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'queued', cmdId }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'client not connected' }));
          }
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'bad request' }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/pending-commands') {
      // Client polls for commands to execute
      const hostname = req.headers['x-hostname'] || '';
      const client = remoteClients.get(hostname);
      const cmds = (client && client.pendingCommands) || [];
      if (client) client.pendingCommands = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cmds));
    } else if (req.method === 'POST' && req.url === '/command-result') {
      // Client posts command output back
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 5242880) req.destroy(); });
      req.on('end', () => {
        try {
          const { hostname: h, cmdId, stdout, stderr, exitCode } = JSON.parse(body);
          const client = remoteClients.get(h);
          if (client) {
            if (!client.commandResults) client.commandResults = {};
            client.commandResults[cmdId] = { stdout, stderr, exitCode, ts: Date.now() };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'bad request' }));
        }
      });
    } else if (req.method === 'GET' && req.url.startsWith('/command-result/')) {
      // Server polls for a specific command result
      const parts = req.url.split('/');
      const cmdId = parts[2];
      let found = null;
      remoteClients.forEach((client) => {
        if (client.commandResults && client.commandResults[cmdId]) {
          found = client.commandResults[cmdId];
          delete client.commandResults[cmdId];
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(found || { pending: true }));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });

  remoteServer.listen(port, '0.0.0.0', () => {
    console.log(`System Pulse server listening on port ${port}`);
  });
  remoteServer.on('error', (e) => {
    console.error('Server error:', e.message);
    remoteServer = null;
  });
}

function stopRemoteServer() {
  if (remoteServer) {
    remoteServer.close();
    remoteServer = null;
  }
}

// Determine connection params: cloud (HTTPS + /api/pulse prefix) vs LAN (HTTP + direct)
function getConnectionParams(serverAddress) {
  const isCloud = serverAddress.includes('cloudnimbusllc.com') || serverAddress.includes('nimbus');
  const apiKey = store.get('remote.apiKey') || '';

  if (isCloud) {
    // Cloud: HTTPS on port 443, paths prefixed with /api/pulse
    const host = serverAddress.split(':')[0];
    return {
      transport: https,
      hostname: host,
      port: 443,
      prefix: '/api/pulse',
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
    };
  } else {
    // LAN: HTTP on custom port, direct paths
    const [host, port] = serverAddress.split(':');
    return {
      transport: http,
      hostname: host,
      port: parseInt(port) || 9475,
      prefix: '',
      headers: {},
    };
  }
}

function makeRequest(conn, method, path, payload, onResponse) {
  const headers = {
    ...conn.headers,
    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
  };
  const req = conn.transport.request({
    hostname: conn.hostname,
    port: conn.port,
    path: conn.prefix + path,
    method,
    headers,
    timeout: 5000,
  }, onResponse || ((res) => { res.resume(); }));
  req.on('error', () => {});
  if (payload) req.write(payload);
  req.end();
}

// Auto-register with cloud server if no API key
function autoRegister(conn, callback) {
  const regPayload = JSON.stringify({
    hostname: os.hostname(),
    machineName: store.get('remote.machineName') || os.hostname(),
    platform: process.platform,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    cpuCores: os.cpus().length,
    totalMemMb: Math.round(os.totalmem() / 1048576),
  });
  makeRequest(conn, 'POST', '/register', regPayload, (res) => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      try {
        const { apiKey } = JSON.parse(body);
        if (apiKey) {
          store.set('remote.apiKey', apiKey);
          console.log('Auto-registered with cloud server, API key:', apiKey.slice(0, 8) + '...');
          if (callback) callback(apiKey);
        }
      } catch (e) {}
    });
  });
}

function buildSnapshotPayload(sys, procs) {
  const topCpu = procs.sort((a, b) => b.cpu - a.cpu).slice(0, 10)
    .map(p => ({ name: p.name, pid: p.pid, cpu: p.cpu, memMb: p.memMb }));
  const topMem = [...procs].sort((a, b) => (b.memMB || 0) - (a.memMB || 0)).slice(0, 5)
    .map(p => ({ name: p.name, pid: p.pid, memMb: p.memMb }));

  const nameCounts = {};
  for (const p of procs) nameCounts[p.name] = (nameCounts[p.name] || 0) + 1;
  const duplicates = Object.entries(nameCounts)
    .filter(([name, count]) => count > 3 && !['svchost.exe', 'RuntimeBroker.exe', 'conhost.exe', 'csrss.exe', 'chrome.exe', 'msedge.exe', 'kernel_task', 'launchd', 'mds_stores', 'Google Chrome Helper', 'com.apple.WebKit'].includes(name))
    .map(([name, count]) => ({ name, count }));

  const events = [];
  if (sys.cpuPercent > 75) events.push({ type: 'high-cpu', value: sys.cpuPercent });
  if ((sys.usedMem / sys.totalMem) > 0.9) events.push({ type: 'high-memory', pct: Math.round((sys.usedMem / sys.totalMem) * 100) });
  if (duplicates.length > 0) events.push({ type: 'duplicates', items: duplicates });

  // Include recent healer actions so remote monitoring can see what was auto-fixed
  const recentHealerActions = healerActions.filter(h => Date.now() - new Date(h.ts).getTime() < 300000);
  if (recentHealerActions.length > 0) events.push({ type: 'auto-healed', actions: recentHealerActions });

  return JSON.stringify({
    hostname: store.get('remote.machineName') || os.hostname(),
    ts: new Date().toISOString(),
    cpu: sys.cpuPercent,
    memUsedMb: Math.round(sys.usedMem / 1048576),
    memTotalMb: Math.round(sys.totalMem / 1048576),
    memPct: Math.round((sys.usedMem / sys.totalMem) * 100),
    topCpu,
    topMem,
    duplicates,
    events,
    uptime: sys.uptime,
    lanIPs: getLocalIPs(),
    lanPort: LAN_PORT,
  });
}

// ─── Auto-Healer ──────────────────────────────────────────────────────────
// Proactively detects and fixes common performance problems for any user.
// Runs every snapshot cycle. Escalates through warning → action thresholds.

const KNOWN_BLOATWARE = [
  // Windows updaters & telemetry
  'WmiPrvSE.exe', 'CompatTelRunner.exe', 'SearchProtocolHost.exe',
  'SearchFilterHost.exe', 'MoUsoCoreWorker.exe', 'TiWorker.exe',
  'WUDFHost.exe', 'SgrmBroker.exe', 'SecurityHealthService.exe',
  // Common app updaters
  'GoogleUpdate.exe', 'OneDrive.exe', 'DropboxUpdate.exe',
  'AdobeARMHelper.exe', 'CCXProcess.exe', 'AGSService.exe',
];
const NEVER_KILL = ['node.exe', 'explorer.exe', 'csrss.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'smss.exe', 'wininit.exe', 'System',
  'svchost.exe', 'dwm.exe', 'electron.exe'];

let highCpuStreak = 0;        // consecutive high-CPU readings
let healerActions = [];        // log of actions taken
const HEAL_CPU_WARN = 50;     // start watching
const HEAL_CPU_ACT = 80;      // take action
const HEAL_STREAK_THRESHOLD = 3; // consecutive readings before acting
const ADAPTIVE_SLOW_INTERVAL = 120000; // slow polling under load (2 min)
const ADAPTIVE_FAST_INTERVAL = null;   // use mode-appropriate interval (see getActiveInterval())

function autoHeal(sys, procs) {
  const cpu = sys.cpuPercent;
  const actions = [];

  if (cpu >= HEAL_CPU_WARN) {
    highCpuStreak++;
  } else {
    // Recovered — restore normal polling if we slowed down
    if (highCpuStreak >= HEAL_STREAK_THRESHOLD && clientPushInterval) {
      const remote = store.get('remote');
      if (remote.clientEnabled && remote.serverAddress) {
        clearInterval(clientPushInterval);
        const target = connectionMode === 'lan' && lanPeerAddress ? lanPeerAddress : remote.serverAddress;
        const normalInterval = connectionMode === 'lan' ? LAN_INTERVAL : CLOUD_INTERVAL;
        clientPushInterval = setInterval(() => pushSnapshotToServer(target), normalInterval);
        actions.push({ action: 'restore-polling', interval: normalInterval });
      }
    }
    highCpuStreak = 0;
    return actions;
  }

  // After 2 consecutive high readings, slow down polling to reduce our own load
  if (highCpuStreak === 2 && clientPushInterval) {
    const remote = store.get('remote');
    if (remote.clientEnabled && remote.serverAddress) {
      clearInterval(clientPushInterval);
      const target = connectionMode === 'lan' && lanPeerAddress ? lanPeerAddress : remote.serverAddress;
      clientPushInterval = setInterval(() => pushSnapshotToServer(target), ADAPTIVE_SLOW_INTERVAL);
      actions.push({ action: 'slow-polling', interval: ADAPTIVE_SLOW_INTERVAL, reason: `CPU at ${cpu}% for 2 readings` });
    }
  }

  // After HEAL_STREAK_THRESHOLD consecutive readings above action threshold, act
  if (highCpuStreak >= HEAL_STREAK_THRESHOLD && cpu >= HEAL_CPU_ACT) {
    // Find processes we can safely kill
    const candidates = procs.filter(p =>
      !NEVER_KILL.includes(p.name) &&
      p.memMB > 100 && // only bother with processes using real memory
      KNOWN_BLOATWARE.includes(p.name)
    );

    for (const p of candidates) {
      try {
        process.kill(p.pid);
        actions.push({ action: 'killed', name: p.name, pid: p.pid, memMB: p.memMB, reason: `CPU ${cpu}% for ${highCpuStreak} readings` });
      } catch (_) { /* access denied or already dead */ }
    }

    // Special: kill WmiPrvSE if CPU is critically high — it respawns clean
    if (cpu >= 90) {
      const wmis = procs.filter(p => p.name === 'WmiPrvSE.exe');
      for (const p of wmis) {
        try {
          process.kill(p.pid);
          actions.push({ action: 'killed', name: 'WmiPrvSE.exe', pid: p.pid, reason: 'CPU >= 90%, clearing WMI backlog' });
        } catch (_) { /* needs admin — will fail silently */ }
      }
    }

    // If we couldn't kill anything (empty process list or access denied), blind-kill known offenders
    if (actions.filter(a => a.action === 'killed').length === 0 && platform === 'win32') {
      // When CPU is so high tasklist returns nothing, we can't see what's eating CPU.
      // Blind-kill the usual suspects — they all respawn cleanly.
      const blindTargets = cpu >= 90
        ? ['WmiPrvSE.exe', 'powershell.exe', 'CompatTelRunner.exe', 'MoUsoCoreWorker.exe', 'TiWorker.exe', 'SearchProtocolHost.exe', 'wmic.exe', 'conhost.exe']
        : KNOWN_BLOATWARE;
      for (const name of blindTargets) {
        guard.exec(`taskkill /f /im "${name}" 2>NUL`, { windowsHide: true, timeout: 5000 });
      }
      actions.push({ action: 'blind-taskkill', targets: blindTargets, reason: `CPU ${cpu}% for ${highCpuStreak} readings, process list empty` });
    }
  }

  // Log actions
  if (actions.length > 0) {
    healerActions.push({ ts: new Date().toISOString(), cpu, actions });
    for (const a of actions) {
      const msg = a.action === 'killed'
        ? `Auto-healed: killed ${a.name} (PID ${a.pid}) — ${a.reason}`
        : a.action === 'slow-polling'
        ? `Adaptive: slowed polling to ${a.interval}ms — ${a.reason}`
        : `Auto-heal: ${a.action} ${a.name || ''} — ${a.reason || ''}`;
      console.log(`[auto-healer] ${msg}`);
    }
  }

  return actions;
}

function pollServerForCommands(conn, myHostname) {
  const hostHeader = { 'x-hostname': myHostname };
  const pollConn = { ...conn, headers: { ...conn.headers, ...hostHeader } };

  // Check for pending kill commands
  makeRequest(pollConn, 'GET', '/pending-kills', null, (res) => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      try {
        const kills = JSON.parse(body);
        for (const k of kills) {
          if (k.pid) killProcess(k.pid);
        }
      } catch (e) {}
    });
  });

  // Check for pending remote commands
  makeRequest(pollConn, 'GET', '/pending-commands', null, (cmdRes) => {
    let cmdBody = '';
    cmdRes.on('data', chunk => { cmdBody += chunk; });
    cmdRes.on('end', () => {
      try {
        const cmds = JSON.parse(cmdBody);
        for (const cmd of cmds) {
          // Special commands that System Pulse handles internally
          if (cmd.command === '__self-update__') {
            // Git pull and restart cleanly
            const cdCmd = platform === 'win32' ? `cd /d "${__dirname}"` : `cd "${__dirname}"`;
            guard.exec(`${cdCmd} && git pull`, { timeout: 30000, windowsHide: true }, (err, stdout) => {
              const resultPayload = JSON.stringify({ hostname: myHostname, cmdId: cmd.id, stdout: (stdout || '') + '\nRestarting...', stderr: '', exitCode: 0 });
              makeRequest(conn, 'POST', '/command-result', resultPayload);
              setTimeout(() => { app.relaunch(); app.quit(); }, 2000);
            });
            continue;
          }
          if (cmd.command.startsWith('__launch:')) {
            const tool = cmd.command.replace('__launch:', '').replace('__', '');
            const toolPath = path.join(__dirname, '..', tool);
            const launchToolCmd = platform === 'win32'
              ? `cd /d "${toolPath}" && git pull && start "" npx electron .`
              : `cd "${toolPath}" && git pull && npx electron . &`;
            guard.exec(launchToolCmd, { shell: true, timeout: 60000 }, (err, stdout) => {
              const resultPayload = JSON.stringify({ hostname: myHostname, cmdId: cmd.id, stdout: `Launched ${tool}\n${stdout || ''}`, stderr: '', exitCode: err ? 1 : 0 });
              makeRequest(conn, 'POST', '/command-result', resultPayload);
            });
            continue;
          }
          if (cmd.command === '__launch-claude__') {
            const claudeLaunchCmd = platform === 'darwin'
              ? 'open -a Terminal --args bash -lc "claude"'
              : 'start "Claude Code" cmd /k "set CLAUDECODE= && claude"';
            guard.exec(claudeLaunchCmd, { shell: true });
            const resultPayload = JSON.stringify({ hostname: myHostname, cmdId: cmd.id, stdout: 'Claude Code launched', stderr: '', exitCode: 0 });
            makeRequest(conn, 'POST', '/command-result', resultPayload);
            continue;
          }

          const cmdTimeout = cmd.command.match(/winget|install|msiexec|choco|setup|brew|port|mas/i) ? 300000 : 30000;
          guard.exec(cmd.command, { timeout: cmdTimeout, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
            const resultPayload = JSON.stringify({
              hostname: myHostname,
              cmdId: cmd.id,
              stdout: (stdout || '').slice(0, 500000),
              stderr: (stderr || '').slice(0, 100000),
              exitCode: err ? err.code || 1 : 0,
            });
            makeRequest(conn, 'POST', '/command-result', resultPayload);
          });
        }
      } catch (e) {}
    });
  });
}

async function pushSnapshotToServer(serverAddress) {
  try {
    const conn = getConnectionParams(serverAddress);
    const sys = getSystemInfo();
    const procs = await getProcessList();

    // Run auto-healer every cycle — proactively fix problems for any user
    autoHeal(sys, procs);

    const payload = buildSnapshotPayload(sys, procs);
    const myHostname = store.get('remote.machineName') || os.hostname();
    const isCloud = serverAddress.includes('cloudnimbusllc.com') || serverAddress.includes('nimbus');

    // Push snapshot — handle 401 for auto-registration
    makeRequest(conn, 'POST', '/snapshot', payload, (res) => {
      if (res.statusCode === 401 && isCloud && !store.get('remote.apiKey')) {
        // No API key — auto-register
        autoRegister(conn, (newKey) => {
          // Retry with new key
          const authedConn = { ...conn, headers: { ...conn.headers, 'Authorization': `Bearer ${newKey}` } };
          makeRequest(authedConn, 'POST', '/snapshot', payload);
          pollServerForCommands(authedConn, myHostname);
        });
      } else {
        res.resume();
        pollServerForCommands(conn, myHostname);
      }
    });
  } catch (e) { /* silent */ }
}

function startClientPush() {
  const remote = store.get('remote');
  if (!remote.clientEnabled || !remote.serverAddress) return;
  if (clientPushInterval) clearInterval(clientPushInterval);

  // Start LAN probing — will auto-switch between LAN and cloud
  startLanProbing();

  const target = connectionMode === 'lan' && lanPeerAddress ? lanPeerAddress : remote.serverAddress;
  const interval = connectionMode === 'lan' ? LAN_INTERVAL : CLOUD_INTERVAL;
  pushSnapshotToServer(target);
  clientPushInterval = setInterval(() => pushSnapshotToServer(target), interval);
}

function stopClientPush() {
  if (clientPushInterval) {
    clearInterval(clientPushInterval);
    clientPushInterval = null;
  }
  stopLanProbing();
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

ipcMain.handle('get-system-info', () => getSystemInfo());
ipcMain.handle('get-processes', () => getProcessList());
ipcMain.handle('kill-process', (_, pid) => killProcess(pid));
ipcMain.handle('kill-duplicates', (_, name) => killDuplicates(name));
ipcMain.handle('get-network-usage', () => getNetworkUsage());
ipcMain.handle('run-diagnostic', () => runDiagnostic());
ipcMain.handle('get-platform', () => platform);
ipcMain.handle('get-healer-log', () => healerActions.slice(-50));

ipcMain.handle('set-auto-start', async (_, enabled) => {
  const exePath = process.execPath;
  const appPath = app.getAppPath();
  const launchCmd = exePath.includes('electron') ? `"${exePath}" "${appPath}"` : `"${exePath}"`;

  try {
    if (platform === 'win32') {
      const runCmd = require('child_process').execSync;
      if (enabled) {
        runCmd(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "SystemPulse" /t REG_SZ /d "${launchCmd}" /f`, { windowsHide: true });
      } else {
        runCmd(`reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "SystemPulse" /f`, { windowsHide: true });
      }
    } else if (platform === 'darwin') {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.cloudnimbus.system-pulse.plist');
      if (enabled) {
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.cloudnimbus.system-pulse</string>
<key>ProgramArguments</key><array><string>${exePath}</string><string>${appPath}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>`;
        fs.writeFileSync(plistPath, plist, 'utf8');
      } else {
        try { fs.unlinkSync(plistPath); } catch (e) {}
      }
    } else {
      const desktopPath = path.join(os.homedir(), '.config', 'autostart', 'system-pulse.desktop');
      if (enabled) {
        const dir = path.dirname(desktopPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(desktopPath, `[Desktop Entry]\nType=Application\nName=System Pulse\nExec=${launchCmd}\nHidden=false\n`, 'utf8');
      } else {
        try { fs.unlinkSync(desktopPath); } catch (e) {}
      }
    }
    store.set('autoStart', enabled);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('get-settings', () => ({
  autoStart: store.get('autoStart'),
  startMinimized: store.get('startMinimized'),
}));

ipcMain.handle('save-settings', (_, s) => {
  if (s.startMinimized !== undefined) store.set('startMinimized', s.startMinimized);
  return { status: 'ok' };
});
ipcMain.handle('get-connection-mode', () => ({ mode: connectionMode, peer: lanPeerAddress }));
ipcMain.handle('get-remote-settings', () => store.get('remote'));
ipcMain.handle('save-remote-settings', (_, settings) => {
  const prev = store.get('remote');
  store.set('remote', { ...prev, ...settings });
  const updated = store.get('remote');

  // Start/stop server
  if (updated.serverEnabled && !remoteServer) {
    startRemoteServer(updated.serverPort || 9475);
  } else if (!updated.serverEnabled && remoteServer) {
    stopRemoteServer();
  }

  // Start/stop client
  if (updated.clientEnabled && updated.serverAddress) {
    startClientPush();
  } else {
    stopClientPush();
  }

  return { status: 'ok' };
});

ipcMain.handle('get-remote-clients', () => {
  const clients = {};
  remoteClients.forEach((val, key) => {
    clients[key] = { ...val.lastSnapshot, lastSeen: val.lastSeen };
  });
  return clients;
});

ipcMain.handle('remote-kill', async (_, { hostname, pid, name }) => {
  // If it's a local kill
  if (hostname === os.hostname() || hostname === store.get('remote.machineName')) {
    return killProcess(pid);
  }
  // Queue kill for remote client
  const client = remoteClients.get(hostname);
  if (client) {
    if (!client.pendingKills) client.pendingKills = [];
    client.pendingKills.push({ pid: parseInt(pid), name, ts: Date.now() });
    return { status: 'queued', message: `Kill queued for ${hostname}` };
  }
  return { status: 'error', message: 'Client not connected' };
});

ipcMain.handle('get-log-files', () => getLogFiles());
ipcMain.handle('get-log-entries', (_, filename) => readLogFile(filename));
ipcMain.handle('get-log-summary', (_, filename) => getLogSummary(filename));
ipcMain.handle('get-log-dir', () => logDir);

// ─── Single instance lock ───────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────

if (gotLock) {
app.whenReady().then(async () => {
  guard.init(app);
  createTray();
  startLogging(); // Background diagnostics every 30s

  // First run: register auto-start with the OS
  if (store.get('firstRun')) {
    store.set('firstRun', false);
    try {
      const exePath = process.execPath;
      const appPath = app.getAppPath();
      const launchCmd = exePath.includes('electron') ? `"${exePath}" "${appPath}"` : `"${exePath}"`;
      if (platform === 'win32') {
        require('child_process').execSync(
          `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "SystemPulse" /t REG_SZ /d "${launchCmd}" /f`,
          { windowsHide: true }
        );
      } else if (platform === 'darwin') {
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.cloudnimbus.system-pulse.plist');
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.cloudnimbus.system-pulse</string>
<key>ProgramArguments</key><array><string>${exePath}</string><string>${appPath}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>`;
        fs.writeFileSync(plistPath, plist, 'utf8');
      } else {
        const dir = path.join(os.homedir(), '.config', 'autostart');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'system-pulse.desktop'),
          `[Desktop Entry]\nType=Application\nName=System Pulse\nExec=${launchCmd}\nHidden=false\n`, 'utf8');
      }
    } catch (e) { /* auto-start registration failed, non-fatal */ }
  }

  // Start remote monitoring — both server and client enabled by default
  const remote = store.get('remote');
  if (remote.serverEnabled) startRemoteServer(remote.serverPort || 9475);
  if (remote.clientEnabled && remote.serverAddress) startClientPush();

  if (!store.get('startMinimized')) {
    createWindow();
  }
});
}

app.on('window-all-closed', () => {
  // Keep running in tray
});

app.on('activate', () => {
  if (gotLock && (!mainWindow || mainWindow.isDestroyed())) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
