#!/bin/bash
# ═════════════════════════════════════════════════════════════
# JARVIS autostart enable — macOS launchd LaunchAgent
# ═════════════════════════════════════════════════════════════
set -euo pipefail

PLIST_NAME="com.jarvis.openclaw.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${PROJECT_DIR}/scripts/${PLIST_NAME}"
DEST="${HOME}/Library/LaunchAgents/${PLIST_NAME}"
NODE_BIN="$(command -v node)"

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
mkdir -p "${HOME}/Library/LaunchAgents" "${PROJECT_DIR}/logs"
node "${PROJECT_DIR}/scripts/render-launchd.js" "${SRC}" "${DEST}" "${PROJECT_DIR}" "${NODE_BIN}"
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

RUNNER_PLIST="com.jarvis.persistent-agent-runner.plist"
RUNNER_SRC="${PROJECT_DIR}/scripts/${RUNNER_PLIST}"
RUNNER_DEST="${HOME}/Library/LaunchAgents/${RUNNER_PLIST}"
RUNNER_LABEL="com.jarvis.persistent-agent-runner"
if [[ -f "${RUNNER_SRC}" ]]; then
  launchctl bootout gui/$USER_ID/${RUNNER_LABEL} 2>/dev/null || true
  node "${PROJECT_DIR}/scripts/render-launchd.js" "${RUNNER_SRC}" "${RUNNER_DEST}" "${PROJECT_DIR}" "${NODE_BIN}"
  chmod 644 "${RUNNER_DEST}"
  if launchctl bootstrap gui/$USER_ID "${RUNNER_DEST}" 2>/dev/null; then
    echo "✅ Persistent agent runner yuklandi!"
  else
    echo "⚠️ Persistent runner yuklanmadi. Qo'lda: launchctl bootstrap gui/${USER_ID} ${RUNNER_DEST}"
  fi
fi

# ── Pauza sentinel (Fn+Shift bilan to'xtatish/uyg'otish) — alohida,
# doim ishlab turadigan LaunchAgent, asosiy Jarvis'dan mustaqil ──
SENTINEL_PLIST="com.jarvis.pausesentinel.plist"
SENTINEL_SRC="${PROJECT_DIR}/scripts/${SENTINEL_PLIST}"
SENTINEL_DEST="${HOME}/Library/LaunchAgents/${SENTINEL_PLIST}"

if [[ -f "${SENTINEL_SRC}" ]]; then
  if launchctl list | grep -q "com.jarvis.pausesentinel"; then
    launchctl bootout gui/$(id -u)/com.jarvis.pausesentinel 2>/dev/null || true
  fi
  node "${PROJECT_DIR}/scripts/render-launchd.js" "${SENTINEL_SRC}" "${SENTINEL_DEST}" "${PROJECT_DIR}" "${NODE_BIN}"
  chmod 644 "${SENTINEL_DEST}"
  if launchctl bootstrap gui/$USER_ID "${SENTINEL_DEST}" 2>/dev/null; then
    echo "✅ Pauza sentinel (Fn+Shift) yuklandi!"
  else
    echo "⚠️ Pauza sentinel yuklanmadi. Qo'lda: launchctl bootstrap gui/${USER_ID} ${SENTINEL_DEST}"
  fi
fi
