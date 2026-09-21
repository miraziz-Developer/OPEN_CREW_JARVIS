#!/usr/bin/env python3
"""AutoGPT (Significant-Gravitas/Auto-GPT, agpt 0.2.2) worker — Azure gpt-5-mini bilan.

AutoGPT maqsadga qarab o'zi fikrlaydi -> buyruq tanlaydi -> natijani ko'radi -> davom etadi (continuous rejim).
Xavfsizlik: faqat ishchi papka (RESTRICT_TO_WORKSPACE), lokal shell o'chiq (EXECUTE_LOCAL_COMMANDS=False), yuklab olish yo'q,
iteratsiya chegarasi bor. Kod bajarish kerak bo'lsa — interpreter/babyagi worker'lari.

Kirish (stdin JSON): {"task": "...", "cwd": "/abs/workspace", "max_iterations": 12}
Muhit: OPENAI_API_KEY, OPENAI_API_BASE, AUTOGPT_MODEL, AUTOGPT_REASONING
Chiqish: oxirgi satr — JSON {"ok": bool, "output": str}
"""
import io
import json
import os
import re
import runpy
import sys
import traceback
import warnings

warnings.filterwarnings("ignore")

request = json.loads(sys.stdin.read() or "{}")
task = str(request.get("task", "")).strip()
if not task:
    print(json.dumps({"ok": False, "output": "", "error": "task kerak"}))
    sys.exit(0)
cwd = request.get("cwd") or os.getcwd()
os.makedirs(cwd, exist_ok=True)
os.chdir(cwd)
max_iterations = int(request.get("max_iterations", 12))

model = os.environ.get("AUTOGPT_MODEL", "gpt-5-mini")
effort = os.environ.get("AUTOGPT_REASONING", "low")
os.environ.update({
    # AutoGPT token hisoblagichi faqat taniydigan nomlarni qabul qiladi; haqiqiy chaqiruv pastda Azure modeliga almashtiriladi.
    "SMART_LLM_MODEL": "gpt-4", "FAST_LLM_MODEL": "gpt-3.5-turbo", "MEMORY_BACKEND": "no_memory",
    "EXECUTE_LOCAL_COMMANDS": "False", "RESTRICT_TO_WORKSPACE": "True", "ALLOW_DOWNLOADS": "False",
    "ANONYMIZED_TELEMETRY": "false", "PLAIN_OUTPUT": "True",
})

settings = (
    "ai_goals:\n" + "".join(f"- {json.dumps(goal)}\n" for goal in [
        task,
        "Save the final answer or deliverable to a file named result.txt in the workspace",
        "Shut down as soon as the goal is achieved",
    ]) +
    "ai_name: JarvisAutoGPT\n"
    "ai_role: an autonomous research and writing agent working for JARVIS; be concrete, verify what you produce, never guess facts\n"
)
with open(os.path.join(cwd, "ai_settings.yaml"), "w", encoding="utf-8") as handle:
    handle.write(settings)

import importlib.util  # noqa: E402

# AutoGPT JSON sxema faylini cwd'ga nisbatan "autogpt/json_utils/llm_response_format_1.json" yo'lidan ochadi (wheel'da yo'q).
_schema_dir = os.path.join(cwd, "autogpt", "json_utils")
os.makedirs(_schema_dir, exist_ok=True)
import shutil  # noqa: E402

shutil.copyfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), "autogpt_schemas", "llm_response_format_1.json"),
                os.path.join(_schema_dir, "llm_response_format_1.json"))

import openai  # noqa: E402

openai.api_key = os.environ.get("OPENAI_API_KEY", "")
if os.environ.get("OPENAI_API_BASE"):
    openai.api_base = os.environ["OPENAI_API_BASE"].rstrip("/")

_original_create = openai.ChatCompletion.create


def _patched_create(*args, **kwargs):
    # gpt-5-mini: temperature faqat 1, max_tokens o'rniga max_completion_tokens; reasoning past.
    kwargs["model"] = model
    kwargs.pop("temperature", None)
    max_tokens = kwargs.pop("max_tokens", None)
    if max_tokens:
        kwargs["max_completion_tokens"] = max(int(max_tokens), 4000)
    if effort and effort != "default":
        kwargs.setdefault("reasoning_effort", effort)
    return _original_create(*args, **kwargs)


openai.ChatCompletion.create = _patched_create

