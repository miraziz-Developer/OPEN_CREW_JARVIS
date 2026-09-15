#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$ROOT/.venv-openwakeword/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "openWakeWord muhiti topilmadi. Avval: ./scripts/setup-openwakeword.sh" >&2
  exit 1
fi
if [[ ! -f "$ROOT/models/wake-word/training/validation_set_features.npy" ]]; then
  echo "Negative feature corpus topilmadi: models/wake-word/training/validation_set_features.npy" >&2
  exit 1
fi

exec "$PYTHON" "$ROOT/scripts/train-wake-model.py" "$@"