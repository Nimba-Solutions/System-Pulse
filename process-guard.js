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

/** Prune PIDs that are no longer alive (killed externally via taskkill etc.) */
function pruneDeadPids() {
  for (const pid of tracked) {
    try {
      process.kill(pid, 0); // signal 0 = just check if alive
    } catch (_) {
      tracked.delete(pid);
    }
  }
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
    // Before refusing, prune dead PIDs — they may have been killed externally
    pruneDeadPids();
  }

  if (tracked.size >= MAX_CHILDREN) {
    warn(`Refusing to spawn — ${tracked.size} child processes actually alive (limit: ${MAX_CHILDREN})`);
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
      pruneDeadPids();
    }
    if (tracked.size >= MAX_CHILDREN) {
      warn(`Refusing to spawn — ${tracked.size} child processes actually alive (limit: ${MAX_CHILDREN})`);
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

  // Use taskkill-based cleanup instead of PowerShell to avoid spawning more of the problem
  const names = ORPHAN_PROCESS_NAMES.map(n => n.replace('.exe', ''));
  const cmd = `tasklist /fo csv /nh /fi "IMAGENAME eq powershell.exe" /fi "MEMUSAGE gt 0"`;

  exec(cmd, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
    if (err || !stdout) return;
    const lines = (stdout || '').trim().split('\n').filter(l => l.includes(','));
    if (lines.length > ORPHAN_WARN_THRESHOLD) {
      log(`Found ${lines.length} powershell processes (threshold: ${ORPHAN_WARN_THRESHOLD}) — killing excess`);
      exec('taskkill /f /im powershell.exe /fi "WINDOWTITLE ne Administrator*"', { windowsHide: true, timeout: 10000 });
    }
  });
}

// ─── Proactive patrol ───────────────────────────────────────────

function startPatrol() {
  if (patrolTimer) return;
  if (os.platform() !== 'win32') return;

  patrolTimer = setInterval(() => {
    // Use tasklist instead of PowerShell to avoid spawning more of the problem
    exec('tasklist /fo csv /nh /fi "IMAGENAME eq powershell.exe"', { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return;
      const lines = (stdout || '').trim().split('\n').filter(l => l.includes('powershell'));
      if (lines.length > ORPHAN_WARN_THRESHOLD) {
        warn(`${lines.length} powershell processes detected (threshold: ${ORPHAN_WARN_THRESHOLD}) — killing excess`);
        exec('taskkill /f /im powershell.exe', { windowsHide: true, timeout: 10000 });
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
