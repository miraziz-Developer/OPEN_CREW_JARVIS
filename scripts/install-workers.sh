#!/bin/bash
# Web Specialist (Browser-use + Playwright/Chromium) uchun alohida Python muhit: .venv-workers
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PY="${WORKERS_PYTHON:-/opt/homebrew/bin/python3.12}"
VENV="$PROJECT_DIR/.venv-workers"
[[ -x "$PY" ]] || { echo "Python topilmadi: $PY"; exit 1; }
[[ -d "$VENV" ]] || "$PY" -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet browser-use playwright
"$VENV/bin/playwright" install chromium
"$VENV/bin/python" -c "import browser_use; print('browser-use', getattr(browser_use,'__version__','ok'))"
echo "WORKERS_INSTALL_DONE"
