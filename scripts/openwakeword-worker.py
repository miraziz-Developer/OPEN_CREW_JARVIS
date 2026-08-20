#!/usr/bin/env python3
"""stdin PCM16/16kHz -> stdout READY or DETECT score."""
import os
import signal
import sys
import threading
import time
import types

# Verifier training dependencies are not needed for inference.
stub = types.ModuleType("openwakeword.custom_verifier_model")
stub.train_custom_verifier = None
sys.modules["openwakeword.custom_verifier_model"] = stub

import numpy as np
from openwakeword.model import Model

FRAME_BYTES = 1280 * 2
# Tayyor hey_jarvis modeli turli mikrofon va aksentlarda 0.55 ga kamdan-kam
# chiqadi. Pastroq threshold ketma-ket ikki ijobiy frame bilan himoyalanadi;
# juda kuchli score esa darhol trigger bo'ladi.
THRESHOLD = float(os.environ.get("OPENWAKEWORD_THRESHOLD", "0.38"))
STRONG_THRESHOLD = float(os.environ.get("OPENWAKEWORD_STRONG_THRESHOLD", "0.55"))
DIAGNOSTIC_FLOOR = float(os.environ.get("OPENWAKEWORD_DIAGNOSTIC_FLOOR", "0.08"))
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
    positive_frames = 0
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
            diagnostic_peak = max(diagnostic_peak, score)
            frames_since_diagnostic += 1

            if score >= THRESHOLD:
                positive_frames += 1
            else:
                # Bitta qisqa pasayish tabiiy talaffuzni buzmasin, ammo eski
                # tasodifiy score keyingi so'z bilan qo'shilib ketmasin.
                positive_frames = max(0, positive_frames - 1)

            if score >= STRONG_THRESHOLD or positive_frames >= 2:
                print(f"DETECT {score:.4f}", flush=True)
                positive_frames = 0
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