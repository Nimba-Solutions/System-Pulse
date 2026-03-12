/**
 * @name         System Pulse
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Preload script — exposes IPC bridge to the renderer process.
 * @author       Cloud Nimbus LLC
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // System overview
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // Processes
  getProcesses: () => ipcRenderer.invoke('get-processes'),
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),
  killDuplicates: (name) => ipcRenderer.invoke('kill-duplicates', name),

  // Network
  getNetworkUsage: () => ipcRenderer.invoke('get-network-usage'),

  // Diagnostics
  runDiagnostic: () => ipcRenderer.invoke('run-diagnostic'),

  // Platform
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // Logs
  getLogFiles: () => ipcRenderer.invoke('get-log-files'),
  getLogEntries: (filename) => ipcRenderer.invoke('get-log-entries', filename),
  getLogSummary: (filename) => ipcRenderer.invoke('get-log-summary', filename),
  getLogDir: () => ipcRenderer.invoke('get-log-dir'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  setAutoStart: (v) => ipcRenderer.invoke('set-auto-start', v),

  // Remote monitoring
  getRemoteSettings: () => ipcRenderer.invoke('get-remote-settings'),
  saveRemoteSettings: (s) => ipcRenderer.invoke('save-remote-settings', s),
  getRemoteClients: () => ipcRenderer.invoke('get-remote-clients'),
  remoteKill: (hostname, pid, name) => ipcRenderer.invoke('remote-kill', { hostname, pid, name }),
  onRemoteSnapshot: (cb) => ipcRenderer.on('remote-snapshot', (_, data) => cb(data)),
  onRemoteAlert: (cb) => ipcRenderer.on('remote-alert', (_, data) => cb(data)),

  // Events from main
  onTrayHealthUpdate: (cb) => ipcRenderer.on('health-update', (_, data) => cb(data)),
});
