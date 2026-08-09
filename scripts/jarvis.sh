#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# JARVIS Production Supervisor (macOS launchd)
# ─────────────────────────────────────────────────────────────────────────
# Vazifalar:
#   1. .env dan kerakli kalitlarni xavfsiz o'qish
#   2. Gateway (openclaw managed), Telegram Bot, Voice Daemon ni boshqarish
#   3. Doimiy health-check va avtomatik tiklash
#   4. Log-rotatsiya va tozalash
#   5. Gateway sog'lom bo'lgandaovozli salom (bir marta/30 daqiqa)
# ═══════════════════════════════════════════════════════════════════════════

set -uo pipefail

PROJECT_DIR="/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS"
LOG_DIR="${PROJECT_DIR}/logs"
DOTENV="${PROJECT_DIR}/.env"
LAST_GREETING="${PROJECT_DIR}/.jarvis-last-greeting"

mkdir -p "${LOG_DIR}"

# ── Timestamp funktsiyasi ──
now() { date '+%Y-%m-%d %H:%M:%S'; }

# ── Log fayllar (kunlik) ──
LOG_MAIN="${LOG_DIR}/jarvis-$(date +%Y%m%d).log"
exec >> >(tee -a "${LOG_MAIN}")
exec 2>> >(tee -a "${LOG_MAIN}" >&2)

# ── Log rotatsiya: 7 kundan eski fayllarni o'chirish ──
find "${LOG_DIR}" -name '*.log' -mtime +7 -delete 2>/dev/null || true

log() { echo "[$(now)] [INFO]  $*"; }
warn() { echo "[$(now)] [WARN]  $*"; }
err()  { echo "[$(now)] [ERROR] $*"; }

log "═══════════════════════════════════════════════════════════"
log "JARVIS SUPERVISOR ishga tushdi — PID $$"
log "═══════════════════════════════════════════════════════════"

# ── .env tekshir ──
if [[ ! -f "${DOTENV}" ]]; then
  err ".env topilmadi: ${DOTENV}"
  sleep 30
  exit 1
fi

