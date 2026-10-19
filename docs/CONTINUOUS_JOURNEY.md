# Continuous measurement journey

The main scene follows one photo from its detected calibration markers to its measured outline. Choose **写真から寸法まで** to run real calibration and local Mode B inference in one action. **B · 端末内AIで輪郭を抽出** reruns just inference on the calibrated image. No API key or paid inference is needed for Mode B.

## What the scene shows

1. **Source photo:** the actual image decoded by this browser, after the normal processing-size limit and orientation handling.
2. **Markers:** the actual ArUco IDs, decoded corner positions and selected reference corners. The required board IDs are 0, 1, 2 and 3; their canonical reference-corner indices are `[2, 3, 0, 1]`.
3. **Crop:** the working quadrilateral bounded by those measured reference corners. This is a view of the calibration region, not an AI detection of the scrap edge.
4. **Perspective correction:** a transition from that source quadrilateral to the flat board. The moving intermediate projection is an approximate explanatory rendering. Do not measure from a moving frame. The settled rectified image is the real homography output used by the pipeline.
5. **Neural mask:** the actual local U²-NetP / ONNX result and its current thresholded mask. Foreground scores are min-max normalized model output, not calibrated confidence. If the model misses a hole, the journey also misses it.
6. **Contours and simplification:** the real mask boundary points, followed by the actual simplified millimetre-space polygon. Neither fixture truth nor hand-authored sample coordinates substitute for inference.
7. **Dimensions:** lengths and area from the current validated geometry, using the selected board size. Review the final outline and holes against the photograph before exporting.

The journey intentionally does not invent a completed stage. A missing/invalid marker set has no successful crop or rectified result. A cancelled or failed inference has no successful neural outline or dimensions. Details of the last real completed operation can still be inspected in the diagnostics panel. See [processing diagnostics](DEBUG_PIPELINE.md) for the individual artifacts and metadata.

## Playback is separate from processing

Playback controls change the explanation, not algorithm timing:

- **Pause / resume (一時停止 / 再生):** hold or continue the visual journey. Real processing can continue while the picture is paused.
- **Skip (最新の結果へ):** jump to the latest artifact that actually exists. It does not manufacture a result, finish inference, or release a diagnostic step wait.
- **Replay (最初から):** replay the available artifacts from the current run. It does not rerun ArUco, execute ONNX again, or send an API request.

The processing status tells you whether real work is running, complete, cancelled or failed. Playback duration is presentation pacing, not processing progress, an ETA or a benchmark. A slow model load can leave the scene waiting for the mask; a fast result can be ready before the visual explanation reaches it. Real measured timings remain in the diagnostics.

**処理を中止**, visible while processing is running, actually cancels the worker/request or diagnostic wait. It clears uncommitted neural stages; the last valid source/calibration can remain available. This is different from visual pause.

For actual operation-by-operation execution, open diagnostics and use **1工程ずつ止める**, **次の工程**, **連続実行** and **中止**. These controls intentionally affect computation. They are distinct from the journey's visual pause and replay. WASM inference cannot pause partway through a neural layer; cancelling terminates its worker.

## Repeated and interrupted work

A new photo or calibration invalidates the previous journey's downstream artifacts. A new sample can be chosen while only playback remains active. Source controls remain locked during real processing or a diagnostic step wait; finish or cancel that processing first.

Rerunning Mode B clears its old mask, contours and dimensions before the replacement result exists. Adjusting threshold or simplification tolerance rebuilds the affected downstream stages from the current real mask. Opening **編集・比較** or entering Mode C stops playback and removes the journey's neural overlays and dimensions. The editor retains its real geometry for review/editing; manually edited dimensions belong to Mode C. Replay does not resurrect those removed overlays. Run Mode B again, or explicitly recompute from the retained mask with threshold/tolerance controls, to build a current neural journey.

## Phones, accessibility and reduced motion

The scene resizes to the available width; its image, overlays and labels share the same coordinate mapping. Playback actions are buttons usable by keyboard or touch. At narrow widths, controls wrap instead of forcing page-wide horizontal scrolling. Scrolling the page should remain possible without precision dragging in the scene.

The system's **prefers-reduced-motion** setting removes continuous camera/warp movement and shows stable, available stage results instead. It does not disable genuine marker detection, model inference, inspection or export. Device emulation is useful for overflow and touch-target regression tests; it is not proof of native iPhone camera, HEIC or assistive-technology behavior. See [photo import](PHOTO_IMPORT.md) for the physical-device checklist.

## Coordinate and accuracy contract

- Detected markers and the crop are in decoded **source-image pixels**. The homography maps their selected corners to the rectified board pixel bounds.
- Rectified image dimensions come from the chosen board preset/custom calibration. The A4 working region is **250 × 170 mm**, rendered at **2500 × 1700 px**.
- The neural mask is **320 × 320**. Raw contour sample `(x, y)` maps to `((x + 0.5) × boardWidth / maskWidth, (y + 0.5) × boardHeight / maskHeight)` millimetres. Horizontal and vertical scales are deliberately separate.
- Simplification is applied in millimetres. Final SVG view mapping preserves the same geometry and dimensions as the editor/export; browser resizing only changes screen placement.
- The CSS plane uses a normalized **100 × 100 CSS-unit** domain to avoid browser precision loss in tiny perspective coefficients. This is coordinate conditioning only: the native rectified and mask canvas buffers retain their real resolutions and are not downsampled to 100 × 100. The logical pixel-to-scene map and the conditioned CSS map have the same endpoints. Native-sized inner canvas layers are affinely scaled into that domain, with 3D compositing preserved so a moving perspective plane can retain the photograph's fine texture. The mask still uses its genuine native resolution.
- The intermediate animated projection is illustrative. The settled rectified image and final contour coordinates come from the real pipeline; the animation does not improve their accuracy.

A **0.1 mm/px** raster spacing is not a measurement-accuracy claim. Native model resolution, missed holes, lens distortion, tilt, glare, print scaling, thickness and non-coplanarity can dominate error. Keep reference markers and the measured surface coplanar, verify the printed ruler and check important dimensions physically.

## Developer verification

The dedicated browser suite is `tests/browser/journey.spec.ts`. It loads the repository's real sample images, genuine ArUco dictionary, pinned ONNX model and local WASM runtime. It cross-checks the journey against diagnostic artifacts and geometry; it never mocks a neural prediction. Transient empty corner probes and the painted canvas bounds measure actual browser layout against the shared image/SVG map within 0.05 screen pixels, rather than trusting serialized computed-style matrix text. Every test blocks off-origin HTTP(S) requests before navigation. No paid provider call or real API key is used.

Run after preparing the normal project assets:

```sh
npm test
npm run build
npx playwright test tests/browser/journey.spec.ts
```

Successful runs save clipped source, marker, crop, rectified, mask, contour and dimension screenshots, a real 180°-rotated-photo projective midpoint, an invalid-marker-orientation scene, and mobile layout captures under Playwright's `test-results` output. Review these artifacts for visual continuity as well as reading assertion results.

The full browser command includes desktop Chromium and Pixel 7 emulation. CI also exercises the built app and container. If the execution sandbox blocks launching Chromium, record browser checks as **not run**; do not change browser security flags, escalate, or claim a pass from TypeScript compilation. Keep unit/build, browser and physical-device verification results separate.
