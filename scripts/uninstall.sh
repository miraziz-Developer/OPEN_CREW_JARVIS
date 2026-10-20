#!/bin/bash
# Removes the JARVIS services (launchd). Does NOT touch the code, .env, memory or data.
set -euo pipefail
cd "$(dirname "$0")/.."
UID_="$(id -u)"
echo "This stops the following services and removes them from autostart:"
ls ~/Library/LaunchAgents 2>/dev/null | grep -E '^com\.jarvis\.' | sed 's/^/  • /' || true
read -r -p "Continue? [y/N] " a
[[ "${a:-N}" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }
for plist in ~/Library/LaunchAgents/com.jarvis.*.plist; do
  [[ -f "$plist" ]] || continue
  label="$(basename "$plist" .plist)"
  launchctl bootout "gui/$UID_/$label" 2>/dev/null || true
  mv "$plist" "$plist.removed"   # not deleted, so it can be restored if needed
  echo "  ✅ $label stopped"
done
pkill -f "$(pwd)/jarvis_daemon.js" 2>/dev/null || true
echo
echo "Done. Code and data are still in: $(pwd)"
echo "To remove everything, delete the folder yourself. The OpenClaw gateway (ai.openclaw.gateway) was not touched."
echo "Qayta yoqish: ./install.sh"
