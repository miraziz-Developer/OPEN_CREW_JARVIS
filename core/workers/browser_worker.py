#!/usr/bin/env python3
"""Web Specialist worker: Browser-use bilan haqiqiy brauzerda ko'p bosqichli veb vazifa.

Kirish (stdin JSON): {"task": "...", "max_steps": 25, "headless": true}
Muhit: AZURE_OPENAI_KEY, AZURE_OPENAI_ENDPOINT (…/openai/v1), BROWSER_WORKER_MODEL
Chiqish: oxirgi satr — JSON {"ok": bool, "output": str, "steps": int, "errors": [...]}
"""
import asyncio
import json
import os
import sys


async def main() -> None:
    request = json.loads(sys.stdin.read() or "{}")
    task = str(request.get("task", "")).strip()
    if not task:
        print(json.dumps({"ok": False, "output": "", "error": "task kerak"}))
        return

    from browser_use import Agent, BrowserProfile
    from browser_use.llm import ChatOpenAI

    key = os.environ.get("AZURE_OPENAI_KEY", "")
    base = os.environ.get("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
    model = os.environ.get("BROWSER_WORKER_MODEL", "gpt-5-mini")
    if not key or not base:
        print(json.dumps({"ok": False, "output": "", "error": "Azure OpenAI sozlanmagan"}))
        return

    llm = ChatOpenAI(model=model, api_key=key, base_url=base, temperature=1, add_schema_to_system_prompt=True, dont_force_structured_output=True)
    # Standart: JARVIS Chrome profili (hozirgi Chrome akkauntingiz sessiyasi, scripts/chrome-profile-sync.py) va haqiqiy Chrome.
    # Playwright'ning soxta keychain'i o'chiriladi, aks holda Chrome cookie'larni ocholmay yo'qotadi.
    profile_dir = os.path.expanduser(os.environ.get("JARVIS_CHROME_DIR", "~/Library/Application Support/JarvisChrome"))
    if request.get("use_profile", True) and os.path.isdir(profile_dir):
        profile = BrowserProfile(
            headless=bool(request.get("headless", False)), user_data_dir=profile_dir, profile_directory="Default",
            channel="chrome", keep_alive=False,
            ignore_default_args=["--use-mock-keychain", "--password-store=basic", "--enable-automation"],
        )
    else:
        profile = BrowserProfile(headless=bool(request.get("headless", True)), user_data_dir=None, keep_alive=False)
    agent = Agent(task=task, llm=llm, browser_profile=profile, use_vision=False, enable_signal_handler=False,
                  generate_gif=False, max_failures=4, use_judge=False)
    history = await agent.run(max_steps=int(request.get("max_steps", 25)))
    result = history.final_result() or ""
    errors = [str(e) for e in history.errors() if e]
    ok = bool(history.is_done() and result and history.is_successful() is not False)
    print(json.dumps({"ok": ok, "output": result, "steps": history.number_of_steps(), "errors": errors[-3:]}))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "output": "", "error": f"{type(exc).__name__}: {exc}"[:600]}))
