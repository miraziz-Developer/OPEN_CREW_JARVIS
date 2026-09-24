#!/usr/bin/env bash
# JARVIS — server (Docker) o'rnatish va boshqarish. Bitta buyruq:
#
#     ./server.sh            # o'rnatadi + ishga tushiradi (birinchi marta .env ni to'ldirishni so'raydi)
#     ./server.sh status     # holat
#     ./server.sh logs       # jonli loglar
#     ./server.sh restart    # qayta ishga tushirish (.env o'zgargandan keyin)
#     ./server.sh update     # git pull + qayta qurish + ishga tushirish
#     ./server.sh stop       # to'xtatish
#     ./server.sh shell      # konteyner ichiga kirish
#
# Server rejimida: Telegram bot, avtonom missiyalar/agentlar, dashboard, ertalabki brifing.
# Mikrofon, "Jarvis" chaqiruvi, ekran va iPhone boshqaruvi faqat Mac'da ishlaydi.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

G="\033[0;32m"; Y="\033[1;33m"; R="\033[0;31m"; B="\033[1m"; N="\033[0m"
ok()   { echo -e "${G}✅ $*${N}"; }
warn() { echo -e "${Y}⚠️  $*${N}"; }
die()  { echo -e "${R}❌ $*${N}" >&2; exit 1; }
step() { echo -e "\n${B}═══ $* ═══${N}"; }

ASSUME_YES=false
for a in "$@"; do [[ "$a" == "-y" || "$a" == "--yes" ]] && ASSUME_YES=true; done
CMD="${1:-up}"; [[ "$CMD" == "-y" || "$CMD" == "--yes" ]] && CMD="up"

# Sozlash kerak bo'lgan kalitlar (bo'sh bo'lsa ishga tushmaydi)
REQUIRED_KEYS=(AZURE_OPENAI_ENDPOINT AZURE_OPENAI_KEY TELEGRAM_BOT_TOKEN)

env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^["'\'']//;s/["'\'']$//'; }
set_env()   { if grep -q "^$1=" .env; then sed -i.bak "s#^$1=.*#$1=$2#" .env && rm -f .env.bak; else echo "$1=$2" >> .env; fi; }

# ── 1. Docker ────────────────────────────────────────────────
DOCKER=(docker)
ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    [[ "$(uname -s)" == "Linux" ]] || die "Docker topilmadi. Docker Desktop yoki Colima o'rnating: https://docs.docker.com/get-docker/"
    warn "Docker o'rnatilmagan."
    if ! $ASSUME_YES; then read -r -p "Docker'ni avtomatik o'rnataymi (get.docker.com, sudo kerak)? [Y/n] " a; [[ "${a:-Y}" =~ ^[Yy]$ ]] || die "Docker kerak."; fi
    command -v curl >/dev/null || die "curl kerak"
    curl -fsSL https://get.docker.com | sh || die "Docker o'rnatilmadi"
    if [[ $EUID -ne 0 ]] && command -v sudo >/dev/null; then sudo usermod -aG docker "$USER" 2>/dev/null || true; fi
    command -v systemctl >/dev/null && sudo systemctl enable --now docker 2>/dev/null || true
    ok "Docker o'rnatildi"
  fi
  if ! docker info >/dev/null 2>&1; then
    if command -v sudo >/dev/null && sudo -n docker info >/dev/null 2>&1; then DOCKER=(sudo docker)
    elif [[ "$(uname -s)" == "Darwin" ]] && command -v colima >/dev/null; then warn "Colima ishga tushirilmoqda…"; colima start --cpu 4 --memory 6 --disk 40; 
    else die "Docker daemon javob bermayapti (ruxsat yoki xizmat to'xtagan). Sinab ko'ring: sudo systemctl start docker"; fi
  fi
  "${DOCKER[@]}" compose version >/dev/null 2>&1 || die "'docker compose' plagini kerak: https://docs.docker.com/compose/install/"
}
compose() { "${DOCKER[@]}" compose "$@"; }

