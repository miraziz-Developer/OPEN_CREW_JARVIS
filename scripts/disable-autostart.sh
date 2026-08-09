#!/bin/bash
# ═════════════════════════════════════════════════════════════
# JARVIS autostart disable — macOS launchd LaunchAgent
# ═════════════════════════════════════════════════════════════
set -euo pipefail

PLIST_NAME="com.jarvis.openclaw.plist"
DEST="${HOME}/Library/LaunchAgents/${PLIST_NAME}"

echo "🛑 Jarvis avtostart o'chirilmoqda..."

# Eski usulda olish
launchctl unload "${DEST}" 2>/dev/null || true

# Yangi macOS da o'chirish
USER_ID=$(id -u)
launchctl bootout gui/$USER_ID/com.jarvis.openclaw 2>/dev/null || true

# Faylni o'chirish
if [[ -f "${DEST}" ]]; then
  rm -f "${DEST}"
  echo "✅ Avtostart o'chirildi. Keyingi restartda Jarvis ishga tushmaydi."
else
  echo "ℹ️  Avtostart allaqachon o'chirilgan."
fi

echo "   Hozir ishlatilayotgan Jarvis ni to'xtatish:"
echo "   bash scripts/jarvis.sh stop  # yoki:"
echo "   pkill -9 -f jarvis_daemon; pkill -9 -f telegram-bot"
