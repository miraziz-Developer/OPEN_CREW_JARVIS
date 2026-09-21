#!/bin/bash
# JARVIS — bitta buyruq bilan o'rnatish (macOS). Qayta ishga tushirsa xavfsiz (idempotent).
#
#   curl -fsSL https://raw.githubusercontent.com/miraziz-Developer/OPEN_CREW_JARVIS/main/install.sh | bash
#   yoki repo ichida:  bash install.sh
set -euo pipefail
G="\033[0;32m"; Y="\033[1;33m"; R="\033[0;31m"; N="\033[0m"
ok(){ echo -e "${G}✅ $1${N}"; }; warn(){ echo -e "${Y}⚠️  $1${N}"; }; die(){ echo -e "${R}❌ $1${N}"; exit 1; }
step(){ echo -e "\n═══ $1 ═══"; }

[[ "$(uname)" == "Darwin" ]] || die "JARVIS hozircha faqat macOS uchun"
REPO_URL="${JARVIS_REPO_URL:-https://github.com/miraziz-Developer/OPEN_CREW_JARVIS.git}"

# ── Qayerdamiz: repo ichida yoki bo'sh joyda ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/package.json" && -d "$SCRIPT_DIR/skills" ]]; then
  DIR="$SCRIPT_DIR"
else
  DIR="${JARVIS_INSTALL_DIR:-$HOME/OPEN_CREW_JARVIS}"
  step "Yuklab olish → $DIR"
  command -v git >/dev/null || die "git kerak: xcode-select --install"
  if [[ -d "$DIR/.git" ]]; then git -C "$DIR" pull --ff-only origin main; else git clone "$REPO_URL" "$DIR"; fi
fi
cd "$DIR"

step "1/8 Dasturlar (Homebrew)"
command -v brew >/dev/null || die "Homebrew kerak: https://brew.sh"
brew bundle --file=Brewfile --no-lock >/dev/null 2>&1 || brew bundle --file=Brewfile --no-lock || warn "ba'zi brew paketlari o'rnatilmadi"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || die "Node 22+ kerak (hozir $(node --version)): brew upgrade node"
command -v openclaw >/dev/null || { warn "openclaw o'rnatilmoqda"; npm install -g openclaw >/dev/null; }
command -v swiftc >/dev/null || warn "Xcode Command Line Tools yo'q (native AEC uchun): xcode-select --install"
ok "asosiy dasturlar"

step "2/8 Node paketlari"
npm ci --no-audit --no-fund >/dev/null && ok "npm ci"

step "3/8 Sozlamalar (.env)"
node scripts/setup-env.js || warn ".env ni to'ldiring (nano .env), keyin bu skriptni qayta ishga tushiring"
touch -a .env; chmod 600 .env
# Aniqlangan yo'llarni .env ga yozamiz (qayta ishga tushirsa ham xavfsiz)
set_env() { if grep -q "^$1=" .env; then sed -i '' "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
WBIN="$(command -v whisper-cli || true)"
WMODEL="$DIR/models/whisper/ggml-tiny.en.bin"
if [[ -n "$WBIN" ]]; then
  mkdir -p models/whisper
  [[ -s "$WMODEL" ]] || curl -fsSL -o "$WMODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin || rm -f "$WMODEL"
fi
if [[ -n "$WBIN" && -s "$WMODEL" ]]; then set_env WHISPER_WAKE_ENABLED true; set_env WHISPER_WAKE_BINARY "$WBIN"; set_env WHISPER_WAKE_MODEL "$WMODEL"
else set_env WHISPER_WAKE_ENABLED false; warn "whisper.cpp modeli yo'q — zaxira wake o'chirildi (openWakeWord asosiy)"; fi

step "4/8 Wake-word (openWakeWord)"
[[ -x .venv-openwakeword/bin/python ]] || bash scripts/setup-openwakeword.sh >/dev/null 2>&1 || warn "openWakeWord o'rnatilmadi (STT zaxira ishlaydi)"
if [[ -f models/wake-word/jarvis.onnx ]]; then ok "shaxsiy 'Jarvis' modeli topildi"
else warn "Shaxsiy wake model yo'q — standart 'hey_jarvis' ishlaydi. Aniqroq bo'lishi uchun: npm run voice:wake-collect && npm run voice:wake-train"; fi

step "5/8 Avtonom ishchilar (BabyAGI, AutoGPT, Interpreter, Browser)"
bash scripts/install-workers.sh || warn "ishchilar to'liq o'rnatilmadi (ovoz ishlaydi, missiyalar cheklangan)"

step "6/8 Native aks-sado bekor qilish"
command -v swiftc >/dev/null && bash scripts/build-voice-io.sh >/dev/null && ok "jarvis-voice-io" || warn "o'tkazib yuborildi"

step "7/8 Avtostart va xizmatlar"
bash scripts/enable-autostart.sh >/dev/null && ok "launchd xizmatlari"
BK="$HOME/Library/LaunchAgents/com.jarvis.backup.plist"
node scripts/render-launchd.js scripts/com.jarvis.backup.plist "$BK" "$DIR" "$(command -v node)" && { launchctl bootout "gui/$(id -u)/com.jarvis.backup" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$BK" 2>/dev/null || true; }
bash scripts/restart-daemon.sh >/dev/null 2>&1 || warn "daemon ishga tushmadi: tail -f logs/daemon-*.log"

step "8/8 Tekshiruv"
sleep 12
npm run -s doctor || warn "doctor ogohlantirish berdi — yuqoridagini ko'ring"

cat <<MSG

🎉 JARVIS o'rnatildi.  "Jarvis" deb chaqiring.

Bir marta qo'lda (macOS ruxsatlari): Tizim sozlamalari → Maxfiylik va xavfsizlik →
  Mikrofon, Accessibility, Automation, Screen Recording — Terminal/Node uchun ruxsat bering.
Ixtiyoriy:
  • Gmail/Calendar:  node scripts/google-oauth-setup.js --client-file ~/Downloads/client_secret_….json
  • Telegram:        botga /start yuboring (egasi bog'lanadi)
  • Chrome profili:  python3 scripts/chrome-profile-sync.py
Loglar: tail -f $DIR/logs/daemon-\$(date +%Y%m%d).log      Holat: npm run doctor
MSG
