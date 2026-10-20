'use strict';

/**
 * Dashboard and voice protocols with real effects:
 *   combat   — security and system sweep with a spoken summary
 *   lockdown — lock the Mac, mute audio, pause running missions
 *   standby  — undo what lockdown changed and return to normal
 * Every command has a timeout and a failed probe becomes "unknown", never a crash.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { PROJECT_DIR } = require('./paths');

const STATE_FILE = path.join(PROJECT_DIR, '.run', 'protocol-state.json');
const REPORT_FILE = path.join(PROJECT_DIR, '.run', 'protocol-report.json');
const MISSIONS_DIR = path.join(PROJECT_DIR, '.run', 'missions');

function defaultRun(command, args, timeoutMs = 6000) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// ── parsers (pure, unit-tested) ───────────────────────────────────────────

function parseFirewall(text) {
  if (/disabled/i.test(text)) return false;
  if (/enabled/i.test(text)) return true;
  return null;
}

function parseFileVault(text) {
  if (/FileVault is On/i.test(text)) return true;
  if (/FileVault is Off/i.test(text)) return false;
  return null;
}

function parseGatekeeper(text) {
  if (/assessments enabled/i.test(text)) return true;
  if (/assessments disabled/i.test(text)) return false;
  return null;
}

/** TCP listeners reachable from the network (not bound to loopback), as "process:port". */
function parseExposedPorts(lsofText) {
  const exposed = new Set();
  for (const line of String(lsofText || '').split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const name = cols.slice(8).join(' ').replace(/\s*\(LISTEN\)\s*$/, '');
    const match = name.match(/^(.*):(\d+)$/);
    if (!match) continue;
    if (/^(?:127\.|\[::1\]|localhost)/.test(match[1])) continue;
    exposed.add(`${cols[0].replace(/\\x20/g, ' ')}:${match[2]}`);
  }
  return [...exposed].sort();
}

function parseDiskFreePercent(dfText) {
  const line = String(dfText || '').trim().split('\n')[1] || '';
  const cols = line.trim().split(/\s+/);
  const size = Number(cols[1]), available = Number(cols[3]);
  return size > 0 && Number.isFinite(available) ? Math.round(available / size * 100) : null;
}

function parseBattery(text) {
  const match = String(text || '').match(/(\d+)%;\s*([\w ]+?);/);
  if (!match) return null;
  return { percent: Number(match[1]), charging: !/discharging/i.test(match[2]), state: match[2].trim() };
}

function parseMemoryFree(text) {
  const match = String(text || '').match(/free percentage:\s*(\d+)%/i);
  return match ? Number(match[1]) : null;
}

function parseTopProcess(psText) {
  const line = String(psText || '').trim().split('\n')[1] || '';
  const match = line.trim().match(/^([\d.]+)\s+(.+)$/);
  return match ? { cpu: Number(match[1]), name: path.basename(match[2]) } : null;
}

function parseJarvisServices(launchctlText) {
  return String(launchctlText || '').split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length >= 3 && /^com\.jarvis\./.test(cols[2]))
    .map(cols => ({ label: cols[2].replace('com.jarvis.', ''), running: cols[0] !== '-' }));
}

// Apple's own listeners: AirPlay Receiver (ControlCenter), Continuity (rapportd),
// sharing daemons. They are expected, so they are reported but not flagged.
const APPLE_SERVICES = /^(?:ControlCe|rapportd|sharingd|identitys|AirPlayXP|remoted|mDNSRespo|launchd)/;

/** Turns probe results into ordered findings and a short spoken summary. */
function buildReport(probe) {
  const findings = [];
  const add = (level, text) => findings.push({ level, text });

  if (probe.firewall === false) add('warn', 'Firewall is off');
  else if (probe.firewall === true) add('ok', 'Firewall is on');
  if (probe.fileVault === false) add('warn', 'FileVault disk encryption is off');
  else if (probe.fileVault === true) add('ok', 'Disk is encrypted');
  if (probe.gatekeeper === false) add('warn', 'Gatekeeper is disabled');
  if (Array.isArray(probe.exposedPorts)) {
    const apple = probe.exposedPorts.filter(port => APPLE_SERVICES.test(port));
    const other = probe.exposedPorts.filter(port => !APPLE_SERVICES.test(port));
    if (other.length) add('warn', `${other.length} app port${other.length > 1 ? 's' : ''} open to the network: ${other.slice(0, 5).join(', ')}`);
    else add('ok', 'No app ports open to the network');
    if (apple.length) add('info', `macOS sharing services listening: ${apple.join(', ')}`);
  }

  if (probe.diskFreePercent != null) add(probe.diskFreePercent < 10 ? 'warn' : 'ok', `Disk ${probe.diskFreePercent}% free`);
  if (probe.battery) {
    const low = probe.battery.percent < 20 && !probe.battery.charging;
    add(low ? 'warn' : 'ok', `Battery ${probe.battery.percent}%${probe.battery.charging ? ', charging' : ''}`);
  }
  if (probe.memoryFreePercent != null) add(probe.memoryFreePercent < 10 ? 'warn' : 'ok', `Memory ${probe.memoryFreePercent}% free`);
  if (probe.topProcess && probe.topProcess.cpu >= 80) add('warn', `${probe.topProcess.name} is using ${Math.round(probe.topProcess.cpu)}% CPU`);
  if (probe.internet === false) add('warn', 'No internet connection');
  else if (probe.internet === true) add('ok', 'Internet is reachable');
  const down = (probe.services || []).filter(service => !service.running);
  if (down.length) add('warn', `JARVIS services down: ${down.map(service => service.label).join(', ')}`);
  else if (probe.services?.length) add('ok', `All ${probe.services.length} JARVIS services running`);

  const warnings = findings.filter(item => item.level === 'warn');
  const summary = warnings.length
    ? `Sweep complete, sir. ${warnings.length} issue${warnings.length > 1 ? 's' : ''}: ${warnings.map(item => item.text).join('; ')}.`
    : 'Sweep complete, sir. All systems nominal, no security issues found.';
  return { findings, warnings: warnings.length, summary };
}

