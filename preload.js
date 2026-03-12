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

  // Events from main
  onTrayHealthUpdate: (cb) => ipcRenderer.on('health-update', (_, data) => cb(data)),
});
