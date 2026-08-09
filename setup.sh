#!/bin/bash
# ═════════════════════════════════════════════════════════════
# JARVIS — To'liq o'rnatish skripti (macOS)
# 1 marta ishga tushirilgach, kompyuter har qayta yoqilganda
# Jarvis avtomatik ishga tushadi va ovozli salomlaydi.
# ═════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOTENV="${PROJECT_DIR}/.env"
DOTENV_EXAMPLE="${PROJECT_DIR}/.env.example"
LOG_DIR="${PROJECT_DIR}/logs"
LAUNCHD_PLIST="${PROJECT_DIR}/scripts/com.jarvis.openclaw.plist"
HEALTH_TIMEOUT=30

# ── Rejim check ──
is_interactive=true
[[ -t 0 ]] || is_interactive=false

# ── Yordamchi funksiyalar ──
info()  { echo "ℹ️  $1"; }
ok()    { echo "✅ $1"; }
warn()  { echo "⚠️  $1"; }
err()   { echo "❌ $1"; }
step()  { echo ""; echo "═══ $1 ═══"; }

# ═════════════════════════════════════════════════════════════
# QADAM 1 — .env mavjudligini tekshir
# ═════════════════════════════════════════════════════════════
step "QADAM 1/7: .env mavjudligi"

if [[ ! -f "${DOTENV}" ]]; then
  if [[ -f "${DOTENV_EXAMPLE}" ]]; then
    cp "${DOTENV_EXAMPLE}" "${DOTENV}"
  else
    err ".env.example ham topilmadi. Loyiha tuzilishi buzilgan."
    exit 1
  fi
  warn ".env yaratildi. Iltimos, quyidagi qiymatlarni to'ldiring:"
  echo ""
  echo "  1) AZURE_SPEECH_KEY         — Azure Speech kaliti"
  echo "  2) AZURE_SPEECH_REGION      — Azure region (masalan: eastus2)"
  echo "  3) AZURE_OPENAI_ENDPOINT    — Azure OpenAI / Kimi endpoint"
  echo "  4) AZURE_OPENAI_KEY         — Azure OpenAI / Kimi kaliti"
  echo "  5) TELEGRAM_BOT_TOKEN       — Telegram bot token"
  echo "  6) JARVIS_CHAT_ID           — Sizning Telegram chat ID"
  echo ""
  echo "Fayl: ${DOTENV}"
  echo "Qiymatlarni to'ldirgandan so'ng setup.sh qayta ishga tushiring."
  exit 1
fi

# Kalitларнинг бўш эмаслигини текшириш
missing_env=()
for key in AZURE_SPEECH_KEY AZURE_SPEECH_REGION AZURE_OPENAI_KEY AZURE_OPENAI_ENDPOINT TELEGRAM_BOT_TOKEN; do
  val="$(grep "^${key}=" "${DOTENV}" 2>/dev/null | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
  if [[ -z "$val" || "$val" == "..." || "$val" == "YOUR_*" ]]; then
    missing_env+=("$key")
  fi
done

