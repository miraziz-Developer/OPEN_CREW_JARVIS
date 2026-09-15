#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"
LABEL="com.jarvis.openclaw"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
WAS_LAUNCHD=0
WAS_RUNNING=0

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  WAS_LAUNCHD=1
  WAS_RUNNING=1
elif pgrep -f "${PROJECT_DIR}/jarvis_daemon.js" >/dev/null 2>&1; then
  WAS_RUNNING=1
fi

restore_voice() {
  if [[ "$WAS_LAUNCHD" -eq 1 && -f "$PLIST" ]]; then
    launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  elif [[ "$WAS_RUNNING" -eq 1 ]]; then
    "$PROJECT_DIR/scripts/restart-daemon.sh" >/dev/null 2>&1 || true
  fi
}
trap restore_voice EXIT INT TERM

if [[ "$WAS_LAUNCHD" -eq 1 ]]; then
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
fi

PROJECT_DIR="$PROJECT_DIR" node <<'NODE'
const path = require('path');
const { findMatchingProcesses } = require(path.join(process.env.PROJECT_DIR, 'core', 'runtime-health'));
for (const script of ['jarvis_daemon.js', path.join('scripts', 'openwakeword-worker.py')]) {
  for (const owner of findMatchingProcesses(path.join(process.env.PROJECT_DIR, script))) {
    try { process.kill(owner.pid, 'SIGTERM'); } catch (_) {}
  }
}
NODE
sleep 2

node "$PROJECT_DIR/scripts/collect-wake-samples.js" "$@"