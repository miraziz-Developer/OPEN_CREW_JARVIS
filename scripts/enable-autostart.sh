#!/bin/bash
# ═════════════════════════════════════════════════════════════
# JARVIS autostart enable — macOS launchd LaunchAgent
# ═════════════════════════════════════════════════════════════
set -euo pipefail

PLIST_NAME="com.jarvis.openclaw.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${PROJECT_DIR}/scripts/${PLIST_NAME}"
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

# Joriy clone yo'lidan portable plist yaratish.
sed "s|/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS|${PROJECT_DIR}|g" "${SRC}" > "${DEST}"
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

# ── Pauza sentinel (Fn+Shift bilan to'xtatish/uyg'otish) — alohida,
# doim ishlab turadigan LaunchAgent, asosiy Jarvis'dan mustaqil ──
SENTINEL_PLIST="com.jarvis.pausesentinel.plist"
SENTINEL_SRC="${PROJECT_DIR}/scripts/${SENTINEL_PLIST}"
SENTINEL_DEST="${HOME}/Library/LaunchAgents/${SENTINEL_PLIST}"

if [[ -f "${SENTINEL_SRC}" ]]; then
  if launchctl list | grep -q "com.jarvis.pausesentinel"; then
    launchctl bootout gui/$(id -u)/com.jarvis.pausesentinel 2>/dev/null || true
  fi
  sed "s|/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS|${PROJECT_DIR}|g" "${SENTINEL_SRC}" > "${SENTINEL_DEST}"
  chmod 644 "${SENTINEL_DEST}"
  if launchctl bootstrap gui/$USER_ID "${SENTINEL_DEST}" 2>/dev/null; then
    echo "✅ Pauza sentinel (Fn+Shift) yuklandi!"
  else
    echo "⚠️ Pauza sentinel yuklanmadi. Qo'lda: launchctl bootstrap gui/${USER_ID} ${SENTINEL_DEST}"
  fi
fi