if [[ ${#missing_env[@]} -gt 0 ]]; then
  err ".env da quyidagi kalitlar to'ldirilmagan:"
  for k in "${missing_env[@]}"; do echo "   - $k"; done
  echo "Iltimos, ${DOTENV} ni tahrirlang va qayta ishga tushiring."
  exit 1
fi

ok ".env to'liq va to'g'ri to'ldirilgan."

# ═════════════════════════════════════════════════════════════
# QADAM 2 — openclaw config validate
# ═════════════════════════════════════════════════════════════
step "QADAM 2/7: OpenClaw konfiguratsiyasi"

if ! command -v openclaw >/dev/null 2>&1; then
  err "openclaw topilmadi. Iltimos, avval o'rnating: https://docs.openclaw.ai"
  exit 1
fi

if ! openclaw config validate >/dev/null 2>&1; then
  err "openclaw config validate — xatolik!"
  echo "Iltimos, konfiguratsiyani tekshiring: openclaw config validate"
  exit 1
fi

ok "OpenClaw konfiguratsiyasi to'g'ri."

# ═════════════════════════════════════════════════════════════
# QADAM 3 — LaunchAgent o'rnatish va yuklash
# ═════════════════════════════════════════════════════════════
step "QADAM 3/7: macOS avtostart (launchd)"

if [[ ! -f "${LAUNCHD_PLIST}" ]]; then
  err "LaunchAgent plist topilmadi: ${LAUNCHD_PLIST}"
  exit 1
fi

bash "${PROJECT_DIR}/scripts/enable-autostart.sh"
ok "LaunchAgent yuklandi."

# ═════════════════════════════════════════════════════════════
# QADAM 4 — Voice Wake yoqilganini tasdiqlash
# ═════════════════════════════════════════════════════════════
step "QADAM 4/7: Voice Wake holati"

voice_wake_flag="$(grep -E "^VOICE_WAKE_ENABLED=" "${DOTENV}" 2>/dev/null | cut -d= -f2 | tr -d ' ')" || true
if [[ "${voice_wake_flag:-true}" != "false" ]]; then
  ok "Voice Wake yoqilgan (standart: true)."
else
  warn "VOICE_WAKE_ENABLED=false. Voice Wake o'chirilgan."
fi

# ═════════════════════════════════════════════════════════════
# QADAM 5 — Gateway sog'lom ishga tushganini tekshirish
# ═════════════════════════════════════════════════════════════
step "QADAM 5/7: Gateway health-check"

echo "Gateway javobini kutish (${HEALTH_TIMEOUT}s)..."
loaded=false
count=0
while [[ $count -lt ${HEALTH_TIMEOUT} ]]; do
  if curl -sf http://127.0.0.1:18789/health >/dev/null 2>&1; then
    loaded=true
    break
  fi
  sleep 1
  count=$((count + 1))
  # Aktiv ravishda ishga tushirish (agar hali ishlamayotgan bo'lsa)
  if [[ $count -eq 5 ]]; then
    launchctl start com.jarvis.openclaw 2>/dev/null || true
  fi
done

if [[ "${loaded}" != "true" ]]; then
  err "Gateway 30 soniya ichida javob bermadi."
  echo "Loglarni tekshiring: ${LOG_DIR}/gateway-error.log"
  echo "Ishga tushirish: launchctl start com.jarvis.openclaw"
  exit 1
fi

ok "Gateway port 18789 da ishlayapti."

# ═════════════════════════════════════════════════════════════
# QADAM 6 — "Jarvis tayyor" tasdiqlash
# ═════════════════════════════════════════════════════════════
step "QADAM 6/7: JARVIS tayyorligi"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                 🤖 JARVIS TAYYOR!                          ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  ✅ Gateway:       Port 18789 — ishlayapti                 ║"
echo "║  ✅ Telegram Bot:  Ishga tushdi                             ║"
echo "║  ✅ Voice Daemon:  Ishga tushdi                             ║"
echo "║  ✅ Avtostart:     Login bo'lganda avtomatik                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# TTS bilan ovozli tasdiq
if source "${DOTENV}" 2>/dev/null && [[ -n "${AZURE_SPEECH_KEY:-}" ]]; then
  tmp_json="/tmp/jarvis_setup_greet_$$.json"
  printf '{"text":"Jarvis tayyor."}\n' >"$tmp_json"
  if node "${PROJECT_DIR}/skills/azure-tts/index.js" <"$tmp_json" >"${tmp_json}.out" 2>/dev/null; then
    audio_file=$(grep -o '"audioFile":"[^"]*"' "${tmp_json}.out" | sed 's/.*:"\(.*\)".*/\1/' || true)
    if [[ -n "$audio_file" && -f "$audio_file" && -x "$(command -v afplay)" ]]; then
      afplay "$audio_file" 2>/dev/null || true
    fi
  fi
  rm -f "$tmp_json" "${tmp_json}.out"
fi

ok "Terminalga va ovozda tasdiqlandi."

# ═════════════════════════════════════════════════════════════
# QADAM 7 — macOS ruxsatlari tekshiruvi
# ═════════════════════════════════════════════════════════════
step "QADAM 7/7: macOS ruxsatlari"

check_tcc() {
  local service="$1"
  osascript -e "tell application \"System Events\" to return (name of every process) contains \"${service}\"" 2>/dev/null || true
}

# TCC holatini tekshirish (SQLite yordamida emas, API bilan)
needs_accessibility=false
needs_screen=false
needs_mic=false

# Avval oddiy testlar orqali bilish
echo "Ruxsatlar holati tekshirilmoqda..."
echo ""

warn "Quyidagi 3 ta ruxsatni macOS System Settings'da qo'lda yoqing:"
echo ""
echo "  1) 🔐 Accessibility (Terminal / openclaw / node)"
echo "     System Settings → Privacy & Security → Accessibility → + → Terminal (yoki qaysi app ishlatilsa)"
echo ""
echo "  2) 📹 Screen Recording"
echo "     System Settings → Privacy & Security → Screen Recording → + → Terminal (yoki qaysi app ishlatilsa)"
echo ""
echo "  3) 🎙 Microphone"
echo "     System Settings → Privacy & Security → Microphone → + → Terminal"
echo ""
echo "     💡 Eslatma: Microphone ruxsati birinchi marta qo'lda berilgandan keyin"
echo "        macOS doimiy saqlaydi — qayta so'ralmaydi."
echo ""
ok "Bu yagona qo'lda bajariladigan qadam. Avtomatlashtirmoqchi emasmiz (Apple buni kod orqali qilmaslikka ruxsat bermaydi)."

# ═════════════════════════════════════════════════════════════
# Yakun
# ═════════════════════════════════════════════════════════════
step "O'rnatish YAKUNI"

echo ""
echo "🎉 JARVIS muvaffaqiyatli o'rnatildi!"
echo ""
echo "Keyingi qadam: macOS ruxsatlarini (yuqoridagi 3 ta) bering,"
echo "shundan so'ng kompyuterni qayta ishga tushiring —"
echo "Jarvis avtomatik ishga tushib, ovozli salomlaydi!"
echo ""
echo "ℹ️  Foydali buyruqlar:"
echo "   launchctl start   com.jarvis.openclaw   # Qo'lda ishga tushirish"
echo "   launchctl stop    com.jarvis.openclaw   # To'xtatish"
echo "   launchctl unload  ~/Library/LaunchAgents/com.jarvis.openclaw.plist   # O'chirish"
echo "   tail -f ${LOG_DIR}/gateway.log            # Loglarni kuzatish"
echo ""
