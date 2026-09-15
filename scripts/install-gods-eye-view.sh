#!/usr/bin/env bash
set -euo pipefail

# Keep the large upstream Vite/Cesium app isolated from Jarvis's Node modules.
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${PROJECT_DIR}/vendor/gods-eye-view"
PATCH_FILE="${PROJECT_DIR}/patches/gods-eye-view-jarvis-keyless.patch"
UPSTREAM_URL="https://github.com/bilawalsidhu/gods-eye-view.git"
UPSTREAM_COMMIT="1ad565c8afd719e041965b76078b03313f6c4c81"

if [[ -d "${APP_DIR}/.git" ]]; then
  echo "God's Eye View checkout already exists: ${APP_DIR}"
else
  mkdir -p "$(dirname "${APP_DIR}")"
  git clone "${UPSTREAM_URL}" "${APP_DIR}"
fi

git -C "${APP_DIR}" fetch --depth 1 origin "${UPSTREAM_COMMIT}"
git -C "${APP_DIR}" checkout --detach "${UPSTREAM_COMMIT}"
git -C "${APP_DIR}" apply --check "${PATCH_FILE}"
git -C "${APP_DIR}" apply "${PATCH_FILE}"
npm --prefix "${APP_DIR}" ci

echo "God's Eye View installed at ${APP_DIR}"
echo "Run a place view through the Jarvis gods-eye-view skill."