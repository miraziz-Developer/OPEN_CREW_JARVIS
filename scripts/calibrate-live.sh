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

# Faqat shu loyihaning qolib ketgan voice owner jarayonlarini yopamiz.
pkill -f "[n]ode $PROJECT_DIR/jarvis_daemon\.js" 2>/dev/null || true
pkill -f "[o]penwakeword-worker\.py" 2>/dev/null || true
sleep 2

printf '\n3 soniyadan keyin calibration boshlanadi...\n3...\n'
sleep 1
printf '2...\n'
sleep 1
printf '1... JIM TURING\n'
sleep 1

node "$PROJECT_DIR/scripts/calibrate-audio.js"