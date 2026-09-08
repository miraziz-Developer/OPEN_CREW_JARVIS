#!/usr/bin/env python3
"""stdin PCM16/16kHz -> stdout READY or DETECT score."""
import os
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
CONFIRM_WINDOW_FRAMES = int(os.environ.get("OPENWAKEWORD_CONFIRM_WINDOW_FRAMES", "4"))
DIAGNOSTIC_FLOOR = float(os.environ.get("OPENWAKEWORD_DIAGNOSTIC_FLOOR", "0.03"))
OWNER_PID = int(os.environ.get("JARVIS_OWNER_PID", "0") or "0")

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
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    print("READY", flush=True)
    pending = bytearray()
    recent_scores = deque(maxlen=max(2, CONFIRM_WINDOW_FRAMES))
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
            score = float(model.predict(np.frombuffer(frame, dtype="<i2")).get("hey_jarvis", 0))
            recent_scores.append(score)
            diagnostic_peak = max(diagnostic_peak, score)
            frames_since_diagnostic += 1

            ordered_scores = sorted(recent_scores, reverse=True)
            confirmed = (len(ordered_scores) >= 2
                         and ordered_scores[0] >= THRESHOLD
                         and ordered_scores[1] >= CONFIRM_THRESHOLD)
            if score >= STRONG_THRESHOLD or confirmed:
                print(f"DETECT {score:.4f}", flush=True)
                recent_scores.clear()
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