#!/bin/bash
# macOS Voice Processing yordamchisini kompilyatsiya qiladi (.run/bin/jarvis-voice-io).
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$PROJECT_DIR/.run/bin"
swiftc -O "$PROJECT_DIR/native/jarvis-voice-io.swift" -o "$PROJECT_DIR/.run/bin/jarvis-voice-io"
echo "OK: $PROJECT_DIR/.run/bin/jarvis-voice-io"
