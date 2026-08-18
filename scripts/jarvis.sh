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

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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
import_env TELEGRAM_BOT_TOKEN
import_env JARVIS_CHAT_ID

log "ENV: AZURE_SPEECH_REGION=${AZURE_SPEECH_REGION:-?}, KEY set=${AZURE_SPEECH_KEY:+yes}"

# Telegram token noto'g'ri/revoke qilingan bo'lsa node-telegram-bot-api polling
# cheksiz 401 loopga tushadi. Bunday jarayon foyda bermaydi va log/diskni
# to'ldiradi. Startup'da bir marta tekshirib, token tuzatilguncha botni
# o'chirilgan holatda qoldiramiz; voice/dashboard qolganicha ishlayveradi.
TELEGRAM_ENABLED=1
validate_telegram() {
  local response
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] && return 1
  response=$(curl -sS -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null || true)
  [[ "${response}" == *'"ok":true'* ]]
}

if ! validate_telegram; then
  TELEGRAM_ENABLED=0
  warn "[BOT] Telegram token yaroqsiz yoki API mavjud emas — polling vaqtincha o'chirildi."
fi

# ── Foydalanuvchini xabardor qilish ──────────────────────────────────
# Supervisor allaqachon qulagan komponentlarni o'zi qayta tiklardi, lekin
# buni FAQAT logga yozardi — foydalanuvchi tizim qulab-tiklanayotganini
# umuman bilmasdi. Endi jiddiy holatlar Telegram'ga ham yuboriladi.
# Eslatma: bot jarayonining o'zi qulagan bo'lishi mumkin, shuning uchun
# xabar bot orqali emas, to'g'ridan-to'g'ri Telegram API'ga yuboriladi.
notify_owner() {
  local text="$1"
  [[ -z "${TELEGRAM_BOT_TOKEN}" || -z "${JARVIS_CHAT_ID}" ]] && return 0
  curl -s -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${JARVIS_CHAT_ID}" \
    --data-urlencode "text=${text}" >/dev/null 2>&1 || true
}

# Bir xil xabar bilan bosib ketmaslik uchun: har bir komponent haqida
# ko'pi bilan NOTIFY_COOLDOWN sekundda bir marta xabar beriladi.
# Eslatma: macOS'dagi /bin/bash — 3.2 versiyasi, unda assotsiativ massiv
# (declare -A) YO'Q (sinab tasdiqlangan: "declare: -A: invalid option").
# Shuning uchun fayldagi mavjud uslub qo'llaniladi — har bir komponent
# uchun alohida o'zgaruvchi nomi yasab, printf -v orqali yoziladi
# (restart_with_backoff ham aynan shunday ishlaydi).
NOTIFY_COOLDOWN=1800
notify_component() {
  local name="$1" text="$2" now_ts last var
  now_ts=$(date +%s)
  # o'zgaruvchi nomiga yaramaydigan belgilarni almashtiramiz (masalan "-")
  var="LAST_NOTIFY_$(echo "${name}" | tr -c 'a-zA-Z0-9' '_')"
  eval "last=\${${var}:-0}"
  if (( now_ts - last >= NOTIFY_COOLDOWN )); then
    printf -v "${var}" '%s' "${now_ts}"
    notify_owner "${text}"
  fi
}

# ── Child PID'lar (faqat biz to'g'ridan-to'g'ri ishga tushirgan jarayonlar) ──
BOT_PID=""
DAEMON_PID=""
MONITOR_PID=""
DASHBOARD_PID=""

# ── Cleanup: faqat o'zimiz ishga tushirgan jarayonlarni to'xtatish ──
cleanup() {
  warn "Cleanup chaqirildi — child jarayonlar to'xtatilmoqda..."
  [[ -n "${BOT_PID}"    ]] && kill "${BOT_PID}"    2>/dev/null || true
  [[ -n "${DAEMON_PID}" ]] && kill "${DAEMON_PID}" 2>/dev/null || true
  [[ -n "${MONITOR_PID}" ]] && kill "${MONITOR_PID}" 2>/dev/null || true
  [[ -n "${DASHBOARD_PID}" ]] && kill "${DASHBOARD_PID}" 2>/dev/null || true
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
  # Port/bind/auth openclaw.json'da saqlanadi. OpenClaw 2026.7 dan boshlab
  # `gateway start` bu flaglarni qabul qilmaydi; eski flaglar service'ni
  # umuman start qilmasdan usage xatosi bilan chiqib ketardi.
  openclaw gateway start 2>&1 || true
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
  if [[ "${TELEGRAM_ENABLED}" != "1" ]]; then
    BOT_PID=""
    return 0
  fi
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

# ── Ekran kuzatuvchi ishga tushirish (doimiy fon kuzatuvi) ──
start_monitor() {
  log "[MONITOR] Ekran kuzatuvchi ishga tushirilmoqda..."
  echo '{"action":"start"}' | node "${PROJECT_DIR}/skills/screen-monitor/index.js" \
    >>"${LOG_DIR}/screen-monitor-$(date +%Y%m%d).log" 2>&1 &
  MONITOR_PID=$!
  log "[MONITOR] PID=${MONITOR_PID}"
}

# ── Dashboard (localhost veb-HUD) ishga tushirish ──
start_dashboard() {
  log "[DASHBOARD] Ishga tushirilmoqda..."
  node "${PROJECT_DIR}/dashboard/server.js" >>"${LOG_DIR}/dashboard-$(date +%Y%m%d).log" 2>&1 &
  DASHBOARD_PID=$!
  log "[DASHBOARD] PID=${DASHBOARD_PID} — http://localhost:7890"
}

dashboard_healthy() {
  curl -sf --max-time 3 http://127.0.0.1:7890/api/status >/dev/null 2>&1
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
  start_monitor
  start_dashboard
  sleep 2
  ( sleep 3; open "http://localhost:7890" 2>/dev/null || true ) &
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
  if [[ "${TELEGRAM_ENABLED}" == "1" ]] && ! check_child "${BOT_PID}"; then
    warn "[BOT] To'xtagan — qayta ishga tushirish..."
    start_bot
  fi

  # ── Daemon tekshirish ──
  if ! check_child "${DAEMON_PID}"; then
    warn "[DAEMON] To'xtagan — qayta ishga tushirish..."
    start_daemon
  fi

  # ── Monitor tekshirish ──
  if ! check_child "${MONITOR_PID}"; then
    warn "[MONITOR] To'xtagan — qayta ishga tushirish..."
    start_monitor
  fi

  # ── Dashboard tekshirish ──
  if ! check_child "${DASHBOARD_PID}" || ! dashboard_healthy; then
    warn "[DASHBOARD] To'xtagan — qayta ishga tushirish..."
    [[ -n "${DASHBOARD_PID}" ]] && kill "${DASHBOARD_PID}" 2>/dev/null || true
    start_dashboard
  fi

  sleep "${CHECK_INTERVAL}"
done