# ── 2. .env ─────────────────────────────────────────────────
ensure_env() {
  if [[ ! -f .env ]]; then
    cp .env.example .env; chmod 600 .env
    set_env OPENCLAW_GATEWAY_TOKEN "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    ok ".env yaratildi (gateway tokeni avtomatik)"
  fi
  chmod 600 .env 2>/dev/null || true
  [[ -n "$(env_value OPENCLAW_GATEWAY_TOKEN)" ]] || { set_env OPENCLAW_GATEWAY_TOKEN "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"; ok "OPENCLAW_GATEWAY_TOKEN yaratildi"; }
  [[ -n "$(env_value TELEGRAM_CHAT_ID)" || -z "$(env_value TELEGRAM_OWNER_IDS)" ]] || set_env TELEGRAM_CHAT_ID "$(env_value TELEGRAM_OWNER_IDS | cut -d, -f1 | tr -d ' ')"
  set_env JARVIS_ALWAYS_LISTEN false  # serverda mikrofon yo'q

  local missing=()
  for k in "${REQUIRED_KEYS[@]}"; do [[ -n "$(env_value "$k")" ]] || missing+=("$k"); done
  if ((${#missing[@]})); then
    echo
    warn ".env da to'ldirilmagan majburiy qiymatlar:"; printf '   • %s\n' "${missing[@]}"
    echo -e "\nFaylni tahrirlang:  ${B}nano .env${N}   keyin qayta ishga tushiring:  ${B}./server.sh${N}"
    echo "(TELEGRAM_OWNER_IDS ni ham yozing — botni faqat shu ID lar boshqaradi; ID ni @userinfobot dan bilib oling.)"
    exit 2
  fi
  [[ -n "$(env_value TELEGRAM_OWNER_IDS)" || -n "$(env_value TELEGRAM_CHAT_ID)" ]] || warn "TELEGRAM_OWNER_IDS bo'sh — botga /start yuborib juftlashtirasiz (birinchi yozgan odam ega bo'ladi)."
}

# ── 3. Ishga tushirish ──────────────────────────────────────
wait_healthy() {
  echo -n "Kutilmoqda (birinchi ishga tushish ~1-2 daqiqa) "
  for _ in $(seq 1 90); do
    s="$("${DOCKER[@]}" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' jarvis 2>/dev/null || echo missing)"
    case "$s" in healthy) echo; return 0;; exited|dead|missing) echo; return 1;; esac
    echo -n "."; sleep 4
  done
  echo; return 1
}

do_up() {
  step "1/3 Docker"; ensure_docker; ok "Docker tayyor"
  step "2/3 Sozlamalar"; ensure_env; ok ".env to'liq"
  step "3/3 Qurish va ishga tushirish"
  compose up -d --build
  if wait_healthy; then
    ok "JARVIS server ishlayapti"
    echo -e "\n  Holat:      ${B}./server.sh status${N}\n  Loglar:     ${B}./server.sh logs${N}\n  Dashboard:  ssh -L 7890:localhost:7890 <server>  →  http://localhost:7890\n  Telegram:   botingizga /start yozing"
  else
    warn "Konteyner sog'lom holatga o'tmadi. Loglarni ko'ring:"; compose logs --tail 40 jarvis || true; exit 1
  fi
}

case "$CMD" in
  up|start|install) do_up ;;
  status) ensure_docker; compose ps
          "${DOCKER[@]}" exec jarvis sh -c 'curl -fsS http://127.0.0.1:18789/health >/dev/null && echo "gateway: OK" || echo "gateway: JAVOB YO\x27Q"' 2>/dev/null || true
          "${DOCKER[@]}" logs --tail 200 jarvis 2>&1 | grep -E "\[supervisor\]" | tail -n 8 || true ;;
  logs)   ensure_docker; compose logs -f --tail 100 jarvis ;;
  restart) ensure_docker; ensure_env; compose restart jarvis; wait_healthy && ok "qayta ishga tushdi" ;;
  stop)   ensure_docker; compose down; ok "to'xtatildi (ma'lumotlar saqlanadi)" ;;
  update) ensure_docker; git pull --ff-only; do_up ;;
  shell)  ensure_docker; "${DOCKER[@]}" exec -it jarvis bash ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
