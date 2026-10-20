#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# JARVIS Production Supervisor (macOS launchd)
# ─────────────────────────────────────────────────────────────────────────
# Responsibilities:
#   1. Safely read the required keys from .env
#   2. Manage the gateway (openclaw-managed), Telegram bot and voice daemon
#   3. Continuous health checks and automatic recovery
#   4. Log rotation and cleanup
#   5. Spoken greeting once the gateway is healthy (at most once per 30 minutes)
# ═══════════════════════════════════════════════════════════════════════════

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs"
DOTENV="${PROJECT_DIR}/.env"
export OPENCLAW_CONFIG_PATH="${PROJECT_DIR}/openclaw.json"
LAST_GREETING="${PROJECT_DIR}/.jarvis-last-greeting"
SUPERVISOR_LOCK="${PROJECT_DIR}/.jarvis-supervisor.lock"

mkdir -p "${LOG_DIR}"

pid_owns_supervisor() {
  local pid="$1" command
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  command=$(ps -o command= -p "${pid}" 2>/dev/null || true)
  [[ " ${command} " == *" ${PROJECT_DIR}/scripts/jarvis.sh "* || "${command}" == *"/bash ${PROJECT_DIR}/scripts/jarvis.sh"* ]]
}

# Running the script by hand while the launchd copy is running would create a
# second bot/daemon/dashboard. macOS's stock bash has no `flock`, so an atomic
# mkdir is used as the singleton lock.
acquire_supervisor_lock() {
  local owner=""
  if mkdir "${SUPERVISOR_LOCK}" 2>/dev/null; then
    echo "$$" >"${SUPERVISOR_LOCK}/pid"
    return 0
  fi

  [[ -f "${SUPERVISOR_LOCK}/pid" ]] && owner=$(cat "${SUPERVISOR_LOCK}/pid" 2>/dev/null || true)
  if [[ -n "${owner}" ]] && pid_owns_supervisor "${owner}"; then
    echo "JARVIS supervisor is already running (PID=${owner})." >&2
    exit 0
  fi

  rm -rf "${SUPERVISOR_LOCK}" 2>/dev/null || true
  if ! mkdir "${SUPERVISOR_LOCK}" 2>/dev/null; then
    echo "JARVIS supervisor lock yaratilmadi: ${SUPERVISOR_LOCK}" >&2
    exit 1
  fi
  echo "$$" >"${SUPERVISOR_LOCK}/pid"
}

acquire_supervisor_lock

# Keep children from crash-looping when dependencies are missing. launchd shows the
# exact error, and the installer reloads only after `npm ci` succeeds.
if ! node "${PROJECT_DIR}/scripts/check-runtime-deps.js"; then
  rm -rf "${SUPERVISOR_LOCK}" 2>/dev/null || true
  exit 1
fi

# ── Timestamp funktsiyasi ──
now() { date '+%Y-%m-%d %H:%M:%S'; }

# ── Log fayllar (kunlik) ──
LOG_MAIN="${LOG_DIR}/jarvis-$(date +%Y%m%d).log"
exec >> >(tee -a "${LOG_MAIN}")
exec 2>> >(tee -a "${LOG_MAIN}" >&2)

# ── Log rotation: delete files older than 7 days ──
find "${LOG_DIR}" -name '*.log' -mtime +7 -delete 2>/dev/null || true

log() { echo "[$(now)] [INFO]  $*"; }
warn() { echo "[$(now)] [WARN]  $*"; }
err()  { echo "[$(now)] [ERROR] $*"; }

log "═══════════════════════════════════════════════════════════"
log "JARVIS SUPERVISOR started — PID $$"
log "═══════════════════════════════════════════════════════════"

# ── Check .env ──
if [[ ! -f "${DOTENV}" ]]; then
  err ".env not found: ${DOTENV}"
  sleep 30
  exit 1
fi

# ── Read only the required keys from .env ──
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
import_env OPENCLAW_GATEWAY_TOKEN

log "ENV: AZURE_SPEECH_REGION=${AZURE_SPEECH_REGION:-?}, KEY set=${AZURE_SPEECH_KEY:+yes}"

