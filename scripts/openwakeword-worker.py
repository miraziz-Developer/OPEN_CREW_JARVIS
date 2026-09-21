#!/usr/bin/env python3
"""stdin PCM16/16kHz -> stdout READY or DETECT <model> <score>."""
import os
from pathlib import Path
import signal
import sys
import threading
import time
import types
from collections import deque

# Verifier training dependencies are not needed for inference.
stub = types.ModuleType("openwakeword.custom_verifier_model")
stub.train_custom_verifier = None
sys.modules["openwakeword.custom_verifier_model"] = stub

import numpy as np
from openwakeword.model import Model

FRAME_BYTES = 1280 * 2
# Ushbu Mac mikrofonida aniq "Hey Jarvis" 0.19 atrofida ham chiqdi. Aksentli
# talaffuzda score bitta frame'da cho'qqiga chiqib, yon frame'larda pasayadi.
# Shu sabab qisqa temporal oyna ichida bitta asosiy va bitta yumshoq tasdiq
# talab qilinadi; juda kuchli score esa darhol trigger bo'ladi.
THRESHOLD = float(os.environ.get("OPENWAKEWORD_THRESHOLD", "0.18"))
STRONG_THRESHOLD = float(os.environ.get("OPENWAKEWORD_STRONG_THRESHOLD", "0.55"))
CONFIRM_THRESHOLD = float(os.environ.get("OPENWAKEWORD_CONFIRM_THRESHOLD", "0.06"))
CONFIRM_COUNT = max(2, int(os.environ.get("OPENWAKEWORD_CONFIRM_COUNT", "2")))
CONFIRM_WINDOW_FRAMES = max(CONFIRM_COUNT, int(os.environ.get("OPENWAKEWORD_CONFIRM_WINDOW_FRAMES", "4")))
DIAGNOSTIC_FLOOR = float(os.environ.get("OPENWAKEWORD_DIAGNOSTIC_FLOOR", "0.03"))
OWNER_PID = int(os.environ.get("JARVIS_OWNER_PID", "0") or "0")
# Shaxsiy (o'zingiz ovozingizda o'qitilgan) model skorlari ~1.0 ga yaqin va juda
# ajratuvchi: unga alohida, baland chegara beramiz. Built-in modellar yumshoq.
PERSONAL_THRESHOLD = float(os.environ.get("OPENWAKEWORD_PERSONAL_THRESHOLD", "0.6"))
PERSONAL_STRONG = float(os.environ.get("OPENWAKEWORD_PERSONAL_STRONG", "0.9"))
PERSONAL_CONFIRM = float(os.environ.get("OPENWAKEWORD_PERSONAL_CONFIRM", "0.2"))
PERSONAL_NAMES = {"jarvis"}
PROJECT_DIR = Path(__file__).resolve().parent.parent

def configured_models():
    """Resolve built-in names and optional project-relative personal models."""
    requested = [item.strip() for item in os.environ.get("OPENWAKEWORD_MODELS", "hey_jarvis").split(",") if item.strip()]
    loaded = []
    for item in requested or ["hey_jarvis"]:
        if item in {"alexa", "hey_mycroft", "hey_jarvis", "hey_rhasspy", "timer", "weather"}:
            loaded.append(item)
            continue
        model_path = Path(item).expanduser()
        if not model_path.is_absolute():
            model_path = PROJECT_DIR / model_path
        if model_path.is_file():
            loaded.append(str(model_path.resolve()))
        else:
            print(f"ERROR configured wake model not found: {model_path}", flush=True)
    return loaded or ["hey_jarvis"]

def owner_is_alive():
    if OWNER_PID <= 1:
        return True
    try:
        os.kill(OWNER_PID, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False

def watch_owner():
    """Parent daemon yo'qolsa, stdin ochiq qolgan taqdirda ham worker chiqadi."""
    while True:
        time.sleep(1.0)
        if not owner_is_alive() or os.getppid() == 1:
            os.kill(os.getpid(), signal.SIGTERM)
            return

def main():
    if OWNER_PID > 1:
        threading.Thread(target=watch_owner, name="jarvis-owner-watchdog", daemon=True).start()
    model = Model(wakeword_models=configured_models(), inference_framework="onnx")
    model_names = list(model.models.keys())
    print("MODELS " + ",".join(model_names), flush=True)
    print("READY", flush=True)
    pending = bytearray()
    recent_scores = {name: deque(maxlen=max(2, CONFIRM_WINDOW_FRAMES)) for name in model_names}
    frames_since_diagnostic = 0
    diagnostic_peak = 0.0
    while True:
        chunk = sys.stdin.buffer.read(4096)
        if not chunk:
            break
        pending.extend(chunk)
        while len(pending) >= FRAME_BYTES:
            frame = bytes(pending[:FRAME_BYTES])
            del pending[:FRAME_BYTES]
            predictions = model.predict(np.frombuffer(frame, dtype="<i2"))
            detected = None
            frame_peak = 0.0
            for name in model_names:
                score = float(predictions.get(name, 0))
                recent_scores[name].append(score)
                frame_peak = max(frame_peak, score)
                personal = name in PERSONAL_NAMES
                thr, strong, conf = ((PERSONAL_THRESHOLD, PERSONAL_STRONG, PERSONAL_CONFIRM) if personal
                                     else (THRESHOLD, STRONG_THRESHOLD, CONFIRM_THRESHOLD))
                ordered_scores = sorted(recent_scores[name], reverse=True)
                confirmed = (len(ordered_scores) >= CONFIRM_COUNT
                             and ordered_scores[0] >= thr
                             and ordered_scores[CONFIRM_COUNT - 1] >= conf)
                if score >= strong or confirmed:
                    if detected is None or score > detected[1]:
                        detected = (name, score)
            diagnostic_peak = max(diagnostic_peak, frame_peak)
            frames_since_diagnostic += 1
            if detected:
                print(f"DETECT {detected[0]} {detected[1]:.4f}", flush=True)
                for scores in recent_scores.values():
                    scores.clear()
                diagnostic_peak = 0.0
                frames_since_diagnostic = 0
            elif frames_since_diagnostic >= 12:
                if diagnostic_peak >= DIAGNOSTIC_FLOOR:
                    print(f"SCORE {diagnostic_peak:.4f}", flush=True)
                diagnostic_peak = 0.0
                frames_since_diagnostic = 0

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR {type(exc).__name__}: {exc}", flush=True)
        raise