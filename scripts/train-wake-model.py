#!/usr/bin/env python3
"""Train a local openWakeWord-compatible Jarvis classifier.

The script keeps personal recordings local, synthesizes extra positive and hard
negative speech with macOS voices, and uses the public openWakeWord validation
feature corpus as general speech/noise/music negatives.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RECORDINGS = ROOT / "models/wake-word/recordings/positive/2026-09-08T16-43-59-871Z"
TRAINING_DIR = ROOT / "models/wake-word/training"
NEGATIVE_FEATURES = TRAINING_DIR / "validation_set_features.npy"
OUTPUT_MODEL = ROOT / "models/wake-word/jarvis.onnx"
REPORT_PATH = ROOT / "models/wake-word/jarvis-training-report.json"
SAMPLE_RATE = 16_000
CLIP_SAMPLES = SAMPLE_RATE * 2
FEATURE_FRAMES = 16
SEED = 20260908

POSITIVE_TEXTS = ("Jarvis", "jarvis", "Jar-vis")
HARD_NEGATIVE_TEXTS = (
    "Travis", "service", "justice", "jars", "Jarvin", "Jervis", "harvest",
    "artists", "charge this", "start this", "darkness", "gorgeous",
)


@dataclass(frozen=True)
class Clip:
    name: str
    audio: np.ndarray


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train models/wake-word/jarvis.onnx locally")
    parser.add_argument("--recordings", type=Path, default=DEFAULT_RECORDINGS)
    parser.add_argument("--output", type=Path, default=OUTPUT_MODEL)
    parser.add_argument("--report", type=Path, default=REPORT_PATH)
    parser.add_argument("--epochs", type=int, default=35)
    parser.add_argument("--personal-augmentations", type=int, default=48)
    parser.add_argument("--synthetic-augmentations", type=int, default=24)
    parser.add_argument("--hard-negative-augmentations", type=int, default=24)
    parser.add_argument("--negative-windows", type=int, default=30_000)
    parser.add_argument("--mined-negative-windows", type=int, default=3_000)
    parser.add_argument("--mining-epochs", type=int, default=8)
    parser.add_argument("--skip-synthesis", action="store_true")
    return parser.parse_args()


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wav_file:
        if (wav_file.getframerate(), wav_file.getnchannels(), wav_file.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise ValueError(f"{path} 16 kHz mono PCM16 emas")
        return np.frombuffer(wav_file.readframes(wav_file.getnframes()), dtype="<i2").copy()


def fit_clip(audio: np.ndarray, rng: np.random.Generator, random_position: bool = False) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32)
    active = np.flatnonzero(np.abs(audio) > max(80, np.max(np.abs(audio)) * 0.015))
    if len(active):
        audio = audio[max(0, active[0] - 800):min(len(audio), active[-1] + 1200)]
    if len(audio) > CLIP_SAMPLES:
        start = max(0, (len(audio) - CLIP_SAMPLES) // 2)
        audio = audio[start:start + CLIP_SAMPLES]
    if len(audio) < CLIP_SAMPLES:
        room = CLIP_SAMPLES - len(audio)
        before = int(rng.integers(max(1, room // 8), max(2, room * 5 // 8))) if random_position else room // 3
        before = min(before, room)
        audio = np.pad(audio, (before, room - before))
    return audio[:CLIP_SAMPLES]


def augment(audio: np.ndarray, rng: np.random.Generator, strength: float = 1.0) -> np.ndarray:
    x = fit_clip(audio, rng).astype(np.float32)
    # Small temporal shift preserves the word while varying its location in the 2 s window.
    shift = int(rng.integers(-2400, 2401) * strength)
    if shift > 0:
        x = np.pad(x, (shift, 0))[:CLIP_SAMPLES]
    elif shift < 0:
        x = np.pad(x[-shift:], (0, -shift))[:CLIP_SAMPLES]
    x *= float(rng.uniform(0.45, 1.35))

    if rng.random() < 0.65 * strength:
        # Short synthetic room response; direct path remains dominant.
        rir = np.zeros(int(rng.integers(500, 2200)), dtype=np.float32)
        rir[0] = 1.0
        for _ in range(int(rng.integers(2, 7))):
            index = int(rng.integers(100, len(rir)))
            rir[index] += float(rng.uniform(0.03, 0.22) * math.exp(-index / len(rir)))
        x = signal.fftconvolve(x, rir, mode="full")[:CLIP_SAMPLES]

    if rng.random() < 0.7 * strength:
        low = float(rng.uniform(55, 180))
        high = float(rng.uniform(3500, 7600))
        sos = signal.butter(2, [low, high], btype="bandpass", fs=SAMPLE_RATE, output="sos")
        x = signal.sosfilt(sos, x)

    if rng.random() < 0.9 * strength:
        rms = float(np.sqrt(np.mean(x * x)) + 1e-6)
        snr_db = float(rng.uniform(7, 32))
        noise = rng.normal(0, rms / (10 ** (snr_db / 20)), CLIP_SAMPLES)
        # Add low-frequency environmental hum to part of the examples.
        if rng.random() < 0.35:
            t = np.arange(CLIP_SAMPLES) / SAMPLE_RATE
            noise += (rms * rng.uniform(0.01, 0.08)) * np.sin(2 * np.pi * rng.choice([50, 60, 100, 120]) * t)
        x += noise

    peak = float(np.max(np.abs(x)))
    if peak > 31_000:
        x *= 31_000 / peak
    return np.rint(x).astype(np.int16)


def macos_english_voices() -> list[str]:
    output = subprocess.check_output(["say", "-v", "?"], text=True)
    voices = []
    excluded = {
        "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos",
        "Good News", "Jester", "Organ", "Superstar", "Trinoids", "Whisper",
        "Wobble", "Zarvox",
    }
    for line in output.splitlines():
        match = re.match(r"^(.*?)\s{2,}(en_[A-Z]{2})\s+#", line)
        if match and match.group(1).strip() not in excluded:
            voices.append(match.group(1).strip())
    if len(voices) < 6:
        raise RuntimeError("Kamida 6 ta macOS English voice kerak")
    return voices


def synthesize(cache: Path) -> tuple[list[Path], list[Path], list[str], list[str]]:
    cache.mkdir(parents=True, exist_ok=True)
    voices = macos_english_voices()
    # Voice-level split prevents validation leakage from the same synthesizer voice.
    validation_voices = voices[::5]
    training_voices = [voice for voice in voices if voice not in validation_voices]
    positive_paths, negative_paths = [], []
    jobs = []
    for voice in voices:
        for text_index, text in enumerate(POSITIVE_TEXTS):
            jobs.append(("positive", voice, text_index, text))
        for text_index, text in enumerate(HARD_NEGATIVE_TEXTS):
            jobs.append(("negative", voice, text_index, text))
    expected = set()
    for kind, voice, text_index, text in jobs:
        safe_voice = re.sub(r"[^A-Za-z0-9]+", "_", voice).strip("_")
        wav_path = cache / f"{kind}-{safe_voice}-{text_index:02d}.wav"
        expected.add(wav_path.resolve())
        if not wav_path.exists():
            aiff_path = wav_path.with_suffix(".aiff")
            rate = str(165 + (text_index % 4) * 12)
            subprocess.run(
                ["say", "-v", voice, "-r", rate, "-o", str(aiff_path), text],
                check=True, stdin=subprocess.DEVNULL, timeout=30,
            )
            subprocess.run([
                "ffmpeg", "-loglevel", "error", "-y", "-i", str(aiff_path),
                "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(wav_path),
            ], check=True, stdin=subprocess.DEVNULL, timeout=30)
            aiff_path.unlink(missing_ok=True)
        (positive_paths if kind == "positive" else negative_paths).append(wav_path)
    for stale in cache.glob("*.wav"):
        if stale.resolve() not in expected:
            stale.unlink()
    return positive_paths, negative_paths, training_voices, validation_voices


def voice_from_filename(path: Path) -> str:
    return path.stem.rsplit("-", 1)[0].split("-", 1)[1]


def make_augmented(clips: list[Clip], count: int, rng: np.random.Generator, strength: float = 1.0) -> np.ndarray:
    output = []
    for clip in clips:
        output.append(fit_clip(clip.audio, rng).astype(np.int16))
        for _ in range(max(0, count - 1)):
            output.append(augment(clip.audio, rng, strength))
    return np.stack(output)


def extract_features(audio: np.ndarray) -> np.ndarray:
    # Import lazily so --help and input validation remain useful without ML dependencies.
    from openwakeword.utils import AudioFeatures
    extractor = AudioFeatures(inference_framework="onnx", ncpu=4)
    features = extractor.embed_clips(audio, batch_size=64, ncpu=4)
    if features.shape[1:] != (FEATURE_FRAMES, 96):
        raise RuntimeError(f"Kutilmagan openWakeWord feature shape: {features.shape}")
    return features.astype(np.float32)


def extract_sliding_features(audio: np.ndarray, stride: int = 2) -> np.ndarray:
    """Extract worker-like windows from clips with one second of context padding."""
    from openwakeword.utils import AudioFeatures
    padded = np.pad(audio, ((0, 0), (SAMPLE_RATE, SAMPLE_RATE)))
    extractor = AudioFeatures(inference_framework="onnx", ncpu=4)
    embeddings = extractor.embed_clips(padded, batch_size=32, ncpu=4).astype(np.float32)
    windows = []
    for clip_features in embeddings:
        windows.extend(
            clip_features[start:start + FEATURE_FRAMES]
            for start in range(0, len(clip_features) - FEATURE_FRAMES + 1, stride)
        )
    return np.stack(windows)


def public_windows(features: np.ndarray, starts: np.ndarray) -> np.ndarray:
    return np.stack([features[index:index + FEATURE_FRAMES] for index in starts]).astype(np.float32)


def evaluate(scores: np.ndarray, labels: np.ndarray, threshold: float) -> dict[str, float | int]:
    predictions = scores >= threshold
    positive = labels == 1
    negative = ~positive
    return {
        "threshold": round(float(threshold), 4),
        "recall": round(float(np.mean(predictions[positive])) if np.any(positive) else 0.0, 4),
        "falsePositiveRate": round(float(np.mean(predictions[negative])) if np.any(negative) else 0.0, 8),
        "falsePositives": int(np.sum(predictions[negative])),
        "negativeExamples": int(np.sum(negative)),
    }


def display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path.resolve())


def main() -> None:
    args = parse_args()
    if args.epochs < 1 or args.negative_windows < 1000:
        raise ValueError("--epochs >= 1 va --negative-windows >= 1000 bo‘lishi kerak")
    rng = np.random.default_rng(SEED)
    random.seed(SEED)

    manifest_path = args.recordings / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    accepted, rejected = [], []
    for item in manifest["samples"]:
        # RMS 120 removes effectively silent captures while retaining quiet real speech.
        if item["rms"] < 120 or item["peak"] < 2000 or item["clippedRatio"] > 0.002:
            rejected.append(item["file"])
        else:
            accepted.append(Clip(item["file"], read_wav(args.recordings / item["file"])))
    if len(accepted) < 20:
        raise RuntimeError(f"Sifatli personal sample yetarli emas: {len(accepted)}")
    random.Random(SEED).shuffle(accepted)
    holdout_count = max(8, len(accepted) // 5)
    personal_val, personal_train = accepted[:holdout_count], accepted[holdout_count:]

    synth_dir = TRAINING_DIR / "synthetic"
    positive_paths: list[Path] = []
    negative_paths: list[Path] = []
    training_voices: list[str] = []
    validation_voices: list[str] = []
    if not args.skip_synthesis:
        positive_paths, negative_paths, training_voices, validation_voices = synthesize(synth_dir)

    synthetic_train = [Clip(path.name, read_wav(path)) for path in positive_paths if voice_from_filename(path) in {re.sub(r'[^A-Za-z0-9]+', '_', v).strip('_') for v in training_voices}]
    synthetic_val = [Clip(path.name, read_wav(path)) for path in positive_paths if voice_from_filename(path) in {re.sub(r'[^A-Za-z0-9]+', '_', v).strip('_') for v in validation_voices}]
    hard_train = [Clip(path.name, read_wav(path)) for path in negative_paths if voice_from_filename(path) in {re.sub(r'[^A-Za-z0-9]+', '_', v).strip('_') for v in training_voices}]
    hard_val = [Clip(path.name, read_wav(path)) for path in negative_paths if voice_from_filename(path) in {re.sub(r'[^A-Za-z0-9]+', '_', v).strip('_') for v in validation_voices}]

    print(f"Personal: train={len(personal_train)}, holdout={len(personal_val)}, rejected={rejected}", flush=True)
    print(f"Synthetic: positive train={len(synthetic_train)}, val={len(synthetic_val)}; hard-negative train={len(hard_train)}, val={len(hard_val)}", flush=True)

    train_positive_audio = make_augmented(personal_train, args.personal_augmentations, rng)
    if synthetic_train:
        train_positive_audio = np.vstack((train_positive_audio, make_augmented(synthetic_train, args.synthetic_augmentations, rng, 0.8)))
    val_positive_audio = make_augmented(personal_val, 8, rng, 0.7)
    if synthetic_val:
        val_positive_audio = np.vstack((val_positive_audio, make_augmented(synthetic_val, 4, rng, 0.6)))
    hard_train_audio = make_augmented(hard_train, args.hard_negative_augmentations, rng, 0.8) if hard_train else np.empty((0, CLIP_SAMPLES), np.int16)
    hard_val_audio = make_augmented(hard_val, 5, rng, 0.7) if hard_val else np.empty((0, CLIP_SAMPLES), np.int16)

    print("Positive va hard-negative feature extraction...", flush=True)
    x_pos = extract_features(train_positive_audio)
    x_val_pos = extract_features(val_positive_audio)
    x_hard = extract_sliding_features(hard_train_audio) if len(hard_train_audio) else np.empty((0, FEATURE_FRAMES, 96), np.float32)
    x_val_hard = extract_sliding_features(hard_val_audio) if len(hard_val_audio) else np.empty((0, FEATURE_FRAMES, 96), np.float32)

    corpus = np.load(NEGATIVE_FEATURES, mmap_mode="r")
    max_start = len(corpus) - FEATURE_FRAMES
    # Last 20% is held out; no overlapping train/validation windows cross the boundary.
    split = int(max_start * 0.8)
    train_starts = rng.integers(0, split - FEATURE_FRAMES, size=args.negative_windows)
    val_starts = np.arange(split + FEATURE_FRAMES, max_start, 16)
    if len(val_starts) > 8_000:
        val_starts = rng.choice(val_starts, 8_000, replace=False)
    x_public = public_windows(corpus, train_starts)
    x_val_public = public_windows(corpus, np.sort(val_starts))

    x_train = np.vstack((x_pos, x_hard, x_public))
    y_train = np.concatenate((np.ones(len(x_pos)), np.zeros(len(x_hard) + len(x_public)))).astype(np.float32)
    order = rng.permutation(len(y_train))
    x_train, y_train = x_train[order], y_train[order]

    import torch
    from torch import nn
    torch.manual_seed(SEED)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")

    class JarvisClassifier(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.flatten = nn.Flatten()
            self.network = nn.Sequential(
                nn.Linear(FEATURE_FRAMES * 96, 64), nn.LayerNorm(64), nn.ReLU(), nn.Dropout(0.12),
                nn.Linear(64, 32), nn.LayerNorm(32), nn.ReLU(),
                nn.Linear(32, 1),
            )

        def forward(self, value):
            return self.network(self.flatten(value))

    model = JarvisClassifier().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=4e-4, weight_decay=1e-4)
    # A fully balanced weight (~14x here) over-predicts on continuous background.
    # Cap the positive weight while still compensating for class imbalance.
    positive_weight = min(2.0, float((len(y_train) - y_train.sum()) / y_train.sum()))
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor([positive_weight], device=device))
    dataset = torch.utils.data.TensorDataset(torch.from_numpy(x_train), torch.from_numpy(y_train[:, None]))
    loader = torch.utils.data.DataLoader(dataset, batch_size=256, shuffle=True)
    best_state, best_loss = None, float("inf")
    x_quick_val = np.vstack((x_val_pos, x_val_hard, x_val_public[:2000]))
    y_quick_val = np.concatenate((np.ones(len(x_val_pos)), np.zeros(len(x_val_hard) + min(2000, len(x_val_public))))).astype(np.float32)

    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for batch_x, batch_y in loader:
            batch_x, batch_y = batch_x.to(device), batch_y.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(batch_x), batch_y)
            loss.backward()
            optimizer.step()
            total += float(loss.detach().cpu()) * len(batch_x)
        model.eval()
        with torch.no_grad():
            val_logits = model(torch.from_numpy(x_quick_val).to(device))
            val_loss = float(loss_fn(val_logits, torch.from_numpy(y_quick_val[:, None]).to(device)).cpu())
        if val_loss < best_loss:
            best_loss = val_loss
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
        print(f"epoch={epoch + 1:02d}/{args.epochs} train_loss={total / len(dataset):.5f} val_loss={val_loss:.5f}", flush=True)

    model.load_state_dict(best_state)
    # Mine the train-only corpus for windows the first-stage classifier finds
    # most confusing. This targets rare false activations without leaking the
    # untouched final 20% corpus into training.
    if args.mined_negative_windows > 0 and args.mining_epochs > 0:
        model.eval()
        mining_starts = np.arange(0, split - FEATURE_FRAMES, 2)
        mining_scores = np.empty(len(mining_starts), dtype=np.float32)
        with torch.no_grad():
            for offset in range(0, len(mining_starts), 1024):
                indices = mining_starts[offset:offset + 1024]
                batch = public_windows(corpus, indices)
                mining_scores[offset:offset + len(indices)] = torch.sigmoid(
                    model(torch.from_numpy(batch).to(device))
                ).cpu().numpy().ravel()
        count = min(args.mined_negative_windows, len(mining_starts))
        selected = np.argpartition(mining_scores, -count)[-count:]
        x_mined = public_windows(corpus, mining_starts[selected])
        print(
            f"Hard mining: {count} window, score range="
            f"{mining_scores[selected].min():.5f}..{mining_scores[selected].max():.5f}",
            flush=True,
        )
        x_fine = np.vstack((x_pos, x_hard, x_mined))
        y_fine = np.concatenate((np.ones(len(x_pos)), np.zeros(len(x_hard) + len(x_mined)))).astype(np.float32)
        fine_order = rng.permutation(len(y_fine))
        fine_dataset = torch.utils.data.TensorDataset(
            torch.from_numpy(x_fine[fine_order]), torch.from_numpy(y_fine[fine_order, None])
        )
        fine_loader = torch.utils.data.DataLoader(fine_dataset, batch_size=256, shuffle=True)
        optimizer = torch.optim.AdamW(model.parameters(), lr=8e-5, weight_decay=2e-4)
        with torch.no_grad():
            initial_scores = torch.sigmoid(model(torch.from_numpy(x_quick_val).to(device))).cpu().numpy().ravel()
        quick_positive_count = len(x_val_pos)
        mined_best_fp = int(np.sum(initial_scores[quick_positive_count:] >= 0.995))
        mined_best_loss = best_loss
        mined_best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
        for epoch in range(args.mining_epochs):
            model.train()
            total = 0.0
            for batch_x, batch_y in fine_loader:
                batch_x, batch_y = batch_x.to(device), batch_y.to(device)
                optimizer.zero_grad(set_to_none=True)
                loss = loss_fn(model(batch_x), batch_y)
                loss.backward()
                optimizer.step()
                total += float(loss.detach().cpu()) * len(batch_x)
            model.eval()
            with torch.no_grad():
                val_logits = model(torch.from_numpy(x_quick_val).to(device))
                val_loss = float(loss_fn(val_logits, torch.from_numpy(y_quick_val[:, None]).to(device)).cpu())
                epoch_scores = torch.sigmoid(val_logits).cpu().numpy().ravel()
            personal_recall = float(np.mean(epoch_scores[:len(personal_val) * 8] >= 0.995))
            validation_fp = int(np.sum(epoch_scores[quick_positive_count:] >= 0.995))
            if personal_recall >= 0.95 and (validation_fp < mined_best_fp or (validation_fp == mined_best_fp and val_loss < mined_best_loss)):
                mined_best_fp = validation_fp
                mined_best_loss = val_loss
                mined_best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            print(
                f"mining_epoch={epoch + 1:02d}/{args.mining_epochs} "
                f"train_loss={total / len(fine_dataset):.5f} val_loss={val_loss:.5f} "
                f"personal_recall={personal_recall:.4f} validation_fp={validation_fp}",
                flush=True,
            )
        model.load_state_dict(mined_best_state)
    model.cpu().eval()
    x_val = np.vstack((x_val_pos, x_val_hard, x_val_public))
    y_val = np.concatenate((np.ones(len(x_val_pos)), np.zeros(len(x_val_hard) + len(x_val_public)))).astype(np.float32)
    with torch.no_grad():
        scores = torch.sigmoid(model(torch.from_numpy(x_val))).numpy().ravel()

    # Choose the strictest threshold that keeps at least 95% positive holdout recall.
    positive_scores = scores[y_val == 1]
    personal_count = len(personal_val) * 8
    personal_scores = positive_scores[:personal_count]
    threshold = float(np.clip(np.quantile(personal_scores, 0.05), 0.1, 0.995))
    metrics = evaluate(scores, y_val, threshold)
    metrics["personalRecall"] = round(float(np.mean(personal_scores >= threshold)), 4)
    metrics["hardNegativeFalsePositives"] = int(np.sum(scores[len(positive_scores):len(positive_scores) + len(x_val_hard)] >= threshold))
    metrics["hardNegativeExamples"] = len(x_val_hard)
    metrics["publicFalsePositives"] = int(np.sum(scores[len(positive_scores) + len(x_val_hard):] >= threshold))
    metrics["publicNegativeExamples"] = len(x_val_public)
    metrics["minimumPositiveScore"] = round(float(np.min(positive_scores)), 6)
    metrics["medianPositiveScore"] = round(float(np.median(positive_scores)), 6)
    negative_scores = scores[len(positive_scores):]
    metrics["maximumNegativeScore"] = round(float(np.max(negative_scores)), 6)

    args.output.parent.mkdir(parents=True, exist_ok=True)

    class ExportModel(nn.Module):
        def __init__(self, classifier):
            super().__init__()
            self.classifier = classifier

        def forward(self, value):
            return torch.sigmoid(self.classifier(value))

    torch.onnx.export(
        ExportModel(model), torch.zeros((1, FEATURE_FRAMES, 96), dtype=torch.float32), str(args.output),
        input_names=["audio_features"], output_names=["jarvis"], opset_version=17, dynamo=False,
        dynamic_axes={"audio_features": {0: "batch"}, "jarvis": {0: "batch"}},
    )
    report = {
        "model": display_path(args.output),
        "seed": SEED,
        "recordings": str(args.recordings),
        "rejectedPersonalSamples": rejected,
        "counts": {
            "personalTrainFiles": len(personal_train), "personalValidationFiles": len(personal_val),
            "syntheticTrainFiles": len(synthetic_train), "syntheticValidationFiles": len(synthetic_val),
            "positiveTrainingExamples": len(x_pos), "hardNegativeTrainingExamples": len(x_hard),
            "publicNegativeTrainingExamples": len(x_public), "validationExamples": len(x_val),
            "minedNegativeTrainingExamples": args.mined_negative_windows,
        },
        "metrics": metrics,
        "recommendedThreshold": metrics["threshold"],
    }
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Training xatosi: {type(error).__name__}: {error}", file=sys.stderr)
        raise