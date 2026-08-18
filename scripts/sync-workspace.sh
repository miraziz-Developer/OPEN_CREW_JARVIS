#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# SYNC-WORKSPACE — loyihadagi skill/SOUL.md o'zgarishlarini haqiqiy live
# agent o'qiydigan ~/.openclaw/workspace ga nusxalaydi.
#
# NEGA KERAK (real topilma, taxmin emas): openclaw agent skill'larni
# PROJECT_DIR'dan emas, ~/.openclaw/workspace/skills/ dan o'qiydi — bu
# butunlay ALOHIDA nusxa. Buning oqibati kutilganidan OG'IRROQ chiqdi:
# faqat "ro'yxatga olingan" (agents.defaults.skills) skill'lar emas, balki
# agentning `exec` vositasi ham ISHCHI PAPKA sifatida workspace'ni oladi,
# PROJECT_DIR'ni EMAS. Ya'ni SOUL.md'da "echo ... | node skills/memory/
# index.js" deb ko'rsatilgan barcha bevosita chaqiruvlar ham shu joydan
# qidiriladi. Bu real sinovda tasdiqlandi: `skills/memory` (butun tizimdagi
# ENG KO'P ishlatiladigan — Obsidianga yozish, semantik qidiruv) va
# `skills/projects` (ko'p bosqichli loyiha yaratish) agent tomonidan
# "MODULE_NOT_FOUND" bilan MUTLAQO chaqirib bo'lmas holatda edi — avval
# faqat "ro'yxatga olingan" 8 ta skill bilan cheklangan versiya buni
# butunlay o'tkazib yuborgan edi.
#
# Shuning uchun endi RO'YXAT emas — skills/ ostidagi HAMMA papka
# sinxronlanadi (kelajakda SOUL.md'ga yangi "skills/X" havolasi
# qo'shilsa ham, alohida "sync ro'yxatiga qo'sh" deb eslab yurish shart
# bo'lmasin). Faqat `wakeword` chetlab o'tiladi — 301MB model
# og'irliklari, sof daemon-ichki modul (require() orqali, hech qachon
# agent exec orqali chaqirilmaydi), uni nusxalash vaqt/joy isrofi bo'lardi.
#
# Symlink bilan hal qilishga urinildi — openclaw buni ATAYLAB bloklaydi
# ("symlink-escape", xavfsizlik uchun to'g'ri qaror). Shuning uchun
# yagona ishonchli yechim — HAR RESTARTDA avtomatik qayta nusxalash.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

PROJECT_DIR="/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS"
WORKSPACE="${HOME}/.openclaw/workspace"
EXCLUDE_SKILLS=(wakeword)

mkdir -p "${WORKSPACE}/skills"
changed=0

is_excluded() {
  local name="$1"
  for e in "${EXCLUDE_SKILLS[@]}"; do
    [ "${name}" = "${e}" ] && return 0
  done
  return 1
}

for SRC in "${PROJECT_DIR}"/skills/*/; do
  s="$(basename "${SRC}")"
  is_excluded "${s}" && continue
  DST="${WORKSPACE}/skills/${s}"
  if ! diff -rq "${SRC}" "${DST}" >/dev/null 2>&1; then
    rm -rf "${DST}"
    cp -R "${SRC}" "${DST}"
    echo "[sync-workspace] yangilandi: ${s}"
    changed=$((changed + 1))
  fi
done

if ! diff -q "${PROJECT_DIR}/SOUL.md" "${WORKSPACE}/SOUL.md" >/dev/null 2>&1; then
  cp "${PROJECT_DIR}/SOUL.md" "${WORKSPACE}/SOUL.md"
  echo "[sync-workspace] yangilandi: SOUL.md"
  changed=$((changed + 1))
fi

if [ "${changed}" -eq 0 ]; then
  echo "[sync-workspace] hammasi allaqachon yangilangan"
else
  echo "[sync-workspace] jami ${changed} ta narsa yangilandi"
fi
