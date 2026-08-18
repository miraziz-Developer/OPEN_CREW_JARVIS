#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$PROJECT_DIR/.venv-openwakeword"
command -v uv >/dev/null || { echo "uv topilmadi" >&2; exit 1; }
uv venv --python python3.11 "$VENV"
uv pip install --python "$VENV/bin/python" openwakeword
"$VENV/bin/python" - <<'PY'
import sys, types
stub = types.ModuleType("openwakeword.custom_verifier_model")
stub.train_custom_verifier = None
sys.modules["openwakeword.custom_verifier_model"] = stub
from openwakeword.utils import download_models
download_models(["hey_jarvis"])
PY
echo "✅ openWakeWord tayyor: $VENV"