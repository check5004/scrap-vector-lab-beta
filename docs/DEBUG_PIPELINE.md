# Visible processing diagnostics

The panel displays artifacts from the current photo and the actual algorithm execution. A stage is disabled until it has run. No scanning animation, invented progress percentage, cached fixture prediction, or truth-derived inference is used.

1. **Input:** actual decoded/resized input pixels, dimensions, selected calibration, and safe fixture identifier (user filenames are excluded).
2. **ArUco detection:** actual decoded IDs and canonical corners; green decoded quads, amber undecoded candidate quads, and red selected reference corners. Missing and separated duplicate IDs remain visible even when calibration fails. Candidates are detector quadrilaterals, not an explanation of every rejected pixel. Only exact dictionary matches are accepted.
3. **Rectification:** actual warped pixels, chosen corner indices, source/destination points, forward/inverse homographies, output size. Fitting four reference points exactly is not an independent accuracy check.
4. **Grid:** the rectified image with the selected millimetre grid. Mode A receives this artifact; Mode B receives ungridded rectified pixels.
5. **Neural output:** actual U²-NetP first output, min-max normalized to [0,1] and shown as grayscale. These are foreground scores, not statistically calibrated probabilities. Native size is 320×320. Real worker timings separate model load, preprocessing, inference, and normalization. Indeterminate progress messages correspond to actual worker stages; no fake percentages are displayed.
6. **Binary mask:** the actual score image thresholded at the current slider value.
7. **Contours:** actual mask boundary tracing, before millimetre-space simplification. Shows all raw contours, selected largest outer component, included holes and discarded-component count. It does not infer additional holes from photo edges.
8. **Polygon:** actual simplified geometry, vertices, holes, net area and edge dimensions. Mode A's polygon instead comes from its validated API response and is explicitly labeled A.

Enable **1工程ずつ止める**, then **入力からBまで実行** to inspect each artifact before the next operation. **次の工程** advances once; **連続実行** resumes; **中止** aborts the worker/request or stage wait. Model inference itself is an atomic WASM operation in the worker: cancellation terminates that worker; there is no pretend layer-by-layer pause. Rectification and contour tracing are synchronous bounded operations and cannot be interrupted in the middle of one operation.

Selecting completed stage buttons changes only the diagnostic preview. Changing threshold/epsilon recomputes and replaces downstream artifacts. New photos/calibration invalidate previous stages/results. Retrying Mode A clears the current attempt before contacting the selected provider. The primary flow snapshots prior completed results; on failure/cancel it restores and explicitly labels that previous result, without presenting it as the failed run’s inference. A failed run never silently falls back to a different model/provider or stale A prediction. If a first B run stops after its local contour completed, the explicitly labelled partial contour is retained coherently in the scene and measurements; its later review is not presented as completed. Review attempt and unknown-charge records survive restoration of an earlier measurement.

**診断JSON** downloads metadata and timings only. It excludes image data, input filenames, API keys, authorization headers and HTTP response bodies. It can still contain the measured shape, dimensions and geometry; review it before sharing. The app never uploads this diagnostic file automatically.

## AI-texture examples

Three additional fixtures use genuine image-generated steel textures mapped inside deterministic plate polygons: `ai-l-shape`, `ai-notched`, `ai-trapezoid-hole`. Exact valid ArUco markers, board geometry, perspective and holes are rendered in code. They are labeled **AI-generated texture + controlled geometric composite**, not photographs of real measured objects. This separation gives known geometric truth while exercising more realistic appearance. It does not establish real-world metrology performance. See [asset provenance](../assets/README.md).

The original three deterministic fixtures remain available and byte-identical to the first release. Ground-truth JSON is loaded separately with the sample for later evaluation; it never enters the segmenter or API prompt.

## Verification boundaries

Unit tests use explicitly mocked provider responses to test endpoint/key routing, schema enforcement, cancellation and redaction without sending keys or incurring API charges. Browser provider tests mock success, failure, uncertainty, bounded review, and cancellation using synthetic test keys; they never make paid calls. Marker detection, all six sample images, neural inference, contour tracing, editing and downloads use real code and model execution. Container tests use the actual built Nginx image, including .mjs MIME behavior. No paid authenticated Mode A inference has been performed by the project authors during this revision.

The primary Analyze action always runs continuously, regardless of a prior expert step checkbox. Expert debug controls remain collapsed. Optional known-edge correction has a metadata-only calibration stage including the explicit factor, original reference, assumptions and the fact that photo overlays are unchanged.
