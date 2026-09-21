#!/usr/bin/env python3
"""BabyAGI (yoheinakajima/babyagi, functionz) worker — Azure gpt-5-mini bilan.

BabyAGI vazifani funksiyalarga bo'ladi, ularning Python kodini o'zi yozadi, ro'yxatga oladi va ishga tushiradi
(o'zini-o'zi quruvchi agent). LLM chaqiruvlari litellm orqali — biz ularni Azure OpenAI v1 endpoint'ga yo'naltiramiz.

Kirish (stdin JSON): {"task": "...", "cwd": "/abs/workspace"}
Muhit: OPENAI_API_KEY, OPENAI_API_BASE, BABYAGI_MODEL, BABYAGI_REASONING
Chiqish: oxirgi satr — JSON {"ok": bool, "output": str}
"""
import contextlib
import io
import json
import os
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

import litellm  # noqa: E402

model = "openai/" + os.environ.get("BABYAGI_MODEL", "gpt-5-mini")
effort = os.environ.get("BABYAGI_REASONING", "low")
litellm.drop_params = True
_original = litellm.completion


def _azure_completion(*args, **kwargs):
    # BabyAGI kodida qattiq yozilgan gpt-4-turbo / gpt-4o-mini nomlarini Azure deployment'ga almashtiramiz.
    kwargs["model"] = model
    kwargs.pop("temperature", None)
    if effort and effort != "default":
        kwargs.setdefault("reasoning_effort", effort)
    return _original(*args, **kwargs)


litellm.completion = _azure_completion

# Funksiya qidiruvi uchun embedding: loyihadagi Azure embedding deployment'i.
_embed_original = litellm.embedding
_embed_base = os.environ.get("BABYAGI_EMBED_BASE", "").rstrip("/")
_embed_key = os.environ.get("BABYAGI_EMBED_KEY", "")
_embed_model = "openai/" + os.environ.get("BABYAGI_EMBED_MODEL", "text-embedding-3-large-2")


def _azure_embedding(*args, **kwargs):
    kwargs["model"] = _embed_model
    if _embed_base:
        kwargs["api_base"] = _embed_base
    if _embed_key:
        kwargs["api_key"] = _embed_key
    kwargs.pop("dimensions", None)
    return _embed_original(*args, **kwargs)


litellm.embedding = _azure_embedding

log = io.StringIO()
try:
    with contextlib.redirect_stdout(log):
        import importlib
        import re
        import subprocess

        import babyagi  # noqa: E402
        from babyagi.functionz.core import execution as _execution  # noqa: E402

        _PACKAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]*$")

        def _safe_install(self, package_name, imp_name):
            """LLM ba'zan import ifodasini butun ("from typing import X") yozadi — uni pip'ga bermaymiz."""
            def module_root(text):
                match = re.match(r"^\s*(?:from|import)\s+([A-Za-z0-9_]+)", str(text))
                return match.group(1) if match else str(text).strip()

            for candidate in (imp_name, package_name):
                root = module_root(candidate)
                try:
                    return importlib.import_module(root)
                except ImportError:
                    continue
            root = module_root(package_name)
            if _PACKAGE_NAME.match(root):
                subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", root])
                return importlib.import_module(module_root(imp_name) or root)
            raise ImportError(f"import bajarilmadi: {package_name}")

        for _name in dir(_execution):
            _cls = getattr(_execution, _name)
            if isinstance(_cls, type) and hasattr(_cls, "_install_external_dependency"):
                _cls._install_external_dependency = _safe_install

        for pack in ("drafts/code_writing_functions", "default/ai_functions"):
            try:
                babyagi.load_functions(pack)
            except Exception:  # noqa: BLE001
                pass
        instance = babyagi.get_func_instance()
        known = {f["name"] for f in instance.get_all_functions()}
        output = instance.execute_function("process_user_input", user_input=task)
        # Tekshiruvchi natijani baholay olishi uchun BabyAGI yozgan yangi funksiya(lar) kodini ham qo'shamiz.
        created = [f for f in instance.get_all_functions() if f["name"] not in known][:2]
        code = "\n\n".join(f"# BabyAGI function {f['name']}\n{(f.get('code') or '')[:1500]}" for f in created)
    detail = f"Result: {output}" + (f"\n\nGenerated code for verification:\n{code}" if code else "")
    print(json.dumps({"ok": output is not None, "output": detail[:6000], "log_tail": log.getvalue()[-800:]}))
except Exception as exc:  # noqa: BLE001
    print(json.dumps({"ok": False, "output": "", "error": f"{type(exc).__name__}: {exc}"[:600], "trace": traceback.format_exc()[-1500:], "log_tail": log.getvalue()[-800:]}))
