#!/bin/bash
# ═════════════════════════════════════════════════════════════
# JARVIS autostart enable — macOS launchd LaunchAgent
# ═════════════════════════════════════════════════════════════
set -euo pipefail

PLIST_NAME="com.jarvis.openclaw.plist"
SRC="/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS/scripts/${PLIST_NAME}"
DEST="${HOME}/Library/LaunchAgents/${PLIST_NAME}"

echo "🚀 Jarvis avtostart yuklanmoqda..."

if [[ ! -f "${SRC}" ]]; then
  echo "❌ Xatolik: ${SRC} topilmadi. "
  exit 1
fi

# Eski agent olib tashlash
if launchctl list | grep -q "com.jarvis.openclaw"; then
  echo "Eski agent olib tashlanmoqda..."
  launchctl unload "${DEST}" 2>/dev/null || true
  launchctl bootout gui/$(id -u)/com.jarvis.openclaw 2>/dev/null || true
fi

# Nusxa olish
cp "${SRC}" "${DEST}"
chmod 644 "${DEST}"

# Yangi macOS (10.10+) da bootstrap, eskisida load
USER_ID=$(id -u)
echo "User ID: $USER_ID"

if launchctl bootstrap gui/$USER_ID "${DEST}" 2>/dev/null; then
  echo "✅ Jarvis avtostart yuklandi (bootstrap mode)!"
elif launchctl load -w "${DEST}" 2>/dev/null; then
  echo "✅ Jarvis avtostart yuklandi (legacy mode)!"
else
  echo "⚠️ Autostart yuklanmadi. Qo'lda bajaring:"
  echo "   launchctl load -w ${DEST}"
  exit 1
fi

echo "   Login/restart bo'lganda avtomatik ishga tushadi."
