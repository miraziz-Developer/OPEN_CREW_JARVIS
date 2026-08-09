#!/bin/bash
# JARVIS — 1-Click Install & Run (macOS)
#
set -euo pipefail
GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; NC="\033[0m"
ok()  { echo -e "${GREEN}✅ $1${NC}"; }; warn(){ echo -e "${YELLOW}⚠️  $1${NC}"; }; err() { echo -e "${RED}❌ $1${NC}"; exit 1; }
DIR="${HOME}/OPEN_CREW_JARVIS"
echo ""
echo "🤖 JARVIS 1-CLICK INSTALLER"
echo ""
if ! command -v gh >/dev/null 2>&1; then warn "gh topilmadi. brew install gh"; exit 1; fi
if ! gh auth status >/dev/null 2>&1; then warn "Login: gh auth login"; exit 1; fi
if [[ -d "${DIR}/.git" ]]; then ok "Yangilanyapti..."; cd "${DIR}" && git pull origin main; else ok "Clone..."; gh repo clone miraziz-Developer/OPEN_CREW_JARVIS "${DIR}"; fi
cd "${DIR}"
if ! command -v sox >/dev/null 2>&1; then brew install sox || true; fi
if ! command -v node >/dev/null 2>&1; then warn "Node.js kerak: brew install node"; exit 1; fi
ok "npm install..."; npm install 2>/dev/null || true
for s in skills/azure-stt skills/azure-tts; do [[ -f "$s/package.json" ]] && (cd "$s" && npm install 2>/dev/null || true); done
if [[ ! -f "${DIR}/.env" ]]; then cp "${DIR}/.env.example" "${DIR}/.env"; warn ".env yaratildi. Tahrirlang va qayta ishga tushiring:\n  nano ${DIR}/.env\n  bash ${DIR}/install.sh"; exit 0; fi
bash "${DIR}/scripts/enable-autostart.sh" 2>/dev/null || true
bash "${DIR}/scripts/restart-daemon.sh"
echo ""
echo "🎉 JARVIS ISHLAYAPTI!"
echo "  tail -f ${DIR}/logs/daemon-\$(date +%Y%m%d).log"