# With a wrong or revoked Telegram token, node-telegram-bot-api polling falls into
# an endless 401 loop that does nothing but fill the logs and disk. Check once at
# startup and keep the bot disabled until the token is fixed; voice and dashboard
# keep running.
TELEGRAM_ENABLED=1
validate_telegram() {
  local response
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] && return 1
  response=$(curl -sS -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null || true)
  [[ "${response}" == *'"ok":true'* ]]
}

if ! validate_telegram; then
  TELEGRAM_ENABLED=0
  warn "[BOT] Telegram token is invalid or the API is unreachable; polling temporarily disabled."
fi

# ── Notify the user ──────────────────────────────────────────────────
# The supervisor already restarted crashed components on its own, but only logged
# it, so the user never knew the system was crashing and recovering. Serious
# events are now also sent to Telegram. The bot process itself may be the one that
# crashed, so the message goes straight to the Telegram API, not through the bot.
notify_owner() {
  local text="$1"
  [[ -z "${TELEGRAM_BOT_TOKEN}" || -z "${JARVIS_CHAT_ID}" ]] && return 0
  curl -s -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${JARVIS_CHAT_ID}" \
    --data-urlencode "text=${text}" >/dev/null 2>&1 || true
}

# To avoid spamming the same message, each component notifies at most once per
# NOTIFY_COOLDOWN seconds. macOS ships /bin/bash 3.2, which has NO associative
# arrays (verified: "declare: -A: invalid option"), so, like restart_with_backoff,
# a separate variable name is built per component and written with printf -v.
NOTIFY_COOLDOWN=1800
notify_component() {
  local name="$1" text="$2" now_ts last var
  now_ts=$(date +%s)
  # replace characters that are not valid in variable names (e.g. "-")
  var="LAST_NOTIFY_$(echo "${name}" | tr -c 'a-zA-Z0-9' '_')"
  eval "last=\${${var}:-0}"
  if (( now_ts - last >= NOTIFY_COOLDOWN )); then
    printf -v "${var}" '%s' "${now_ts}"
    notify_owner "${text}"
  fi
}

# ── Child PIDs (only processes we started directly) ──
BOT_PID=""
DAEMON_PID=""
MONITOR_PID=""
DASHBOARD_PID=""

# ── Cleanup: stop only the processes we started ──
cleanup() {
  warn "Cleanup called; stopping child processes..."
  [[ -n "${BOT_PID}"    ]] && kill "${BOT_PID}"    2>/dev/null || true
  [[ -n "${DAEMON_PID}" ]] && kill "${DAEMON_PID}" 2>/dev/null || true
  [[ -n "${MONITOR_PID}" ]] && kill "${MONITOR_PID}" 2>/dev/null || true
  [[ -n "${DASHBOARD_PID}" ]] && kill "${DASHBOARD_PID}" 2>/dev/null || true
  if [[ -f "${SUPERVISOR_LOCK}/pid" ]] && [[ "$(cat "${SUPERVISOR_LOCK}/pid" 2>/dev/null || true)" == "$$" ]]; then
    rm -rf "${SUPERVISOR_LOCK}" 2>/dev/null || true
  fi
  log "Cleanup tugadi."
}
trap cleanup EXIT TERM INT

# ── Gateway health check: does port 18789 respond? ──
gateway_healthy() {
  curl -sf http://127.0.0.1:18789/health >/dev/null 2>&1
}

# ── Start the gateway (via openclaw; launchd-managed) ──
start_gateway() {
  log "[GATEWAY] Starting..."
  # Port/bind/auth live in openclaw.json. Since OpenClaw 2026.7, `gateway start`
  # no longer accepts these flags; the old flags made it exit with a usage error
  # without starting the service at all.
  if ! openclaw gateway start 2>&1; then
    err "[GATEWAY] Start request failed."
    return 1
  fi
  log "[GATEWAY] Request sent."
}

