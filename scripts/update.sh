#!/bin/bash
# JARVIS ni yangilash: yangi kod → bog'liqliklar → workspace sinxronlash → qayta ishga tushirish.
set -euo pipefail
cd "$(dirname "$0")/.."
G="\033[0;32m"; Y="\033[1;33m"; N="\033[0m"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo -e "${Y}⚠️  Lokal o'zgarishlar bor. Yangilashdan oldin ularni commit yoki stash qiling:${N}"; git status --short; exit 1
fi
BEFORE="$(git rev-parse --short HEAD)"
git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)"
AFTER="$(git rev-parse --short HEAD)"
[[ "$BEFORE" == "$AFTER" ]] && echo -e "${G}✅ Allaqachon yangi ($AFTER)${N}" || echo -e "${G}✅ $BEFORE → $AFTER${N}"
npm ci --no-audit --no-fund >/dev/null
bash scripts/install-workers.sh || echo -e "${Y}⚠️  ishchilar yangilanmadi${N}"
bash scripts/sync-workspace.sh >/dev/null || true
bash scripts/enable-autostart.sh >/dev/null || true
bash scripts/restart-daemon.sh >/dev/null 2>&1 || true
sleep 10
npm run -s doctor || true
echo -e "${G}🎉 Yangilandi.${N}"
