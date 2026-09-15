#!/usr/bin/env python3
"""Benchmark an openWakeWord ONNX classifier against local and public holdouts."""

import argparse
import glob
import json
import sys
import types
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort

ROOT = Path(__file__).resolve().parent.parent
FEATURE_FRAMES = 16


def batched_scores(session, input_name, features, batch_size=512):
    declared_batch = session.get_inputs()[0].shape[0]
    if isinstance(declared_batch, int):
        batch_size = declared_batch
    output = []
    for start in range(0, len(features), batch_size):
        output.extend(session.run(None, {input_name: features[start:start + batch_size]})[0].ravel())
    return np.asarray(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=ROOT / "models/wake-word/jarvis.onnx")
    parser.add_argument("--recordings", type=Path, default=ROOT / "models/wake-word/recordings/positive/2026-09-08T16-43-59-871Z")
    parser.add_argument("--thresholds", default="0.8,0.9,0.95,0.97,0.98,0.99,0.995,0.999")
    parser.add_argument("--confirm-threshold", type=float, default=0.3)
    parser.add_argument("--strong-threshold", type=float, default=0.995)
    parser.add_argument("--confirm-count", type=int, default=2)
    args = parser.parse_args()

    onnx.checker.check_model(onnx.load(str(args.model)))
    session = ort.InferenceSession(str(args.model))
    input_name = session.get_inputs()[0].name
    corpus = np.load(ROOT / "models/wake-word/training/validation_set_features.npy", mmap_mode="r")
    split = int((len(corpus) - 16) * 0.8)
    # Consecutive embeddings match the worker's 80 ms sliding prediction cadence.
    starts = np.arange(split + 16, len(corpus) - 16)
    public_features = np.stack([corpus[index:index + 16] for index in starts]).astype(np.float32)
    public_scores = batched_scores(session, input_name, public_features)

    stub = types.ModuleType("openwakeword.custom_verifier_model")
    stub.train_custom_verifier = None
    sys.modules["openwakeword.custom_verifier_model"] = stub
    from openwakeword.model import Model
    model = Model(wakeword_models=[str(args.model)], inference_framework="onnx")
    def clip_scores(paths):
        result = []
        for path in sorted(paths):
            model.reset()
            rows = model.predict_clip(path, padding=1)
            scores = [float(next(iter(row.values()))) for row in rows]
            result.append((Path(path).name, scores))
        return result

    personal_frames = clip_scores(glob.glob(str(args.recordings / "*.wav")))
    hard_negative_frames = clip_scores(glob.glob(str(ROOT / "models/wake-word/training/synthetic/negative-*.wav")))
    personal = [(name, max(scores)) for name, scores in personal_frames]

    def temporal_detection(scores, threshold):
        recent = []
        for score in scores:
            recent = (recent + [score])[-4:]
            ordered = sorted(recent, reverse=True)
            if score >= args.strong_threshold or (len(ordered) >= args.confirm_count and ordered[0] >= threshold and ordered[args.confirm_count - 1] >= args.confirm_threshold):
                return True
        return False

    def temporal_detection_count(scores, threshold):
        detections = 0
        recent = []
        cooldown = 0
        for score in scores:
            if cooldown:
                cooldown -= 1
                continue
            recent = (recent + [score])[-4:]
            ordered = sorted(recent, reverse=True)
            if score >= args.strong_threshold or (len(ordered) >= args.confirm_count and ordered[0] >= threshold and ordered[args.confirm_count - 1] >= args.confirm_threshold):
                detections += 1
                recent = []
                cooldown = FEATURE_FRAMES
        return detections

    thresholds = [float(value) for value in args.thresholds.split(",")]
    result = {
        "model": str(args.model),
        "signature": {
            "input": session.get_inputs()[0].shape,
            "output": session.get_outputs()[0].shape,
        },
        "personalScores": {
            "count": len(personal),
            "quantiles": np.quantile([score for _, score in personal], [0, .05, .1, .25, .5, .75, 1]).round(6).tolist(),
            "lowest": sorted(personal, key=lambda item: item[1])[:10],
        },
        "publicNegativeScores": {
            "count": len(public_scores),
            "quantiles": np.quantile(public_scores, [.5, .9, .95, .99, .995, .999, 1]).round(6).tolist(),
        },
        "hardNegativeScores": {
            "count": len(hard_negative_frames),
            "peakQuantiles": np.quantile([max(scores) for _, scores in hard_negative_frames], [.5, .9, .95, .99, 1]).round(6).tolist(),
            "highest": sorted(((name, max(scores)) for name, scores in hard_negative_frames), key=lambda item: item[1], reverse=True)[:10],
        },
        "thresholds": [{
            "threshold": threshold,
            "personalRecall": round(sum(score >= threshold for _, score in personal) / len(personal), 4),
            "personalTemporalRecall": round(sum(temporal_detection(scores, threshold) for _, scores in personal_frames) / len(personal_frames), 4),
            "hardNegativeTemporalFalsePositives": int(sum(temporal_detection(scores, threshold) for _, scores in hard_negative_frames)),
            "hardNegativeFiles": len(hard_negative_frames),
            "publicFalsePositives": int(np.sum(public_scores >= threshold)),
            "publicTemporalFalsePositives": temporal_detection_count(public_scores, threshold),
            # Consecutive feature windows advance by one 80 ms embedding frame.
            "estimatedPublicFalsePositivesPerHour": round(float(np.mean(public_scores >= threshold) * (3600 / 0.08)), 4),
        } for threshold in thresholds],
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()