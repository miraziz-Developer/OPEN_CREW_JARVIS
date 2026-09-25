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

# Require a literal assignment value. The old expression allowed arbitrary
# spaces/quotes before a later ':' or '=', so identifiers such as
# `fresh.TELEGRAM_BOT_TOKEN || env(...)` were mistaken for secret values.
PATTERN="(token|secret|api[_-]?key|password)[\"[:space:]]*[:=][[:space:]]*(\"[^\"$]{24,}\"|'[^'$]{24,}'|[A-Za-z0-9_./+-]{24,}([,;[:space:]]|$))"
SECRET_FRAGMENT_LOG_PATTERN='console\.(log|error|warn|info)[^(]*\([^\n]*(TOKEN|KEY|SECRET)\.(substring|slice)[[:space:]]*\('
# Browser profiles are generated, machine-specific state (and are ignored by
# this repository). Their encrypted browser metadata can resemble a secret;
# scanning old commits containing that state makes the history check noisy
# without protecting shipped source.
PATHS=('--' ':!package-lock.json' ':!.env.example' ':!tests/**' ':!browser/**')

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
    # `token = config.TELEGRAM_BOT_TOKEN` is a property reference, not a
    # credential literal. Keep scanning unquoted values, but remove only this
    # syntactically identifiable identifier form from grep's candidates.
    local filtered matches
    filtered="${output}.filtered"
    matches="${output}.matches"
    grep -E -o "${PATTERN}" "${output}" >"${matches}" || true
    grep -E -v '[:=][[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*\.[A-Z][A-Z0-9_]{10,}[[:space:]]*$' "${matches}" >"${filtered}" || true
    rm -f "${matches}"
    if [[ ! -s "${filtered}" ]]; then
      rm -f "${output}" "${filtered}"
      return 0
    fi
    rm -f "${filtered}"
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

# Hatto qisman secret ham loglarda credential fingerprint qoldiradi. Bu qoida
# joriy tracked source'ni tekshiradi; oldingi tarix alohida plaintext scan bilan
# qamrab olinadi va ushbu guard yangi regressiyani commit qilishdan to'xtatadi.
fragment_output="$(mktemp "${TMPDIR:-/tmp}/jarvis-secret-fragment-scan.XXXXXX")"
fragment_status=0
git grep -n -I -E "${SECRET_FRAGMENT_LOG_PATTERN}" "${PATHS[@]}" >"${fragment_output}" || fragment_status=$?
if [[ "${fragment_status}" -eq 0 ]]; then
  cat "${fragment_output}"
  rm -f "${fragment_output}"
  echo '❌ Source kod secret fragmentini logga chiqaradi.' >&2
  exit 1
fi
rm -f "${fragment_output}"
if [[ "${fragment_status}" -ne 1 ]]; then
  echo '❌ Secret fragment log scan bajarilmadi.' >&2
  exit "${fragment_status}"
fi
echo '✅ Source kod secret fragmentlarini loglamaydi.'

while IFS= read -r commit; do
  if ! scan_tree "${commit}"; then
    echo "❌ Git history ichida ehtimoliy plaintext secret topildi: ${commit}" >&2
    exit 1
  fi
done < <(git rev-list --all)
echo '✅ Barcha reachable Git history ichida plaintext secret topilmadi.'