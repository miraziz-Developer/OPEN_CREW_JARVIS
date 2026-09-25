#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# JARVIS — Mac uchun bitta buyruq bilan o'rnatish. Qayta ishga tushirish xavfsiz.
#
#   git clone https://github.com/miraziz-Developer/OPEN_CREW_JARVIS.git && cd OPEN_CREW_JARVIS
#   ./install.sh
#
# yoki repo'siz:  bash <(curl -fsSL https://raw.githubusercontent.com/miraziz-Developer/OPEN_CREW_JARVIS/main/install.sh)
#
# Bayroqlar:  --check         hech narsani o'zgartirmasdan mashinangizni tekshiradi
#             --reconfigure   barcha kalitlarni qayta so'raydi
#             --skip-workers  og'ir avtonom ishchilarni (BabyAGI, AutoGPT, brauzer) keyinga qoldiradi
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
G="\033[0;32m"; Y="\033[1;33m"; R="\033[0;31m"; B="\033[1m"; D="\033[2m"; N="\033[0m"
ok(){ echo -e "${G}✅ $1${N}"; }; warn(){ echo -e "${Y}⚠️  $1${N}"; }; die(){ echo -e "${R}❌ $1${N}"; exit 1; }
step(){ echo -e "\n${B}═══ $1 ═══${N}"; }
CHECK=false; RECONF=false; SKIP_WORKERS=false
for a in "$@"; do case "$a" in --check) CHECK=true;; --reconfigure) RECONF=true;; --skip-workers) SKIP_WORKERS=true;; -h|--help) sed -n 2,14p "$0" | sed 's/^# \{0,1\}//'; exit 0;; esac; done

[[ "$(uname -s)" == "Darwin" ]] || die "JARVIS hozircha faqat macOS uchun (mikrofon, ekran va iPhone boshqaruvi macOS'ga bog'liq)."
ARCH="$(uname -m)"; MACOS="$(sw_vers -productVersion)"; MAJOR="${MACOS%%.*}"
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
if [[ ! -t 0 ]] && ( : </dev/tty ) 2>/dev/null; then exec </dev/tty; fi   # curl | bash bo'lsa ham savollar ishlasin

# ── 0. Mashinani tekshirish ──
step "0/8 Mashinangiz tekshirilmoqda"
FREE_GB="$(df -g "$HOME" | awk 'NR==2{print $4}')"
echo -e "  macOS ${MACOS} · ${ARCH} · bo'sh joy ${FREE_GB} GB · papka: ${DIR}"
PROBLEMS=0
(( MAJOR >= 13 )) || { warn "macOS 13+ tavsiya etiladi (sizda ${MACOS})"; PROBLEMS=$((PROBLEMS+1)); }
(( FREE_GB >= 8 )) || { warn "Kamida ~8 GB bo'sh joy kerak (Python muhitlari, brauzer)"; PROBLEMS=$((PROBLEMS+1)); }
xcode-select -p >/dev/null 2>&1 || { warn "Xcode Command Line Tools yo'q — o'rnatiladi: xcode-select --install"; PROBLEMS=$((PROBLEMS+1)); }
command -v brew >/dev/null 2>&1 && echo "  Homebrew: $(brew --prefix)" || { warn "Homebrew yo'q — o'rnatuvchi so'raydi"; PROBLEMS=$((PROBLEMS+1)); }
command -v node >/dev/null 2>&1 && echo "  Node: $(node --version)" || warn "Node yo'q — Homebrew orqali o'rnatiladi"
[[ -f .env ]] && echo "  .env: bor" || echo "  .env: yo'q (o'rnatuvchi yaratadi va kalitlarni so'raydi)"
curl -fsS --max-time 6 -o /dev/null https://api.telegram.org && echo "  Internet: OK" || warn "Internet aloqasi yo'q yoki cheklangan"
if $CHECK; then echo -e "\n${B}--check tugadi${N}: ${PROBLEMS} ta ogohlantirish. Hech narsa o'zgartirilmadi."; exit 0; fi
(( PROBLEMS == 0 )) && ok "mashina tayyor"

