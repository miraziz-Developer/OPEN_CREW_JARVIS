#!/bin/bash
# JARVIS kunlik zaxira: kod (git bundle), sozlamalar, xotira, missiyalar, Obsidian "Jarvis" papkasi.
# Joy: ~/.jarvis-backups/daily/YYYY-MM-DD (faqat egasi o'qiydi). Oxirgi 7 kun saqlanadi.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${HOME}/.jarvis-backups/daily"
DEST="${ROOT}/$(date +%Y-%m-%d)"
umask 077
mkdir -p "${DEST}"
cd "${PROJECT_DIR}"
git bundle create "${DEST}/jarvis-code.bundle" --all >/dev/null 2>&1 || true
for f in .env openclaw.json .jarvis-memory-os.json .jarvis-world-model.json; do
  [[ -f "$f" ]] && cp -p "$f" "${DEST}/$(echo "$f" | tr '/' '_')" || true
done
[[ -d .run/missions ]] && tar -czf "${DEST}/missions.tar.gz" -C .run missions --exclude=missions/work 2>/dev/null || true
VAULT="${HOME}/Documents/Obsidian Vault/Jarvis"
[[ -d "${VAULT}" ]] && tar -czf "${DEST}/obsidian-jarvis.tar.gz" -C "$(dirname "${VAULT}")" "$(basename "${VAULT}")" 2>/dev/null || true
# 7 kundan eskilarini olib tashlaymiz
find "${ROOT}" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
echo "BACKUP_OK ${DEST} ($(du -sh "${DEST}" | cut -f1))"
