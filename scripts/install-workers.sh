#!/bin/bash
# Avtonom ishchilar uchun Python muhitlari (requirements/*.txt dan, qayta ishlatsa xavfsiz).
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

find_py() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return 0; }; done; return 1; }
BREW_PREFIX="$(brew --prefix 2>/dev/null || echo /opt/homebrew)"
PY312="$(find_py python3.12 "$BREW_PREFIX/bin/python3.12" /opt/homebrew/bin/python3.12 /usr/local/bin/python3.12 || true)"
PY311="$(find_py python3.11 "$BREW_PREFIX/bin/python3.11" /opt/homebrew/bin/python3.11 /usr/local/bin/python3.11 || true)"
[[ -n "$PY312" || -n "$PY311" ]] || { echo "Python 3.11 yoki 3.12 kerak: brew install python@3.12 python@3.11"; exit 1; }
: "${PY312:=$PY311}"; : "${PY311:=$PY312}"

build() { # nomi python requirements [pip-flag]   (frozen ro'yxatlar uchun --no-deps: aynan sinalgan muhit tiklanadi)
  local name="$1" py="$2" req="$3" flags="${4:-}" venv="$PROJECT_DIR/.venv-$1"
  if [[ -x "$venv/bin/python" ]] && "$venv/bin/python" -c "pass" 2>/dev/null && [[ -f "$venv/.jarvis-ok" ]]; then echo "✅ $name tayyor"; return; fi
  echo "⏳ $name o'rnatilmoqda…"
  [[ -d "$venv" ]] || "$py" -m venv "$venv"
  "$venv/bin/pip" install --quiet --upgrade pip
  "$venv/bin/pip" install --quiet $flags -r "$req"
  touch "$venv/.jarvis-ok"
  echo "✅ $name"
}

build workers "$PY312" requirements/workers.txt --no-deps
"$PROJECT_DIR/.venv-workers/bin/playwright" install chromium >/dev/null 2>&1 || echo "⚠️ playwright chromium o'rnatilmadi"
build babyagi "$PY312" requirements/babyagi.txt --no-deps
build autogpt "$PY311" requirements/autogpt.txt --no-deps
build interpreter "$PY311" requirements/interpreter.txt
echo "WORKERS_INSTALL_DONE"
