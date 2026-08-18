#!/usr/bin/env python3
"""stdin PCM16/16kHz -> stdout READY or DETECT score."""
import os
import sys
import types

# Verifier training dependencies are not needed for inference.
stub = types.ModuleType("openwakeword.custom_verifier_model")
stub.train_custom_verifier = None
sys.modules["openwakeword.custom_verifier_model"] = stub

import numpy as np
from openwakeword.model import Model

FRAME_BYTES = 1280 * 2
THRESHOLD = float(os.environ.get("OPENWAKEWORD_THRESHOLD", "0.55"))

def main():
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    print("READY", flush=True)
    pending = bytearray()
    while True:
        chunk = sys.stdin.buffer.read(4096)
        if not chunk:
            break
        pending.extend(chunk)
        while len(pending) >= FRAME_BYTES:
            frame = bytes(pending[:FRAME_BYTES])
            del pending[:FRAME_BYTES]
            score = float(model.predict(np.frombuffer(frame, dtype="<i2")).get("hey_jarvis", 0))
            if score >= THRESHOLD:
                print(f"DETECT {score:.4f}", flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR {type(exc).__name__}: {exc}", flush=True)
        raise