/**
 * @name         Process Guard
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Shared child process guard — tracks spawned children, enforces concurrency
 *               limits, cleans up orphans on startup, and kills all children on exit.
 * @author       Cloud Nimbus LLC
 */

const { exec, spawn } = require('child_process');
const os = require('os');

const MAX_CHILDREN = 20;
const ORPHAN_PROCESS_NAMES = ['powershell.exe', 'wmic.exe', 'conhost.exe'];
const ORPHAN_WARN_THRESHOLD = 30;
const PATROL_INTERVAL_MS = 10000;

/** Set of currently tracked child PIDs */
const tracked = new Set();

/** Whether init() has been called */
let initialized = false;

/** Reference to the patrol interval */
let patrolTimer = null;

// ─── Helpers ────────────────────────────────────────────────────

function log(msg) {
  console.log(`[process-guard] ${msg}`);
}

function warn(msg) {
  console.warn(`[process-guard] WARNING: ${msg}`);
}

// ─── Track / untrack ────────────────────────────────────────────

function track(child) {
  if (!child || !child.pid) return;
  tracked.add(child.pid);
  child.on('exit', () => tracked.delete(child.pid));
  child.on('error', () => tracked.delete(child.pid));
}

// ─── Guarded exec ───────────────────────────────────────────────

function guardedExec(command, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  callback = callback || (() => {});

  if (tracked.size >= MAX_CHILDREN) {
    warn(`Refusing to spawn — ${tracked.size} child processes already alive (limit: ${MAX_CHILDREN})`);
    const err = new Error(`Process guard: concurrency limit reached (${MAX_CHILDREN})`);
    return callback(err, '', '');
  }

  const child = exec(command, options, callback);
  track(child);
  return child;
}

// ─── Guarded execPromise ────────────────────────────────────────

function guardedExecPromise(command, timeout) {
  return new Promise((resolve, reject) => {
    if (tracked.size >= MAX_CHILDREN) {
      warn(`Refusing to spawn — ${tracked.size} child processes already alive (limit: ${MAX_CHILDREN})`);
      return reject(new Error(`Process guard: concurrency limit reached (${MAX_CHILDREN})`));
    }

    const opts = { windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
    if (timeout) opts.timeout = timeout;

    const child = exec(command, opts, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    track(child);
  });
}

// ─── Kill all tracked children ──────────────────────────────────

function killAll() {
  for (const pid of tracked) {
    try {
      process.kill(pid);
    } catch (_) { /* already dead */ }
  }
  tracked.clear();
}

// ─── Orphan cleanup (Windows) ───────────────────────────────────

function cleanupOrphans() {
  if (os.platform() !== 'win32') return;

  const cmd = `powershell -NoProfile -Command "Get-Process -Name ${ORPHAN_PROCESS_NAMES.map(n => `'${n.replace('.exe', '')}'`).join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { $parent = (Get-CimInstance Win32_Process -Filter \\"ProcessId=$($_.Id)\\" -ErrorAction SilentlyContinue).ParentProcessId; $parentAlive = $false; try { Get-Process -Id $parent -ErrorAction Stop | Out-Null; $parentAlive = $true } catch {}; if (-not $parentAlive) { $_.Id } } catch {} }"`;

  exec(cmd, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
    if (err || !stdout) return;
    const pids = stdout.trim().split(/\r?\n/).map(p => parseInt(p.trim(), 10)).filter(p => p > 0);
    if (pids.length > 0) {
      log(`Cleaning up ${pids.length} orphaned process(es)`);
      for (const pid of pids) {
        try { process.kill(pid); } catch (_) { /* already dead */ }
      }
    }
  });
}

// ─── Proactive patrol ───────────────────────────────────────────

function startPatrol() {
  if (patrolTimer) return;
  if (os.platform() !== 'win32') return;

  patrolTimer = setInterval(() => {
    const names = ORPHAN_PROCESS_NAMES.map(n => `'${n.replace('.exe', '')}'`).join(',');
    const cmd = `powershell -NoProfile -Command "(Get-Process -Name ${names} -ErrorAction SilentlyContinue).Count"`;

    exec(cmd, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return;
      const count = parseInt((stdout || '').trim(), 10) || 0;
      if (count > ORPHAN_WARN_THRESHOLD) {
        warn(`${count} shell helper processes detected (threshold: ${ORPHAN_WARN_THRESHOLD}) — killing excess`);
        // Kill the oldest ones (those whose parent PID no longer exists)
        cleanupOrphans();
      }
    });
  }, PATROL_INTERVAL_MS);

  // Don't let the patrol timer keep the process alive
  if (patrolTimer.unref) patrolTimer.unref();
}

// ─── Init ───────────────────────────────────────────────────────

function init(electronApp) {
  if (initialized) return;
  initialized = true;

  // Kill all tracked children on exit signals
  const onExit = () => {
    killAll();
    if (patrolTimer) {
      clearInterval(patrolTimer);
      patrolTimer = null;
    }
  };

  process.on('SIGTERM', onExit);
  process.on('SIGINT', onExit);
  process.on('uncaughtException', (err) => {
    warn(`Uncaught exception — killing tracked children: ${err.message}`);
    onExit();
  });

  if (electronApp) {
    electronApp.on('before-quit', onExit);
  }

  // Orphan cleanup on startup
  cleanupOrphans();

  // Start proactive patrol
  startPatrol();

  log(`Initialized (max ${MAX_CHILDREN} concurrent children)`);
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
  init,
  exec: guardedExec,
  execPromise: guardedExecPromise,
  killAll,
  get tracked() { return tracked; },
};
