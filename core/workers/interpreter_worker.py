#!/opt/homebrew/opt/python@3.11/bin/python3.11
"""Open Interpreter worker (Azure gpt-5-mini) — past reasoning_effort bilan tez.

Kirish (stdin JSON): {"task": "...", "cwd": "/abs/dir"}
Muhit: OPENAI_API_KEY, OPENAI_API_BASE (Azure …/openai/v1), INTERPRETER_MODEL, INTERPRETER_REASONING
Chiqish: oxirgi satr — JSON {"ok": bool, "output": str}
"""
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

request = json.loads(sys.stdin.read() or "{}")
task = str(request.get("task", "")).strip()
if not task:
    print(json.dumps({"ok": False, "output": "", "error": "task kerak"}))
    sys.exit(0)
if request.get("cwd"):
    os.makedirs(request["cwd"], exist_ok=True)
    os.chdir(request["cwd"])

import litellm  # noqa: E402
from interpreter import interpreter  # noqa: E402

effort = os.environ.get("INTERPRETER_REASONING", "low")
_original = litellm.completion


def _with_effort(*args, **kwargs):
    if effort and effort != "default":
        kwargs.setdefault("reasoning_effort", effort)
    return _original(*args, **kwargs)


litellm.completion = _with_effort

interpreter.llm.model = "openai/" + os.environ.get("INTERPRETER_MODEL", "gpt-5-mini")
interpreter.llm.temperature = 1
interpreter.llm.max_tokens = 4000
interpreter.llm.context_window = 100000
interpreter.auto_run = True
interpreter.offline = True
interpreter.disable_telemetry = True
interpreter.verbose = False

try:
    interpreter.chat(task, display=False, stream=False)
    texts = [m.get("content", "") for m in interpreter.messages if m.get("role") == "assistant" and m.get("type") == "message"]
    outputs = [m.get("content", "") for m in interpreter.messages if m.get("type") == "console" and m.get("format") == "output"]
    final = (texts[-1] if texts else "").strip()
    tail = "\n".join(str(o) for o in outputs[-3:])[-1500:]
    print(json.dumps({"ok": bool(final or tail), "output": (final + ("\n\nConsole output:\n" + tail if tail else "")).strip()}))
except Exception as exc:  # noqa: BLE001
    print(json.dumps({"ok": False, "output": "", "error": f"{type(exc).__name__}: {exc}"[:600]}))
