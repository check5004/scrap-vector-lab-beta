#!/usr/bin/env python3
"""Independent faithful rembg ONNX baseline; not browser end-to-end validation.

Requires: pip install onnxruntime opencv-python-headless pillow numpy
The model only receives fixture pixels. Ground truth is loaded after inference
to calculate metrics, never to repair masks or to substitute model results.
"""
import json
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    session = ort.InferenceSession(str(ROOT / "public/models/u2netp.onnx"), providers=["CPUExecutionProvider"])
    results = []
    for name in ("l-shape", "notched", "trapezoid-hole"):
        im = Image.open(ROOT / f"public/samples/{name}.rectified.png").convert("RGB").resize((320, 320), Image.Resampling.LANCZOS)
        rgb = np.asarray(im).astype(np.float32)
        rgb /= max(float(rgb.max()), 1e-6)
        rgb = (rgb - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
        tensor = rgb.transpose(2, 0, 1)[None]
        start = time.perf_counter()
        probability = session.run(None, {session.get_inputs()[0].name: tensor})[0][0, 0]
        span = float(probability.max() - probability.min())
        if span < 1e-8:
            raise ValueError("Model returned a uniform mask")
        probability = (probability - probability.min()) / span
        elapsed = time.perf_counter() - start
        mask = cv2.resize(probability, (2500, 1700), interpolation=cv2.INTER_LINEAR) > .5
        truth = np.asarray(Image.open(ROOT / f"public/samples/{name}.mask.png")) > 127
        contours, hierarchy = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        holes = [] if hierarchy is None else [cv2.contourArea(c) * .01 for c, h in zip(contours, hierarchy[0]) if h[3] >= 0 and cv2.contourArea(c) > 25]
        result = {"sample": name, "elapsed_s": round(elapsed, 3),
                  "mask_iou": float((mask & truth).sum() / (mask | truth).sum()),
                  "mask_area_mm2": float(mask.sum() * .01), "holes_area_mm2": holes}
        results.append(result)
        print(json.dumps(result), flush=True)
    report = {"note": "Python ONNX CPU on exact generated rectified images; faithful rembg normalization. Independent baseline, not browser end-to-end evidence. No truth used by AI.",
              "model": "u2netp.onnx", "threshold": .5, "onnxruntime_version": ort.__version__, "results": results}
    (ROOT / "public/samples/u2netp-python-baseline.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