# ── .env dan faqat kerakli kalitlarni o'qish ──
import_env() {
  local key="$1"
  local val
  val=$(grep "^${key}=" "${DOTENV}" 2>/dev/null | sed 's/^[^=]*=//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
  val="${val#\"}"; val="${val%\"}"
  val="${val#\'}"; val="${val%\'}"
  export "$key=$val"
}

import_env AZURE_SPEECH_KEY
import_env AZURE_SPEECH_REGION

log "ENV: AZURE_SPEECH_REGION=${AZURE_SPEECH_REGION:-?}, KEY set=${AZURE_SPEECH_KEY:+yes}"

# ── Child PID'lar (faqat biz to'g'ridan-to'g'ri ishga tushirgan jarayonlar) ──
BOT_PID=""
DAEMON_PID=""

# ── Cleanup: faqat o'zimiz ishga tushirgan jarayonlarni to'xtatish ──
cleanup() {
  warn "Cleanup chaqirildi — child jarayonlar to'xtatilmoqda..."
  [[ -n "${BOT_PID}"    ]] && kill "${BOT_PID}"    2>/dev/null || true
  [[ -n "${DAEMON_PID}" ]] && kill "${DAEMON_PID}" 2>/dev/null || true
  log "Cleanup tugadi."
}
trap cleanup EXIT TERM INT

# ── Gateway health-check: port 18789 javob beradimi? ──
gateway_healthy() {
  curl -sf http://127.0.0.1:18789/health >/dev/null 2>&1
}

# ── Gateway ishga tushirish (openclaw orqali, launchd managing) ──
start_gateway() {
  log "[GATEWAY] Ishga tushirish..."
  openclaw gateway start --port 18789 --bind loopback --auth token 2>&1 || true
  log "[GATEWAY] So'rov yuborildi."
}

# ── Gateway qayta ishga tushirish ──
restart_gateway() {
  log "[GATEWAY] Qayta ishga tushirish..."
  openclaw gateway restart 2>&1 || true
  log "[GATEWAY] Restart so'rovi yuborildi."
}

# ── Gateway sog'lom bo'lguncha kutish ──
wait_gateway() {
  local timeout=$1
  local waited=0
  log "[GATEWAY] Health-check: ${timeout}s kutish..."
  while ! gateway_healthy; do
    sleep 1
    waited=$((waited + 1))
    if [[ ${waited} -ge ${timeout} ]]; then
      err "[GATEWAY] ❌ ${timeout}s ichida javob bermadi."
      return 1
    fi
    # Har 5 soniyada bir bor log chiqarish
    if [[ $((waited % 5)) -eq 0 ]]; then
      log "[GATEWAY] Hali kutish: ${waited}/${timeout}s..."
    fi
  done
  log "[GATEWAY] ✅ Sog'lom (${waited}s)"
  return 0
}

# ── Telegram Bot ishga tushirish ──
start_bot() {
  log "[BOT] Telegram Bot ishga tushirilmoqda..."
  node "${PROJECT_DIR}/telegram-bot.js" >>"${LOG_DIR}/bot-$(date +%Y%m%d).log" 2>&1 &
  BOT_PID=$!
  log "[BOT] PID=${BOT_PID}"
}

# ── Voice Daemon ishga tushirish ──
start_daemon() {
  log "[DAEMON] Voice Daemon ishga tushirilmoqda..."
  node "${PROJECT_DIR}/jarvis_daemon.js" >>"${LOG_DIR}/daemon-$(date +%Y%m%d).log" 2>&1 &
  DAEMON_PID=$!
  log "[DAEMON] PID=${DAEMON_PID}"
}

# ── Ovozli salom (bir marta/30 daqiqa limit) ──
greeting() {
  local now_ts last_ts diff_min
  now_ts=$(date +%s)

  # Restart/reboot bo'lganda har doim salom berish
  if [[ "${JARVIS_AUTOSTART:-0}" == "1" ]]; then
    log "[GREETING] Autostart restart — timestamp tozalanyapti."
    rm -f "${LAST_GREETING}"
  fi

  if [[ -f "${LAST_GREETING}" ]]; then
    last_ts=$(cat "${LAST_GREETING}")
    diff_min=$(((now_ts - last_ts) / 60))
    if [[ ${diff_min} -lt 30 ]]; then
      log "[GREETING] Cheklangan: oxirgi salomdan ${diff_min} daqiqa o'tgan."
      return
    fi
  fi

  if [[ -n "${AZURE_SPEECH_KEY:-}" && -x "$(command -v afplay)" ]]; then
    local tmp_json tmp_out
    tmp_json="/tmp/jarvis_greet_$$.json"
    tmp_out="/tmp/jarvis_greet_$$.out"
    log "[GREETING] TTS salom yuborilmoqda..."

    printf '{"text":"Salom, men tayyorman."}\n' >"${tmp_json}"
    if node "${PROJECT_DIR}/skills/azure-tts/index.js" <"${tmp_json}" >"${tmp_out}" 2>/dev/null; then
      local audio_file
      audio_file=$(grep -o '"audioFile":"[^"]*"' "${tmp_out}" | sed 's/.*:"\(.*\)".*/\1/' || true)
      if [[ -n "${audio_file}" && -f "${audio_file}" ]]; then
        afplay "${audio_file}" 2>/dev/null || true
        echo "${now_ts}" >"${LAST_GREETING}"
        log "[GREETING] ✅ Salom yuborildi."
      else
        warn "[GREETING] audioFile topilmadi."
      fi
    else
      warn "[GREETING] TTS skill muvaffaqiyatsiz."
    fi
    rm -f "${tmp_json}" "${tmp_out}"
  else
    log "[GREETING] TTS yo'q (afplay yoki kalit yo'q)"
  fi
}

# ── Child jarayon tekshirish ──
check_child() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

# ═══════════════════════════════════════════════════════════════════════
#  ASOSIY SUPERVISOR LOOP
# ═══════════════════════════════════════════════════════════════════════

# 1) Gateway ishga tushirish (agar hali ishlamayotgan bo'lsa)
if ! gateway_healthy; then
  start_gateway
fi

# 2) Gateway javob berishini kutish
if wait_gateway 60; then
  start_bot
  start_daemon
  sleep 2
  greeting
  log "═══════════════════════════════════════════════════════════"
  log "🤖 JARVIS BARCHA JARAYONLAR TAYYOR"
  log "═══════════════════════════════════════════════════════════"
else
  err "Gateway ishga tushmadi — davom etishdan oldin tiklanish kutilyapti..."
fi

# 3) Doimiy monitoring loop
CHECK_INTERVAL=15
GATEWAY_FAIL_COUNT=0
MAX_GW_FAIL=3

while true; do
  # ── Gateway tekshirish (curl health) ──
  if ! gateway_healthy; then
    GATEWAY_FAIL_COUNT=$((GATEWAY_FAIL_COUNT + 1))
    warn "[GATEWAY] ❌ Health-check muvaffaqiyatsiz (${GATEWAY_FAIL_COUNT}/${MAX_GW_FAIL})"

    if [[ ${GATEWAY_FAIL_COUNT} -ge ${MAX_GW_FAIL} ]]; then
      err "[GATEWAY] ${MAX_GW_FAIL} marta ketma-ket muvaffaqiyatsiz. Restart..."
      restart_gateway
      if wait_gateway 60; then
        GATEWAY_FAIL_COUNT=0
        log "[GATEWAY] ✅ Qayta tiklandi."
      else
        warn "[GATEWAY] Restart ham muvaffaqiyatsiz. Keyingi siklga qadar kutish..."
      fi
    fi
  else
    if [[ ${GATEWAY_FAIL_COUNT} -gt 0 ]]; then
      log "[GATEWAY] ✅ Sog'lom (avvalgi xatolar tiklandi)"
    fi
    GATEWAY_FAIL_COUNT=0
  fi

  # ── Bot tekshirish ──
  if ! check_child "${BOT_PID}"; then
    warn "[BOT] To'xtagan — qayta ishga tushirish..."
    start_bot
  fi

  # ── Daemon tekshirish ──
  if ! check_child "${DAEMON_PID}"; then
    warn "[DAEMON] To'xtagan — qayta ishga tushirish..."
    start_daemon
  fi

  sleep "${CHECK_INTERVAL}"
done