# ── Restart the gateway ──
restart_gateway() {
  log "[GATEWAY] Restarting..."
  if ! openclaw gateway restart 2>&1; then
    err "[GATEWAY] Restart request failed."
    return 1
  fi
  log "[GATEWAY] Restart request sent."
}

# ── Wait until the gateway is healthy ──
wait_gateway() {
  local timeout=$1
  local waited=0
  log "[GATEWAY] Health-check: ${timeout}s kutish..."
  while ! gateway_healthy; do
    sleep 1
    waited=$((waited + 1))
    if [[ ${waited} -ge ${timeout} ]]; then
      err "[GATEWAY] ❌ No response within ${timeout}s."
      return 1
    fi
    # Log once every 5 seconds
    if [[ $((waited % 5)) -eq 0 ]]; then
      log "[GATEWAY] Still waiting: ${waited}/${timeout}s..."
    fi
  done
  log "[GATEWAY] ✅ Healthy (${waited}s)"
  return 0
}

# ── Start the Telegram bot ──
start_bot() {
  if [[ "${TELEGRAM_ENABLED}" != "1" ]]; then
    BOT_PID=""
    return 0
  fi
  log "[BOT] Starting the Telegram bot..."
  node "${PROJECT_DIR}/telegram-bot.js" >>"${LOG_DIR}/bot-$(date +%Y%m%d).log" 2>&1 &
  BOT_PID=$!
  log "[BOT] PID=${BOT_PID}"
}

# ── Start the voice daemon ──
start_daemon() {
  log "[DAEMON] Starting the voice daemon..."
  node "${PROJECT_DIR}/jarvis_daemon.js" >>"${LOG_DIR}/daemon-$(date +%Y%m%d).log" 2>&1 &
  DAEMON_PID=$!
  log "[DAEMON] PID=${DAEMON_PID}"
}

# ── Start the screen monitor (continuous background observation) ──
start_monitor() {
  log "[MONITOR] Starting the screen monitor..."
  echo '{"action":"start"}' | node "${PROJECT_DIR}/skills/screen-monitor/index.js" \
    >>"${LOG_DIR}/screen-monitor-$(date +%Y%m%d).log" 2>&1 &
  MONITOR_PID=$!
  log "[MONITOR] PID=${MONITOR_PID}"
}

# ── Start the dashboard (localhost web HUD) ──
start_dashboard() {
  local existing_pid=""
  if dashboard_healthy; then
    existing_pid=$(dashboard_pid_from_port)
    DASHBOARD_PID="${existing_pid}"
    log "[DASHBOARD] Adopted the existing healthy process — PID=${DASHBOARD_PID:-?}"
    return 0
  fi

  log "[DASHBOARD] Starting..."
  node "${PROJECT_DIR}/dashboard/server.js" >>"${LOG_DIR}/dashboard-$(date +%Y%m%d).log" 2>&1 &
  DASHBOARD_PID=$!
  log "[DASHBOARD] PID=${DASHBOARD_PID} — http://localhost:7890"
}

dashboard_healthy() {
  curl -sf --max-time 3 http://127.0.0.1:7890/api/status >/dev/null 2>&1
}

dashboard_pid_from_port() {
  /usr/sbin/lsof -nP -tiTCP:7890 -sTCP:LISTEN 2>/dev/null | head -n 1
}

