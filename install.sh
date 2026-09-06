#!/bin/bash
# JARVIS — 1-Click Install & Run (macOS)
#
set -euo pipefail
GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; NC="\033[0m"
ok()  { echo -e "${GREEN}✅ $1${NC}"; }; warn(){ echo -e "${YELLOW}⚠️  $1${NC}"; }; err() { echo -e "${RED}❌ $1${NC}"; exit 1; }
DIR="${JARVIS_INSTALL_DIR:-${HOME}/OPEN_CREW_JARVIS}"
echo ""
echo "🤖 JARVIS 1-CLICK INSTALLER"
echo ""
if ! command -v gh >/dev/null 2>&1; then warn "gh topilmadi. brew install gh"; exit 1; fi
if ! gh auth status >/dev/null 2>&1; then warn "Login: gh auth login"; exit 1; fi
if [[ -d "${DIR}/.git" ]]; then ok "Yangilanyapti..."; cd "${DIR}" && git pull origin main; else ok "Clone..."; gh repo clone miraziz-Developer/OPEN_CREW_JARVIS "${DIR}"; fi
cd "${DIR}"
if ! command -v sox >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || err "sox topilmadi va Homebrew o'rnatilmagan"
  brew install sox
fi
if ! command -v node >/dev/null 2>&1; then warn "Node.js kerak: brew install node"; exit 1; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || err "Node 22+ kerak; joriy versiya: $(node --version)"
ok "npm ci..."; npm ci --no-audit --no-fund
npm run deps:check
if [[ ! -f "${DIR}/.env" ]]; then cp "${DIR}/.env.example" "${DIR}/.env"; warn ".env yaratildi. Tahrirlang va qayta ishga tushiring:\n  nano ${DIR}/.env\n  bash ${DIR}/install.sh"; exit 0; fi
bash "${DIR}/scripts/enable-autostart.sh"
bash "${DIR}/scripts/restart-daemon.sh"
echo ""
echo "🎉 JARVIS ISHLAYAPTI!"
echo "  tail -f ${DIR}/logs/daemon-\$(date +%Y%m%d).log"