// ── protocols ─────────────────────────────────────────────────────────────

async function combatSweep(options = {}) {
  const run = options.run || defaultRun;
  const [firewall, fileVault, gatekeeper, lsof, df, batt, mem, ps, web, services] = await Promise.all([
    run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']),
    run('/usr/bin/fdesetup', ['status']),
    run('/usr/sbin/spctl', ['--status']),
    run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']),
    run('/bin/df', ['-k', '/System/Volumes/Data']),
    run('/usr/bin/pmset', ['-g', 'batt']),
    run('/usr/bin/memory_pressure', ['-Q']),
    run('/bin/ps', ['-Ao', 'pcpu,comm', '-r']),
    // ICMP is often filtered; an HTTPS request is the reliable reachability test.
    run('/usr/bin/curl', ['-sS', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', 'https://www.apple.com/library/test/success.html']),
    run('/bin/launchctl', ['list'])
  ]);
  const probe = {
    firewall: parseFirewall(firewall.stdout),
    fileVault: parseFileVault(fileVault.stdout),
    // spctl prints its status on stderr on some macOS versions.
    gatekeeper: parseGatekeeper(gatekeeper.stdout + gatekeeper.stderr),
    exposedPorts: lsof.stdout ? parseExposedPorts(lsof.stdout) : null,
    diskFreePercent: parseDiskFreePercent(df.stdout),
    battery: parseBattery(batt.stdout),
    memoryFreePercent: parseMemoryFree(mem.stdout),
    topProcess: parseTopProcess(ps.stdout),
    internet: web.ok && /^[23]\d\d$/.test(web.stdout.trim()),
    services: parseJarvisServices(services.stdout)
  };
  const report = { at: Date.now(), ...buildReport(probe) };
  writeJson(options.reportFile || REPORT_FILE, report);
  return report;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (_) {}
}

function missionApi(options) {
  const { MissionStore } = require('./missions/store');
  const { createMissionApi } = require('./missions/api');
  const store = options.missionStore || new MissionStore({ dir: options.missionsDir || MISSIONS_DIR });
  return { store, api: createMissionApi(store) };
}

async function lockdown(options = {}) {
  const run = options.run || defaultRun;
  const stateFile = options.stateFile || STATE_FILE;
  const previous = readJson(stateFile, {});
  const volume = await run('/usr/bin/osascript', ['-e', 'output volume of (get volume settings) & "," & output muted of (get volume settings)']);
  const [level, muted] = volume.stdout.trim().split(',');

  // Pause only missions that are actually working, and remember them for standby.
  const { store, api } = missionApi(options);
  const paused = [];
  for (const mission of store.list({ open: true })) {
    if (!['planning', 'running'].includes(mission.status)) continue;
    api.control(mission.id, 'pause');
    paused.push(mission.id);
  }

  const again = previous.mode === 'lockdown';
  writeJson(stateFile, {
    mode: 'lockdown',
    // A second lockdown must not overwrite the volume saved by the first one.
    volume: again ? previous.volume : { level: Number(level), muted: muted === 'true' },
    pausedMissions: [...new Set([...(again ? previous.pausedMissions || [] : []), ...paused])],
    at: Date.now()
  });
  await run('/usr/bin/osascript', ['-e', 'set volume with output muted']);
  // Control-Command-Q is the system "Lock Screen" shortcut; display sleep is the fallback.
  const locked = await run('/usr/bin/osascript', ['-e', 'tell application "System Events" to keystroke "q" using {control down, command down}']);
  if (!locked.ok) await run('/usr/bin/pmset', ['displaysleepnow']);
  const missions = paused.length ? ` ${paused.length} running mission${paused.length > 1 ? 's' : ''} paused.` : '';
  return { locked: locked.ok, paused: paused.length, summary: `Lockdown engaged. Screen locked and audio muted.${missions}` };
}

async function standby(options = {}) {
  const run = options.run || defaultRun;
  const stateFile = options.stateFile || STATE_FILE;
  const previous = readJson(stateFile, {});
  const restored = [];
  if (previous.mode === 'lockdown') {
    const volume = previous.volume || {};
    if (Number.isFinite(volume.level)) {
      await run('/usr/bin/osascript', ['-e', `set volume output volume ${Math.max(0, Math.min(100, volume.level))}`]);
    }
    if (!volume.muted) await run('/usr/bin/osascript', ['-e', 'set volume without output muted']);
    restored.push('audio restored');
    const { store, api } = missionApi(options);
    let resumed = 0;
    for (const id of previous.pausedMissions || []) {
      const mission = store.get(id);
      if (mission && mission.status === 'paused') { api.control(id, 'resume'); resumed += 1; }
    }
    if (resumed) restored.push(`${resumed} mission${resumed > 1 ? 's' : ''} resumed`);
  }
  writeJson(stateFile, { mode: 'standby', at: Date.now() });
  return { summary: restored.length ? `Standing down. ${restored.join(', ')}.` : 'Standing down. Systems at nominal standby.' };
}

module.exports = {
  combatSweep, lockdown, standby, buildReport,
  parseFirewall, parseFileVault, parseGatekeeper, parseExposedPorts, parseDiskFreePercent,
  parseBattery, parseMemoryFree, parseTopProcess, parseJarvisServices
};