# ── 1. Xcode CLT va Homebrew ──
step "1/8 Asosiy vositalar"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install 2>/dev/null || true
  die "Xcode Command Line Tools o'rnatilmoqda (oyna ochildi). Tugagach ./install.sh ni qayta ishga tushiring."
fi
if ! command -v brew >/dev/null 2>&1; then
  a="Y"; [[ -t 0 ]] && { read -r -p "Homebrew o'rnatilmagan. Hozir o'rnataymi? [Y/n] " a || a="Y"; }
  [[ "${a:-Y}" =~ ^[Yy]$ ]] || die "Homebrew kerak: https://brew.sh"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)" || { [[ -x /usr/local/bin/brew ]] && eval "$(/usr/local/bin/brew shellenv)"; }
fi
BREW_PREFIX="$(brew --prefix)"; export PATH="$BREW_PREFIX/bin:$PATH"

step "2/8 Dasturlar (Homebrew: node, python, sox, uv, yt-dlp, cliclick, whisper-cpp)"
# Faqat yetishmayotganini o'rnatamiz; mavjudlarini yangilamaymiz (ishlab turgan tizim buzilmasin).
# (brew bundle yangi Homebrew'da --no-lock ni qabul qilmaydi va sukut bo'yicha hammasini yangilaydi.)
BREW_FAILED=()
while read -r formula; do
  [[ -z "$formula" ]] && continue
  cmd="${formula%%@*}"; case "$formula" in python@*) cmd="python${formula#python@}";; whisper-cpp) cmd="whisper-cli";; esac
  if brew list --formula "$formula" >/dev/null 2>&1 || command -v "$cmd" >/dev/null 2>&1; then echo "  ✓ $formula"; continue; fi
  echo "  ⏳ $formula o'rnatilmoqda…"
  brew install "$formula" >/dev/null 2>&1 && echo "  ✓ $formula" || BREW_FAILED+=("$formula")
