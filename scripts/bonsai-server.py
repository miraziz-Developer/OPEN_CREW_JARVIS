#!/usr/bin/env python3
"""JARVIS: Ternary Bonsai 2 27B (MLX) uchun lokal HTTP server.

Model paketning o'z runtime'i orqali yuklanadi (oddiy MLX yuklovchisi og'irliklarni noto'g'ri o'qiydi).
Endpointlar:
  GET  /health                  → {"ok": true}
  POST /v1/chat/completions     → OpenAI uslubidagi javob (matn; rasm: content ichida image_url data:base64)
Jarayon to'xtatilsa model RAM'dan to'liq bo'shaydi — JARVIS Brain uni faqat kerak paytda ishga tushiradi.
"""
import argparse
import base64
import json
import os
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--port", type=int, default=11436)
args = parser.parse_args()
PACK = Path(args.model).resolve()
sys.path.insert(0, str(PACK / "runtime"))

from jinja2.sandbox import ImmutableSandboxedEnvironment  # noqa: E402
from mlx_vlm import generate  # noqa: E402
from mlx_vlm.prompt_utils import apply_chat_template  # noqa: E402
from vision_artifact import chat_config, load_vl_model  # noqa: E402


def read_json(name, default):
    path = PACK / name
    return json.loads(path.read_text()) if path.is_file() else default


def sampler_settings():
    gen = read_json("generation_config.json", {})
    out = {"temperature": gen.get("temperature", 1.0), "top_p": gen.get("top_p", 0.95), "top_k": gen.get("top_k", 20)}
    if gen.get("do_sample") is False:
        out["temperature"] = 0.0
    if gen.get("min_p"):
        out["min_p"] = gen["min_p"]
    if gen.get("repetition_penalty") not in (None, 1.0):
        out["repetition_penalty"] = gen["repetition_penalty"]
    return out


TEMPLATE = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True).from_string((PACK / "chat_template.jinja").read_text())
started = time.time()
MODEL, PROCESSOR, CONFIG = load_vl_model(PACK)
SETTINGS = sampler_settings()
print(f"READY model loaded in {time.time() - started:.1f}s", flush=True)


def split_content(content):
    """OpenAI content → (matn, [rasm fayllari])."""
    if isinstance(content, str):
        return content, []
    texts, images = [], []
    for part in content or []:
        if part.get("type") == "text":
            texts.append(part.get("text", ""))
        elif part.get("type") == "image_url":
            url = (part.get("image_url") or {}).get("url", "")
            if url.startswith("data:"):
                data = base64.b64decode(url.split(",", 1)[1])
                fd, path = tempfile.mkstemp(suffix=".png")
                os.write(fd, data)
                os.close(fd)
                images.append(path)
            elif url:
                images.append(url)
    return "\n".join(texts), images


def complete(body):
    messages, images = [], []
    for m in body.get("messages", []):
        text, imgs = split_content(m.get("content"))
        images += imgs
        messages.append({"role": m.get("role", "user"), "content": text})
    settings = dict(SETTINGS)
    if body.get("temperature") is not None:
        settings["temperature"] = float(body["temperature"])
    max_tokens = int(body.get("max_tokens") or body.get("max_completion_tokens") or 1024)
    thinking = bool(body.get("thinking", False))
    if images:
        # Rasm bilan: mlx-vlm shabloni rasm belgilarini to'g'ri qo'yadi (oxirgi foydalanuvchi matni bilan).
        last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        system = "\n".join(m["content"] for m in messages if m["role"] == "system")
        prompt = apply_chat_template(PROCESSOR, chat_config(CONFIG), (system + "\n\n" if system else "") + last_user, num_images=len(images))
    else:
        prompt = TEMPLATE.render(messages=messages, add_generation_prompt=True, enable_thinking=thinking)
    t = time.time()
    result = generate(MODEL, PROCESSOR, prompt, images or None, max_tokens=max_tokens, **settings)
    text = result if isinstance(result, str) else getattr(result, "text", str(result))
    for path in images:
        if path.startswith(tempfile.gettempdir()):
            try:
                os.remove(path)
            except OSError:
                pass
    return {
        "object": "chat.completion", "model": "bonsai2-27b",
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": text.strip()}}],
        "usage": {"prompt_tokens": getattr(result, "prompt_tokens", 0), "completion_tokens": getattr(result, "generation_tokens", 0)},
        "timing": {"seconds": round(time.time() - t, 2)},
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": "bonsai2-27b"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            self._send(200, complete(body))
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": {"message": f"{type(exc).__name__}: {exc}"[:600]}})

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