# tiktoken yangi modellarni bilmasligi mumkin — cl100k'ga tushamiz
try:
    import tiktoken
    _encoding_for_model = tiktoken.encoding_for_model

    def _safe_encoding_for_model(name):
        try:
            return _encoding_for_model(name)
        except Exception:  # noqa: BLE001
            return tiktoken.get_encoding("cl100k_base")

    tiktoken.encoding_for_model = _safe_encoding_for_model
except Exception:  # noqa: BLE001
    pass

# Eski AutoGPT `from duckduckgo_search import ddg` ishlatadi; yangi paketda u yo'q — moslik qatlami.
try:
    import duckduckgo_search

    if not hasattr(duckduckgo_search, "ddg"):
        def _ddg(keywords, max_results=8, **_kwargs):
            try:
                with duckduckgo_search.DDGS() as search:
                    return list(search.text(keywords, max_results=max_results))
            except Exception:  # noqa: BLE001
                return []

        duckduckgo_search.ddg = _ddg
except Exception:  # noqa: BLE001
    pass

# Eski AutoGPT veb vositalari zamonaviy muhitda ishlamaydi (Selenium `executable_path`, spaCy modeli): xuddi shu vositalar
# nomi bilan requests + BeautifulSoup asosida almashtiramiz.
def _patch_web_tools():
    import requests
    from bs4 import BeautifulSoup

    import autogpt.cli  # noqa: F401  (aylanma import tartibi uchun __main__ bilan bir xil)
    from autogpt.commands import web_selenium
    from autogpt.processing import text as text_processing

    headers = {"User-Agent": "Mozilla/5.0 (compatible; JarvisAutoGPT/1.0)"}

    def scrape_text(url):
        page = requests.get(url, headers=headers, timeout=25)
        soup = BeautifulSoup(page.text, "html.parser")
        for tag in soup(["script", "style", "noscript"]):
            tag.extract()
        lines = (line.strip() for line in soup.get_text().splitlines())
        return None, "\n".join(chunk for line in lines for chunk in line.split("  ") if chunk)

    def scrape_links(driver, url):
        soup = BeautifulSoup(requests.get(url, headers=headers, timeout=25).text, "html.parser")
        links = []
        for anchor in soup.find_all("a", href=True)[:40]:
            links.append(f"{anchor.get_text(strip=True)[:60]} ({anchor['href']})")
        return links

    def split_text(text, max_length=3000, model=None, question=""):
        chunk = ""
        for paragraph in str(text).split("\n"):
            if len(chunk) + len(paragraph) > max_length and chunk:
                yield chunk
                chunk = ""
            chunk += paragraph + "\n"
        if chunk.strip():
            yield chunk

    web_selenium.scrape_text_with_selenium = scrape_text
    web_selenium.scrape_links_with_selenium = scrape_links
    web_selenium.close_browser = lambda driver: None
    text_processing.split_text = split_text
    text_processing.scroll_to_percentage = lambda *args, **kwargs: None  # brauzer yo'q


try:
    _patch_web_tools()
except Exception as _exc:  # noqa: BLE001
    sys.stderr.write(f"web tool patch failed: {_exc}\n")

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
buffer = io.StringIO()
real_stdout = sys.stdout
try:
    sys.stdout = buffer
    sys.argv = ["autogpt", "--continuous", "--continuous-limit", str(max_iterations), "--skip-reprompt",
                "--skip-news", "--ai-settings", "ai_settings.yaml", "--use-memory", "no_memory"]
    try:
        runpy.run_module("autogpt", run_name="__main__")
    except SystemExit:
        pass
finally:
    sys.stdout = real_stdout

log = ANSI.sub("", buffer.getvalue())
result_path = os.path.join(cwd, "auto_gpt_workspace", "result.txt")
deliverable = ""
for candidate in (result_path, os.path.join(cwd, "result.txt")):
    if os.path.exists(candidate):
        deliverable = open(candidate, encoding="utf-8", errors="replace").read().strip()
        break
errors = re.findall(r"(?:Error|Exception)[^\n]{0,200}", log)[-3:]
print(json.dumps({
    "ok": bool(deliverable),
    "output": (deliverable or "AutoGPT did not produce result.txt")[:6000],
    "error": "" if deliverable else "; ".join(errors)[:500],
    "log_tail": log[-1200:],
}))
