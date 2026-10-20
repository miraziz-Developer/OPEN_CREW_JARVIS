#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# JARVIS: one-command install for macOS. Safe to re-run.
#
#   git clone https://github.com/miraziz-Developer/OPEN_CREW_JARVIS.git && cd OPEN_CREW_JARVIS
#   ./install.sh
#
# or without cloning:  bash <(curl -fsSL https://raw.githubusercontent.com/miraziz-Developer/OPEN_CREW_JARVIS/main/install.sh)
#
# Flags:  --check         check this Mac without changing anything
#         --reconfigure   ask for every key again
#         --skip-workers  defer the heavy autonomous workers (BabyAGI, AutoGPT, browser)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
G=$'\033[0;32m'; Y=$'\033[1;33m'; R=$'\033[0;31m'; B=$'\033[1m'; D=$'\033[2m'; N=$'\033[0m'
ok(){ echo -e "${G}✅ $1${N}"; }; warn(){ echo -e "${Y}⚠️  $1${N}"; }; die(){ echo -e "${R}❌ $1${N}"; exit 1; }
step(){ echo -e "\n${B}═══ $1 ═══${N}"; }
CHECK=false; RECONF=false; SKIP_WORKERS=false
for a in "$@"; do case "$a" in --check) CHECK=true;; --reconfigure) RECONF=true;; --skip-workers) SKIP_WORKERS=true;; -h|--help) sed -n 2,14p "$0" | sed 's/^# \{0,1\}//'; exit 0;; esac; done

[[ "$(uname -s)" == "Darwin" ]] || die "JARVIS currently supports macOS only (microphone, screen and iPhone control depend on it)."
ARCH="$(uname -m)"; MACOS="$(sw_vers -productVersion)"; MAJOR="${MACOS%%.*}"
REPO_URL="${JARVIS_REPO_URL:-https://github.com/miraziz-Developer/OPEN_CREW_JARVIS.git}"

# ── Where are we: inside the repo or in an empty directory ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/package.json" && -d "$SCRIPT_DIR/skills" ]]; then
  DIR="$SCRIPT_DIR"
else
  DIR="${JARVIS_INSTALL_DIR:-$HOME/OPEN_CREW_JARVIS}"
  step "Yuklab olish → $DIR"
  command -v git >/dev/null || die "git is required: xcode-select --install"
  if [[ -d "$DIR/.git" ]]; then git -C "$DIR" pull --ff-only origin main; else git clone "$REPO_URL" "$DIR"; fi
fi
cd "$DIR"
if [[ ! -t 0 ]] && ( : </dev/tty ) 2>/dev/null; then exec </dev/tty; fi   # keep prompts working even with curl | bash

# ── 0. Check the machine ──
step "0/8 Checking your Mac"
FREE_GB="$(df -g "$HOME" | awk 'NR==2{print $4}')"
echo -e "  macOS ${MACOS} · ${ARCH} · free space ${FREE_GB} GB · folder: ${DIR}"
PROBLEMS=0
(( MAJOR >= 13 )) || { warn "macOS 13+ tavsiya etiladi (sizda ${MACOS})"; PROBLEMS=$((PROBLEMS+1)); }
(( FREE_GB >= 8 )) || { warn "At least ~8 GB of free space is needed (Python environments, browser)"; PROBLEMS=$((PROBLEMS+1)); }
xcode-select -p >/dev/null 2>&1 || { warn "Xcode Command Line Tools missing; they will be installed: xcode-select --install"; PROBLEMS=$((PROBLEMS+1)); }
command -v brew >/dev/null 2>&1 && echo "  Homebrew: $(brew --prefix)" || { warn "Homebrew missing; the installer will ask"; PROBLEMS=$((PROBLEMS+1)); }
command -v node >/dev/null 2>&1 && echo "  Node: $(node --version)" || warn "Node missing; it will be installed via Homebrew"
[[ -f .env ]] && echo "  .env: present" || echo "  .env: missing (the installer creates it and asks for keys)"
curl -fsS --max-time 6 -o /dev/null https://api.telegram.org && echo "  Internet: OK" || warn "No or restricted internet connection"
if $CHECK; then echo -e "\n${B}--check finished${N}: ${PROBLEMS} warning(s). Nothing was changed."; exit 0; fi
(( PROBLEMS == 0 )) && ok "machine ready"

# ── 1. Xcode CLT and Homebrew ──
step "1/8 Asosiy vositalar"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install 2>/dev/null || true
  die "Installing the Xcode Command Line Tools (a window opened). Re-run ./install.sh when it finishes."
fi
if ! command -v brew >/dev/null 2>&1; then
  a="Y"; [[ -t 0 ]] && { read -r -p "Homebrew is not installed. Install it now? [Y/n] " a || a="Y"; }
  [[ "${a:-Y}" =~ ^[Yy]$ ]] || die "Homebrew is required: https://brew.sh"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)" || { [[ -x /usr/local/bin/brew ]] && eval "$(/usr/local/bin/brew shellenv)"; }
fi
BREW_PREFIX="$(brew --prefix)"; export PATH="$BREW_PREFIX/bin:$PATH"

