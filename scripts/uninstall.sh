#!/bin/bash
# JARVIS xizmatlarini o'chiradi (launchd). Kod, .env, xotira va ma'lumotlarga TEGMAYDI.
set -euo pipefail
cd "$(dirname "$0")/.."
UID_="$(id -u)"
echo "Bu quyidagi xizmatlarni to'xtatadi va avtostartdan olib tashlaydi:"
ls ~/Library/LaunchAgents 2>/dev/null | grep -E '^com\.jarvis\.' | sed 's/^/  • /' || true
read -r -p "Davom etamizmi? [y/N] " a
[[ "${a:-N}" =~ ^[Yy]$ ]] || { echo "Bekor qilindi."; exit 0; }
for plist in ~/Library/LaunchAgents/com.jarvis.*.plist; do
  [[ -f "$plist" ]] || continue
  label="$(basename "$plist" .plist)"
  launchctl bootout "gui/$UID_/$label" 2>/dev/null || true
  mv "$plist" "$plist.removed"   # o'chirmaymiz — kerak bo'lsa qaytarish mumkin
  echo "  ✅ $label to'xtatildi"
done
pkill -f "$(pwd)/jarvis_daemon.js" 2>/dev/null || true
echo
echo "Tayyor. Kod va ma'lumotlar joyida: $(pwd)"
echo "Butunlay olib tashlash uchun papkani o'zingiz o'chirasiz. OpenClaw gateway (ai.openclaw.gateway) ga tegilmadi."
echo "Qayta yoqish: ./install.sh"
