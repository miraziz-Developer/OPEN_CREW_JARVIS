#!/bin/bash
set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"
LABEL="com.jarvis.openclaw"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
WAS_LAUNCHD=0

restore_voice() {
  if [ "$WAS_LAUNCHD" -eq 1 ] && [ -f "$PLIST" ]; then
    launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  else
    "$PROJECT_DIR/scripts/restart-daemon.sh" >/dev/null 2>&1 || true
  fi
}

trap restore_voice EXIT INT TERM

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  WAS_LAUNCHD=1
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
fi

# Faqat shu loyihaning exact script argv'iga ega voice owner jarayonlarini yopamiz.
PROJECT_DIR="$PROJECT_DIR" node <<'NODE'
const path = require('path');
const { findMatchingProcesses } = require(path.join(process.env.PROJECT_DIR, 'core', 'runtime-health'));
for (const script of ['jarvis_daemon.js', path.join('core', 'openwakeword-worker.py')]) {
  for (const owner of findMatchingProcesses(path.join(process.env.PROJECT_DIR, script))) {
    try { process.kill(owner.pid, 'SIGTERM'); } catch (_) {}
  }
}
NODE
sleep 2

printf '\n3 soniyadan keyin calibration boshlanadi...\n3...\n'
sleep 1
printf '2...\n'
sleep 1
printf '1... JIM TURING\n'
sleep 1

node "$PROJECT_DIR/scripts/calibrate-audio.js"