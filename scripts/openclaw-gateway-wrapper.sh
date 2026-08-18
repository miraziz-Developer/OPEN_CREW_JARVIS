#!/bin/sh
set -eu

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if [ -f "$PROJECT_DIR/.env" ]; then
  AZURE_OPENAI_KEY="$(sed -n 's/^AZURE_OPENAI_KEY=//p' "$PROJECT_DIR/.env" | tail -n 1)"
  export AZURE_OPENAI_KEY
fi

exec /opt/homebrew/bin/openclaw "$@"