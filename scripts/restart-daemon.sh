#!/bin/bash
# JARVIS Daemon v5.0 restart script
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGFILE="${PROJECT_DIR}/logs/daemon-$(date +%Y%m%d).log"
mkdir -p "$(dirname "$LOGFILE")"

echo "=== $(date) Daemon v5.0 restart ===" >> "$LOGFILE"

# Pause is a hard privacy/state boundary. A maintenance restart must never
# silently reactivate the microphone while the user has paused JARVIS. Clean up
# any orphan daemon left by an earlier manual restart, then remain stopped.
if [[ -f "${PROJECT_DIR}/.jarvis-paused" ]]; then
  cd "${PROJECT_DIR}"
  node -e "const {findMatchingProcesses}=require('./core/runtime-health'); for(const p of findMatchingProcesses(require('path').join(process.cwd(),'jarvis_daemon.js'))) { try { process.kill(p.pid, 'SIGTERM'); } catch {} }"
  echo "=== $(date) Restart skipped: JARVIS is paused ===" >> "$LOGFILE"
  echo "PAUSED=1"
  exit 0
fi

# LaunchAgent o'rnatilgan bo'lsa, yangi qo'lda nusxa yaratmaymiz. Avvalgi
# skript launchd jarayonini o'ldirib, launchd avtomatik qayta ko'targach yana
# nohup nusxasini ham boshlardi — natijada 2 daemon/2 mikrofon oqimi ishlardi.
LABEL="com.jarvis.openclaw"
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
  sleep 3
  PID="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/pid =/{print $3; exit}')"
else
  cd "${PROJECT_DIR}"
  node -e "const {findMatchingProcesses}=require('./core/runtime-health'); for(const p of findMatchingProcesses(require('path').join(process.cwd(),'jarvis_daemon.js'))) { try { process.kill(p.pid, 'SIGTERM'); } catch {} }"
  sleep 1
  nohup node "${PROJECT_DIR}/jarvis_daemon.js" >> "$LOGFILE" 2>&1 &
  PID=$!
  sleep 3
fi

echo "=== $(date) Daemon v5.0 PID=$PID ===" >> "$LOGFILE"
echo "PID=$PID"
