'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const HEARTBEAT_MAX_AGE_MS = 15000;

function finitePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function commandForPid(pid) {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(finitePid(pid))], { encoding: 'utf8' }).trim(); }
  catch (_) { return ''; }
}

function commandOwnsScript(command, scriptPath) {
  const script = path.resolve(scriptPath);
  return String(command || '').split(/\s+/).some(arg => path.resolve(arg) === script);
}

function findMatchingProcesses(scriptPath, options = {}) {
  const list = options.listProcesses || (() => {
    try { return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }); }
    catch (_) { return ''; }
  });
  return String(list()).split(/\r?\n/).map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), command: match[2] } : null;
  }).filter(item => item && item.pid !== process.pid && commandOwnsScript(item.command, scriptPath));
}

function inspectRuntimeOwner(runtime, options = {}) {
  const maxAgeMs = options.maxAgeMs || HEARTBEAT_MAX_AGE_MS;
  const pid = finitePid(runtime?.pid);
  const daemon = runtime?.components?.['voice-daemon'];
  const ageMs = Number(daemon?.ageMs);
  const heartbeatFresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeMs;
  const pidAlive = pid > 0 && Boolean(options.pidAlive?.(pid));
  const command = pidAlive ? String(options.commandForPid?.(pid) || '') : '';
  const commandMatches = pidAlive && /(?:^|[\/\s])jarvis_daemon\.js(?:\s|$)/.test(command);
  const heartbeatPid = finitePid(daemon?.pid);
  const heartbeatOwnsSnapshot = heartbeatPid === 0 || heartbeatPid === pid;

  return {
    pid,
    heartbeatFresh,
    pidAlive,
    command,
    commandMatches,
    heartbeatOwnsSnapshot,
    healthy: heartbeatFresh && pidAlive && commandMatches && heartbeatOwnsSnapshot
  };
}

function inspectVoiceOwnership({ daemonPids = [], wakePids = [], parentPid = () => 0, runtimeOwner = null } = {}) {
  const daemons = [...new Set(daemonPids.map(finitePid).filter(Boolean))];
  const wakes = [...new Set(wakePids.map(finitePid).filter(Boolean))];
  const runtimePid = runtimeOwner?.healthy ? finitePid(runtimeOwner.pid) : 0;
  if (runtimePid && !daemons.includes(runtimePid)) daemons.push(runtimePid);
  const daemonSet = new Set(daemons);
  const orphanWakePids = wakes.filter(pid => !daemonSet.has(finitePid(parentPid(pid))));

  return {
    daemonPids: daemons,
    wakePids: wakes,
    orphanWakePids,
    healthy: daemons.length === 1 && wakes.length <= 1 && orphanWakePids.length === 0
  };
}

module.exports = {
  HEARTBEAT_MAX_AGE_MS,
  commandForPid,
  commandOwnsScript,
  findMatchingProcesses,
  inspectRuntimeOwner,
  inspectVoiceOwnership
};