stop_dashboard() {
  local pid="${DASHBOARD_PID:-}"
  [[ -z "${pid}" ]] && pid=$(dashboard_pid_from_port)
  [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true

  # SIGTERM is asynchronous: if the new copy starts before the old Node process
  # releases the port, it gets EADDRINUSE. Wait up to 5 seconds for the port.
  local waited=0
  while [[ -n "$(dashboard_pid_from_port)" ]] && [[ ${waited} -lt 50 ]]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  DASHBOARD_PID=""
}

# ── Spoken greeting ──
# In autostart mode it is spoken only once per login/boot session. Supervisor
# crashes/restarts or an Fn+Shift resume do not repeat it within one boot. When
# started by hand, the old 30-minute limit still applies.
greeting() {
  local now_ts last_ts diff_min boot_id last_boot
  now_ts=$(date +%s)

  if [[ "${JARVIS_AUTOSTART:-0}" == "1" ]]; then
    boot_id=$(sysctl -n kern.boottime 2>/dev/null | sed -E 's/.*sec = ([0-9]+).*/\1/' || true)
    [[ -z "${boot_id}" ]] && boot_id="login-$(id -u)"

    if [[ -f "${LAST_GREETING}" ]]; then
      read -r last_boot last_ts <"${LAST_GREETING}" || true
      if [[ "${last_boot:-}" == "${boot_id}" ]]; then
        log "[GREETING] Already greeted in this boot session."
        return
      fi
    fi
  fi

  if [[ "${JARVIS_AUTOSTART:-0}" != "1" && -f "${LAST_GREETING}" ]]; then
    last_ts=$(awk '{print $NF}' "${LAST_GREETING}" 2>/dev/null || echo 0)
    diff_min=$(((now_ts - last_ts) / 60))
    if [[ ${diff_min} -lt 30 ]]; then
        log "[GREETING] Skipped: only ${diff_min} minutes since the last greeting."
      return
    fi
  fi

  if [[ (-n "${AZURE_SPEECH_KEY:-}" || -x "$(command -v say)") && -x "$(command -v afplay)" ]]; then
    local tmp_json tmp_out
    tmp_json="/tmp/jarvis_greet_$$.json"
    tmp_out="/tmp/jarvis_greet_$$.out"
    log "[GREETING] Sending TTS greeting..."

    printf '{"text":"Online. All systems ready."}\n' >"${tmp_json}"
    if node "${PROJECT_DIR}/skills/azure-tts/index.js" <"${tmp_json}" >"${tmp_out}" 2>/dev/null; then
      local audio_file
      audio_file=$(grep -o '"audioFile":"[^"]*"' "${tmp_out}" | sed 's/.*:"\(.*\)".*/\1/' || true)
      if [[ -n "${audio_file}" && -f "${audio_file}" ]]; then
        afplay "${audio_file}" 2>/dev/null || true
        if [[ "${JARVIS_AUTOSTART:-0}" == "1" ]]; then
          echo "${boot_id} ${now_ts}" >"${LAST_GREETING}"
        else
          echo "manual ${now_ts}" >"${LAST_GREETING}"
        fi
        log "[GREETING] ✅ Greeting played."
      else
        warn "[GREETING] audioFile not found."
      fi
    else
        warn "[GREETING] TTS skill failed."
    fi
    rm -f "${tmp_json}" "${tmp_out}"
  else
    log "[GREETING] No TTS (afplay or key missing)"
  fi
}

# ── Check child processes ──
check_child() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

# ═══════════════════════════════════════════════════════════════════════
#  ASOSIY SUPERVISOR LOOP
# ═══════════════════════════════════════════════════════════════════════

# 1) Start the gateway (if it is not running yet)
if ! gateway_healthy; then
  start_gateway
fi

# 2) Wait for the gateway to respond
if wait_gateway 60; then
  start_bot
  start_daemon
  start_monitor
  start_dashboard
  sleep 2
  ( sleep 3; open "http://localhost:7890" 2>/dev/null || true ) &
  greeting
  log "═══════════════════════════════════════════════════════════"
  log "🤖 JARVIS: ALL PROCESSES READY"
  log "═══════════════════════════════════════════════════════════"
else
  err "Gateway did not start; waiting for recovery before continuing..."
fi

# 3) Doimiy monitoring loop
CHECK_INTERVAL=15
GATEWAY_FAIL_COUNT=0
MAX_GW_FAIL=3
RESTART_WINDOW=300
RESTART_LIMIT=5
RESTART_COOLDOWN=120

# If a child keeps crashing, do not spawn copies every 15 seconds forever.
# For Bash 3.2 compatibility each component's state lives in plain dynamic
# variables (no associative arrays).
restart_allowed() {
  local name="$1" now_ts window_var count_var blocked_var window_start count blocked_until
  now_ts=$(date +%s)
  window_var="RESTART_WINDOW_$(echo "${name}" | tr -c 'a-zA-Z0-9' '_')"
  count_var="RESTART_COUNT_$(echo "${name}" | tr -c 'a-zA-Z0-9' '_')"
  blocked_var="RESTART_BLOCKED_$(echo "${name}" | tr -c 'a-zA-Z0-9' '_')"
  eval "window_start=\${${window_var}:-0}"
  eval "count=\${${count_var}:-0}"
  eval "blocked_until=\${${blocked_var}:-0}"

  if (( now_ts < blocked_until )); then return 1; fi
  if (( now_ts - window_start > RESTART_WINDOW )); then
    window_start=${now_ts}
    count=0
  fi
  count=$((count + 1))
  if (( count > RESTART_LIMIT )); then
    blocked_until=$((now_ts + RESTART_COOLDOWN))
    printf -v "${blocked_var}" '%s' "${blocked_until}"
    printf -v "${window_var}" '%s' "${now_ts}"
    printf -v "${count_var}" '%s' '0'
    err "[${name}] Crash loop stopped; ${RESTART_COOLDOWN}s cooldown."
    notify_component "${name}-crash-loop" "⚠️ JARVIS ${name}: paused for ${RESTART_COOLDOWN}s after a crash loop."
    return 1
  fi
  printf -v "${window_var}" '%s' "${window_start}"
  printf -v "${count_var}" '%s' "${count}"
  return 0
}

while true; do
  # ── Check the gateway (curl health) ──
  if ! gateway_healthy; then
    GATEWAY_FAIL_COUNT=$((GATEWAY_FAIL_COUNT + 1))
    warn "[GATEWAY] ❌ Health check failed (${GATEWAY_FAIL_COUNT}/${MAX_GW_FAIL})"

    if [[ ${GATEWAY_FAIL_COUNT} -ge ${MAX_GW_FAIL} ]]; then
      err "[GATEWAY] ${MAX_GW_FAIL} consecutive failures. Restarting..."
      restart_gateway
      if wait_gateway 60; then
        GATEWAY_FAIL_COUNT=0
        log "[GATEWAY] ✅ Qayta tiklandi."
      else
        warn "[GATEWAY] Restart failed too. Waiting for the next cycle..."
      fi
    fi
  else
    if [[ ${GATEWAY_FAIL_COUNT} -gt 0 ]]; then
      log "[GATEWAY] ✅ Healthy (recovered from earlier errors)"
    fi
    GATEWAY_FAIL_COUNT=0
  fi

  # ── Check the bot ──
  if [[ "${TELEGRAM_ENABLED}" != "1" ]] && validate_telegram; then
    log "[BOT] Network restored; enabling the Telegram bot..."
    TELEGRAM_ENABLED=1
  fi
  if [[ "${TELEGRAM_ENABLED}" == "1" ]] && ! check_child "${BOT_PID}"; then
    if restart_allowed BOT; then
      warn "[BOT] Stopped; restarting..."
      start_bot
    fi
  fi

  # ── Check the daemon ──
  if ! check_child "${DAEMON_PID}"; then
    if restart_allowed DAEMON; then
      warn "[DAEMON] Stopped; restarting..."
      start_daemon
    fi
  fi

  # ── Check the monitor ──
  if ! check_child "${MONITOR_PID}"; then
    if restart_allowed MONITOR; then
      warn "[MONITOR] Stopped; restarting..."
      start_monitor
    fi
  fi

  # ── Check the dashboard ──
  if dashboard_healthy; then
    # If a healthy dashboard survived a supervisor restart, adopt its real PID;
    # a stale PID must not cause endless restarts of a healthy service.
    if ! check_child "${DASHBOARD_PID}"; then
      DASHBOARD_PID=$(dashboard_pid_from_port)
      log "[DASHBOARD] Updated the healthy process PID: ${DASHBOARD_PID:-?}"
    fi
  else
    if restart_allowed DASHBOARD; then
      warn "[DASHBOARD] Stopped; restarting..."
      stop_dashboard
      start_dashboard
    fi
  fi

  sleep "${CHECK_INTERVAL}"
done