step "2/8 Tools (Homebrew: node, python, sox, uv, yt-dlp, cliclick, whisper-cpp)"
# Install only what is missing; never upgrade what exists (do not break a working system).
# (brew bundle no longer accepts --no-lock and upgrades everything by default.)
BREW_FAILED=()
while read -r formula; do
  [[ -z "$formula" ]] && continue
  cmd="${formula%%@*}"; case "$formula" in python@*) cmd="python${formula#python@}";; whisper-cpp) cmd="whisper-cli";; esac
  if brew list --formula "$formula" >/dev/null 2>&1 || command -v "$cmd" >/dev/null 2>&1; then echo "  ✓ $formula"; continue; fi
  echo "  ⏳ installing $formula…"
  brew install "$formula" >/dev/null 2>&1 && echo "  ✓ $formula" || BREW_FAILED+=("$formula")
done < <(sed -n 's/^brew "\([^"]*\)".*/\1/p' Brewfile)
if ((${#BREW_FAILED[@]})); then warn "not installed: ${BREW_FAILED[*]} (manually: brew install ${BREW_FAILED[*]})"; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || die "Node 22+ is required (found $(node --version)): brew upgrade node"
command -v openclaw >/dev/null || { warn "installing openclaw"; npm install -g openclaw >/dev/null; }
ok "core tools"

step "3/8 Node packages"
npm ci --no-audit --no-fund >/dev/null && ok "npm ci"

# ── 4. Keys ──
step "4/8 Keys and settings"
echo -e "${D}Keys are written only to .env (0600) on this Mac and never reach git.${N}"
if $RECONF; then node scripts/setup-env.js --reconfigure; else node scripts/setup-env.js; fi || die "Keys are incomplete. Fill in .env and re-run ./install.sh."
chmod 600 .env
set_env() { if grep -q "^$1=" .env; then sed -i '' "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
# Adapt to this Mac: optional whisper wake fallback
WBIN="$(command -v whisper-cli || true)"; WMODEL="$DIR/models/whisper/ggml-tiny.en.bin"
if [[ -n "$WBIN" ]]; then mkdir -p models/whisper; [[ -s "$WMODEL" ]] || curl -fsSL -o "$WMODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin || rm -f "$WMODEL"; fi
if [[ -n "$WBIN" && -s "$WMODEL" ]]; then set_env WHISPER_WAKE_ENABLED true; set_env WHISPER_WAKE_BINARY "$WBIN"; set_env WHISPER_WAKE_MODEL "$WMODEL"
else set_env WHISPER_WAKE_ENABLED false; warn "no whisper.cpp model; wake fallback disabled (openWakeWord is primary)"; fi

step "5/8 Wake word (saying 'Jarvis')"
[[ -x .venv-openwakeword/bin/python ]] || bash scripts/setup-openwakeword.sh >/dev/null 2>&1 || warn "openWakeWord not installed (the STT fallback still works)"
if [[ -f models/wake-word/jarvis.onnx ]]; then ok "personal 'Jarvis' wake model found"
else warn "No personal wake model; the built-in 'hey_jarvis' is used. For better accuracy, train it on your voice: npm run voice:wake-collect && npm run voice:wake-train"; fi

step "6/8 Autonomous workers (BabyAGI, AutoGPT, Open Interpreter, Browser-use) and native echo cancellation"
if $SKIP_WORKERS; then warn "--skip-workers: run bash scripts/install-workers.sh later"; else bash scripts/install-workers.sh || warn "workers not fully installed (voice works; missions use the available workers only)"; fi
command -v swiftc >/dev/null && bash scripts/build-voice-io.sh >/dev/null && ok "jarvis-voice-io (echo cancellation)" || warn "no swiftc; echo cancellation skipped"

step "7/8 Autostart and services (launchd)"
bash scripts/enable-autostart.sh >/dev/null && ok "launchd services"
BK="$HOME/Library/LaunchAgents/com.jarvis.backup.plist"
node scripts/render-launchd.js scripts/com.jarvis.backup.plist "$BK" "$DIR" "$(command -v node)" && { launchctl bootout "gui/$(id -u)/com.jarvis.backup" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$BK" 2>/dev/null || true; }
bash scripts/restart-daemon.sh >/dev/null 2>&1 || warn "daemon did not start: tail -f logs/daemon-*.log"

step "8/8 Verification"
sleep 12
npm run -s doctor || warn "doctor reported warnings; see above"

# ── macOS permissions: Apple lets only the user grant these ──
echo -e "\n${B}macOS permissions${N} (one time, only you can grant them):\n  Microphone · Accessibility · Automation · Screen Recording — for Terminal/node"
a="n"; [[ -t 0 ]] && { read -r -p "Open the relevant settings panes now? [Y/n] " a || a="n"; }
if [[ "${a:-Y}" =~ ^[Yy]$ ]]; then
  for pane in Privacy_Microphone Privacy_Accessibility Privacy_Automation Privacy_ScreenCapture; do open "x-apple.systempreferences:com.apple.preference.security?$pane" 2>/dev/null || true; sleep 1; done
fi

TG=""; grep -q "^TELEGRAM_BOT_TOKEN=." .env && grep -q "^TELEGRAM_OWNER_IDS=." .env || TG="\n  • Telegram: send /pair <code> to your bot (the code is in .run/telegram-pair-code.json)"
cat <<MSG

🎉 ${B}JARVIS is installed.${N}  Say "Jarvis".

Next:
  • After granting the microphone permission:  ./jarvis restart
  • Status:  ./jarvis status   ·   npm run doctor   ·   Dashboard: http://localhost:7890${TG}
Optional:
  • Gmail/Calendar:   node scripts/google-oauth-setup.js
  • Your Chrome profile: python3 scripts/chrome-profile-sync.py
  • Change keys: ./install.sh --reconfigure
Full guide: README.md
MSG
