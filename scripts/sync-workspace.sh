#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# SYNC-WORKSPACE: copies the project's skill/SOUL.md changes into
# ~/.openclaw/workspace, which is what the live agent actually reads.
#
# WHY (a real finding, not a guess): the openclaw agent reads skills from
# ~/.openclaw/workspace/skills/, a completely SEPARATE copy, not PROJECT_DIR. Worse,
# not only registered skills (agents.defaults.skills) are affected: the agent's `exec`
# tool also uses the workspace as its WORKING DIRECTORY, so every direct call shown in
# SOUL.md ("echo ... | node skills/memory/index.js") resolves there too. Confirmed in a
# real test: `skills/memory` (the most used skill: Obsidian writes, semantic search)
# and `skills/projects` (multi-step projects) failed with MODULE_NOT_FOUND for the
# agent; an earlier version that synced only the 8 registered skills missed this.
#
# So instead of a list, EVERY folder under skills/ is synced (a new "skills/X" reference
# in SOUL.md needs no separate sync-list entry). Only `wakeword` is skipped: 301 MB of
# model weights in a daemon-internal module (loaded via require(), never through the
# agent's exec), so copying it would waste time and space.
#
# A symlink was tried, but openclaw DELIBERATELY blocks it ("symlink-escape", the right
# security call), so the only reliable fix is an automatic re-copy on EVERY restart.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="${HOME}/.openclaw/workspace"
EXCLUDE_SKILLS=(wakeword)
# The old version was limited to 5 hand-maintained files, so a new skill that needed a
# new core/ file hit the same MODULE_NOT_FOUND again (exactly what happened with
# phone-control). Now, like skills/, EVERY .js file under core/ is synced; nobody has to
# remember a list.

mkdir -p "${WORKSPACE}/skills"
mkdir -p "${WORKSPACE}/core"
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

# Workspace skills require these small, secret-free runtime modules through ../../core
# (verified: core/*.js holds no secret keys; they read .env through env() at runtime).
# .env is not copied; the agent gets JARVIS_PROJECT_DIR for state and config.
for SRC in "${PROJECT_DIR}"/core/*.js; do
  name="$(basename "${SRC}")"
  DST="${WORKSPACE}/core/${name}"
  if ! diff -q "${SRC}" "${DST}" >/dev/null 2>&1; then
    cp "${SRC}" "${DST}"
    echo "[sync-workspace] yangilandi: core/${name}"
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