done < <(sed -n 's/^brew "\([^"]*\)".*/\1/p' Brewfile)
if ((${#BREW_FAILED[@]})); then warn "o'rnatilmadi: ${BREW_FAILED[*]} (qo'lda: brew install ${BREW_FAILED[*]})"; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || die "Node 22+ kerak (hozir $(node --version)): brew upgrade node"
command -v openclaw >/dev/null || { warn "openclaw o'rnatilmoqda"; npm install -g openclaw >/dev/null; }
ok "asosiy dasturlar"

step "3/8 Node paketlari"
npm ci --no-audit --no-fund >/dev/null && ok "npm ci"

# ── 4. Kalitlar ──
step "4/8 Kalitlar va sozlamalar"
echo -e "${D}Kalitlar faqat shu kompyuterdagi .env (0600) fayliga yoziladi, git'ga tushmaydi.${N}"
if $RECONF; then node scripts/setup-env.js --reconfigure; else node scripts/setup-env.js; fi || die "Kalitlar to'liq emas. .env ni to'ldirib, ./install.sh ni qayta ishga tushiring."
chmod 600 .env
set_env() { if grep -q "^$1=" .env; then sed -i '' "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
# Shu kompyuterga moslash: whisper wake zaxirasi
WBIN="$(command -v whisper-cli || true)"; WMODEL="$DIR/models/whisper/ggml-tiny.en.bin"
if [[ -n "$WBIN" ]]; then mkdir -p models/whisper; [[ -s "$WMODEL" ]] || curl -fsSL -o "$WMODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin || rm -f "$WMODEL"; fi
if [[ -n "$WBIN" && -s "$WMODEL" ]]; then set_env WHISPER_WAKE_ENABLED true; set_env WHISPER_WAKE_BINARY "$WBIN"; set_env WHISPER_WAKE_MODEL "$WMODEL"
else set_env WHISPER_WAKE_ENABLED false; warn "whisper.cpp modeli yo'q — zaxira wake o'chirildi (openWakeWord asosiy)"; fi

step "5/8 Wake-word ('Jarvis' chaqiruvi)"
[[ -x .venv-openwakeword/bin/python ]] || bash scripts/setup-openwakeword.sh >/dev/null 2>&1 || warn "openWakeWord o'rnatilmadi (STT zaxirasi ishlaydi)"
if [[ -f models/wake-word/jarvis.onnx ]]; then ok "shaxsiy 'Jarvis' modeli topildi"
else warn "Shaxsiy wake modeli yo'q — standart 'hey_jarvis' ishlaydi. Aniqroq bo'lishi uchun (ovozingizda o'qitiladi): npm run voice:wake-collect && npm run voice:wake-train"; fi

step "6/8 Avtonom ishchilar (BabyAGI, AutoGPT, Open Interpreter, Browser-use) va native aks-sado bekor qilish"
if $SKIP_WORKERS; then warn "--skip-workers: keyinroq bash scripts/install-workers.sh"; else bash scripts/install-workers.sh || warn "ishchilar to'liq o'rnatilmadi (ovoz ishlaydi, missiyalar cheklangan)"; fi
command -v swiftc >/dev/null && bash scripts/build-voice-io.sh >/dev/null && ok "jarvis-voice-io (aks-sado bekor qilish)" || warn "swiftc yo'q — aks-sado bekor qilish o'tkazib yuborildi"

step "7/8 Avtostart va xizmatlar (launchd)"
bash scripts/enable-autostart.sh >/dev/null && ok "launchd xizmatlari"
BK="$HOME/Library/LaunchAgents/com.jarvis.backup.plist"
node scripts/render-launchd.js scripts/com.jarvis.backup.plist "$BK" "$DIR" "$(command -v node)" && { launchctl bootout "gui/$(id -u)/com.jarvis.backup" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$BK" 2>/dev/null || true; }
bash scripts/restart-daemon.sh >/dev/null 2>&1 || warn "daemon ishga tushmadi: tail -f logs/daemon-*.log"

step "8/8 Tekshiruv"
sleep 12
npm run -s doctor || warn "doctor ogohlantirish berdi — yuqoridagini ko'ring"

# ── macOS ruxsatlari: Apple ularni faqat foydalanuvchi bera oladi ──
echo -e "\n${B}macOS ruxsatlari${N} (bir marta, faqat siz bera olasiz):\n  Mikrofon · Accessibility · Automation · Screen Recording — Terminal/node uchun"
a="n"; [[ -t 0 ]] && { read -r -p "Tegishli sozlama oynalarini hozir ochaymi? [Y/n] " a || a="n"; }
if [[ "${a:-Y}" =~ ^[Yy]$ ]]; then
  for pane in Privacy_Microphone Privacy_Accessibility Privacy_Automation Privacy_ScreenCapture; do open "x-apple.systempreferences:com.apple.preference.security?$pane" 2>/dev/null || true; sleep 1; done
fi

TG=""; grep -q "^TELEGRAM_BOT_TOKEN=." .env && grep -q "^TELEGRAM_OWNER_IDS=." .env || TG="\n  • Telegram: botingizga /start yozing — birinchi yozgan odam ega bo'lib juftlashadi"
cat <<MSG

🎉 ${B}JARVIS o'rnatildi.${N}  "Jarvis" deb chaqiring.

Endi:
  • Mikrofon ruxsatini bergach:  ./jarvis restart
  • Holat:  ./jarvis status   ·   npm run doctor   ·   Panel: http://localhost:7890${TG}
Ixtiyoriy:
  • Gmail/Calendar:   node scripts/google-oauth-setup.js
  • Chrome profilingiz: python3 scripts/chrome-profile-sync.py
  • Kalitlarni o'zgartirish: ./install.sh --reconfigure
To'liq qo'llanma: README.md
MSG
