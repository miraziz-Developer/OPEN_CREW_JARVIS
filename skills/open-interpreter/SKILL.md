# open-interpreter

Use the locally installed Open Interpreter worker (`.venv-interpreter/bin/interpreter`) for hands-on Mac work that needs terminal access, shell scripts, Docker, local servers, code changes, or native macOS application automation through AppleScript. It can use its Computer API to inspect and operate local apps such as Finder, Notes, and Calendar.

## When to use it

Use `open-interpreter` when the user explicitly asks to:

- run, write, or debug bash/zsh scripts; inspect local processes; or edit local code;
- start, stop, inspect, or troubleshoot Docker containers;
- start, test, inspect, or repair a local development server;
- perform a multi-step local file or development task requiring terminal access;
- read or modify a native macOS app through AppleScript or Computer API interaction.

Do **not** use it for a simple question, web research, or a single deterministic desktop action. Prefer `browser` for browser work, `desktop-control` for one clear macOS UI action, and direct `exec` for a short known command. Open Interpreter is the worker for broader autonomous local-computer tasks.

## Run

From the OpenClaw workspace, send one complete, specific task through stdin:

```bash
cat <<'TASK' | interpreter --stdin --loop --safe_mode auto --auto_run --disable_telemetry
Work only in /absolute/path/to/project. Inspect the current state first. Then implement and verify this task:
<specific task>

Constraints:
- Reply with a concise English summary of commands run, files changed, and verification results.
- Do not access secrets, credential stores, or unrelated directories.
- Do not send messages, publish content, make purchases, change permissions, delete data, or stop production services unless the user explicitly requested and confirmed that exact action.
TASK
```

Use an absolute working directory and give the worker an explicit success condition. Ask it to inspect before editing and to run the smallest relevant verification command after changes. Do not pass API keys on the command line or include secrets in the task text.

## AppleScript and Computer API

For Finder, Notes, Calendar, or other local Mac apps, state the app, intended change, and the evidence required to confirm it. Examples of valid evidence include a returned AppleScript value, a visible title/value, or a re-read of the affected record. Prefer app-native AppleScript where possible; use Computer API mouse/keyboard interaction only when no stable native interface is available.

Before typing text into an app, confirm the focused app and target field. After any UI mutation, re-read the relevant state or inspect the screen. Never report completion based only on a command exit code.

## Safety and boundaries

- `--safe_mode auto` is required. Do not use `--safe_mode off`.
- For automatic dependency repair, inspect first and install only one validated package into the current project. Never use `sudo`, global installs, package URLs/paths, lifecycle scripts, or an unbounded `npm install`/`pip install` command.
- `--auto_run` is permitted only because the task is bounded by this skill and the user requested the local work. Keep the task narrow.
- Ask for explicit confirmation before deleting files/data, changing system settings or permissions, altering credentials, stopping a service that may be in use, sending/publishing anything, or making a purchase/payment.
- Never use destructive Docker commands (`rm`, `prune`, volume removal) without explicit confirmation and a named target.
- Do not expose private file contents, tokens, passwords, SSH keys, browser data, or clipboard contents in the final response.
- If Open Interpreter is unavailable, fails, or cannot verify the result, say so plainly and use a narrower existing Jarvis tool when appropriate.

## Output

Return a concise English outcome: what changed, where it changed, what was verified, and any remaining blocker. Do not claim success until the requested local state has been observed or tested.