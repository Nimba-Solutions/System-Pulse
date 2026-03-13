// Creates desktop shortcuts for Claude Code and fix-cpu on any machine
const fs = require('fs');
const os = require('os');
const path = require('path');

const desktop = path.join(os.homedir(), 'Desktop');
const nl = '\r\n';

const projects = [
  ['cloudnimbusllc.com', 'Claude-CloudNimbus'],
  ['glenbradford.com', 'Claude-GlenBradford'],
  ['delivery-hub', 'Claude-DeliveryHub'],
  ['mobilization-funding-githubrepo', 'Claude-MF'],
];

for (const [dir, name] of projects) {
  const bat = `@echo off${nl}cd /d C:\\Projects\\${dir}${nl}set CLAUDECODE=${nl}claude --dangerously-skip-permissions${nl}`;
  fs.writeFileSync(path.join(desktop, `${name}.bat`), bat);
  console.log(`Created ${name}.bat`);
}

const fixBat = `@echo off${nl}echo Killing CPU hogs...${nl}taskkill /f /im WmiPrvSE.exe 2>NUL${nl}taskkill /f /im powershell.exe 2>NUL${nl}taskkill /f /im wmic.exe 2>NUL${nl}taskkill /f /im conhost.exe 2>NUL${nl}echo Done.${nl}pause${nl}`;
fs.writeFileSync(path.join(desktop, 'fix-cpu.bat'), fixBat);
console.log('Created fix-cpu.bat');
