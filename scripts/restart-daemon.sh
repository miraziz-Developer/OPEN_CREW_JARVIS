#!/bin/bash
# JARVIS Daemon v5.0 restart script
LOGFILE="/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS/logs/daemon-$(date +%Y%m%d).log"
mkdir -p "$(dirname "$LOGFILE")"

echo "=== $(date) Daemon v5.0 restart ===" >> "$LOGFILE"

# Eski daemonlarni to'xtatish
pkill -9 -f "node.*jarvis_daemon" 2>/dev/null
pkill -9 -f "sox.*rec -r 16000" 2>/dev/null
sleep 1

# Yangi daemon
nohup node /Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS/jarvis_daemon.js >> "$LOGFILE" 2>&1 &
PID=$!
sleep 3

echo "=== $(date) Daemon v5.0 PID=$PID ===" >> "$LOGFILE"
echo "PID=$PID"
