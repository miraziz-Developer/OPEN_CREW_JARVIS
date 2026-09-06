#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

# Keep the complete scan bounded even when Git encounters a damaged object or
# an unexpectedly large history. Node is already a required runtime.
if [[ "${1:-}" != "--inner" ]]; then
  exec node - "${BASH_SOURCE[0]}" "${SECRET_SCAN_TIMEOUT_MS:-120000}" <<'NODE'
const { spawnSync } = require('child_process');

const script = process.argv[2];
const timeout = Number(process.argv[3]);
if (!Number.isSafeInteger(timeout) || timeout < 1000) {
  console.error('❌ SECRET_SCAN_TIMEOUT_MS 1000 yoki undan katta butun son bo‘lishi kerak.');
  process.exit(2);
}

const result = spawnSync('/bin/bash', [script, '--inner'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  timeout,
  killSignal: 'SIGTERM'
});
if (result.error?.code === 'ETIMEDOUT') {
  console.error(`❌ Secret scan ${timeout} ms limitdan oshdi.`);
  process.exit(124);
}
if (result.error) {
  console.error(`❌ Secret scan ishga tushmadi: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
NODE
fi
shift

PATTERN='(token|secret|api[_-]?key|password)["[:space:]]*[:=]["[:space:]]*[A-Za-z0-9_./+-]{24,}'
PATHS=('--' ':!package-lock.json' ':!.env.example' ':!tests/**')

scan_tree() {
  local revision="${1:-}"
  local output
  local status
  output="$(mktemp "${TMPDIR:-/tmp}/jarvis-secret-scan.XXXXXX")"

  if [[ -n "${revision}" ]]; then
    git grep -n -I -E "${PATTERN}" "${revision}" "${PATHS[@]}" >"${output}" || status=$?
  else
    git grep -n -I -E "${PATTERN}" "${PATHS[@]}" >"${output}" || status=$?
  fi

  status="${status:-0}"
  if [[ "${status}" -eq 0 ]]; then
    cat "${output}"
    rm -f "${output}"
    return 1
  fi
  rm -f "${output}"
  [[ "${status}" -eq 1 ]] || return "${status}"
}

if ! scan_tree; then
  echo '❌ Tracked working tree ichida ehtimoliy plaintext secret topildi.' >&2
  exit 1
fi
echo '✅ Tracked working tree ichida plaintext secret topilmadi.'

while IFS= read -r commit; do
  if ! scan_tree "${commit}"; then
    echo "❌ Git history ichida ehtimoliy plaintext secret topildi: ${commit}" >&2
    exit 1
  fi
done < <(git rev-list --all)
echo '✅ Barcha reachable Git history ichida plaintext secret topilmadi.'