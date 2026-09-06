#!/bin/sh
set -eu

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export OPENCLAW_CONFIG_PATH="$PROJECT_DIR/openclaw.json"

if [ -f "$PROJECT_DIR/.env" ]; then
  import_env() {
    key="$1"
    value="$(sed -n "s/^${key}=//p" "$PROJECT_DIR/.env" | tail -n 1)"
    value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    [ -n "$value" ] || return 0
    export "$key=$value"
  }

  import_env AZURE_OPENAI_KEY
  import_env OPENCLAW_GATEWAY_TOKEN
fi

exec /opt/homebrew/bin/openclaw "$@"