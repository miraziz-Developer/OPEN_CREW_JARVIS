#!/bin/bash
# JARVIS Daemon v5.0 restart script
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGFILE="${PROJECT_DIR}/logs/daemon-$(date +%Y%m%d).log"
mkdir -p "$(dirname "$LOGFILE")"

echo "=== $(date) Daemon v5.0 restart ===" >> "$LOGFILE"

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
  pkill -9 -f "node.*jarvis_daemon" 2>/dev/null || true
  pkill -9 -f "sox -d -t raw -r 16000" 2>/dev/null || true
  sleep 1
  nohup node "${PROJECT_DIR}/jarvis_daemon.js" >> "$LOGFILE" 2>&1 &
  PID=$!
  sleep 3
fi

echo "=== $(date) Daemon v5.0 PID=$PID ===" >> "$LOGFILE"
echo "PID=$PID"
