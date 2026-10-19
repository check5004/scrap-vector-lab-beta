# Runtime feasibility and measurement limits

Verified 2026-10-15. This document distinguishes implementation choices from a validated metrology specification. Suggested validity thresholds below are engineering safeguards, not an industry certification or an accuracy guarantee.

## Recommended static implementation

- Browser-local ArUco detection: `js-aruco2@2.0.0`, with the exact OpenCV `DICT_4X4_50` code list generated into `public/print/dictionary.json`.
- Local segmentation: the actual U²-NetP ONNX model distributed by rembg, with `onnxruntime-web@1.23.2` WebAssembly in a dedicated worker. The model is 4,574,861 bytes; the separately bundled runtime adds about 12 MB. Do not count only model bytes as the total download.
- Set `ort.env.wasm.numThreads = 1` for hosts without cross-origin isolation. WASM works across a broader browser matrix than WebGPU; worker offload keeps inference off the interaction thread. Load JS and WASM files from the same runtime version. [ONNX Runtime browser support](https://onnxruntime.ai/docs/get-started/with-javascript/web.html), [environment flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).
- Host all model/runtime assets with the site. GitHub release downloads are an appropriate build-time provenance source but do not assume their redirect chain is a dependable browser CORS endpoint.
- Separate an explicit synthetic demonstration or imported truth geometry from inference. A failed or unavailable AI must display a failure; never substitute color thresholding or fixture truth under the AI label.

This is genuinely neural salient-object segmentation, but U²-NetP is a small general model, not a metal metrology model. Its native 320 × 320 input is roughly 0.78125 mm horizontally and 0.53125 mm vertically over a 250 × 170 mm board. Enlarging its output to 2500 × 1700 gives a finer display grid, not new visual detail. Real performance on glare, scratches, small holes and thin bridges must be measured. [Upstream U²-Net project](https://github.com/xuebinqin/U-2-Net), [rembg model session](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/u2netp.py).

### Exact U²-NetP data contract

1. RGB-convert and resize the image to 320 × 320. Upstream rembg uses Lanczos; Canvas resizing is an implementation difference that should be recorded in benchmark comparisons.
2. Divide every RGB value by the maximum channel value over the resized image, clamped to at least 1e-6. This is the upstream implementation, rather than an unconditional division by 255.
3. Subtract channel means `[0.485, 0.456, 0.406]` and divide by standard deviations `[0.229, 0.224, 0.225]`.
4. Supply float32 NCHW `[1,3,320,320]` to the runtime's actual first input name.
5. Use the first output's first channel, then min-max normalize; reject an effectively constant or nonfinite result. Upsample the probability mask before binary thresholding if extracting in rectified pixel space. A probability threshold is processing of the neural output, not classical image-threshold segmentation.
6. Trace outer and child-hole boundaries. Do not fill holes or replace the shape with its convex hull. If selecting the largest component, make that policy visible; multiple parts are outside this single-part PoC.

[Normalization source](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/base.py), [prediction source](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/u2netp.py).

### Model integrity and attribution

- Source asset: https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx
- Byte length: `4574861`
- Upstream-pinned MD5: `8e83ca70e441ab06c318d82300c84806`
- Locally verified SHA-256: `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`
- rembg source revision inspected: `cd8f3665dda6c246b5baecb85fda6a2acd644c2a`
- U²-Net source revision inspected: `ac7e1c817ecab7c7dff5ce6b1abba61cd213ff29`
- Original U²-Net repository: Apache-2.0. rembg glue code: MIT. Keep these distinct; rembg's license is not a blanket license for all its supported model weights. The original project's license and rembg's code license are bundled under `public/licenses/`.

The original SAM browser demo loads a **precomputed image embedding** and runs its prompt encoder/decoder. Shipping only the SAM decoder is insufficient for arbitrary uploaded images. A full browser SAM implementation needs a compatible image encoder as well, significantly more download/compute and runtime validation. This is why the compact, fully local U²-NetP route is the lower-risk first PoC. A future click-prompt SAM mode must be explicitly labeled prompt-assisted. [Official SAM browser demo](https://github.com/facebookresearch/segment-anything/blob/main/demo/README.md).

## Marker geometry and verification

The A4 landscape SVG is exactly 297 × 210 mm. Each black marker is 12 × 12 mm, with a one-cell black border and four-by-four internal payload. All marker artwork has its canonical orientation.

| ID | Marker top-left on paper (mm) | Reference corner index | Reference position (mm) |
|---|---|---|---|
| 0, upper left | 11.5, 8 | 2, bottom right | 23.5, 20 |
| 1, upper right | 273.5, 8 | 3, bottom left | 273.5, 20 |
| 2, lower right | 273.5, 190 | 0, top left | 273.5, 190 |
| 3, lower left | 11.5, 190 | 1, top right | 23.5, 190 |

The reference rectangle is therefore exactly 250 × 170 mm. Marker corners are indexed in canonical clockwise order: top-left, top-right, bottom-right, bottom-left. Do not sort image corners by their screen coordinates after detection; that breaks rotated images. Print at actual size, landscape, no fit/shrink, then physically measure both 100 mm rulers. The PNG is 2970 × 2100 with 254 DPI metadata; SVG is preferable for exact physical printing. [OpenCV marker corner convention](https://docs.opencv.org/3.3.0/d5/dae/tutorial_aruco_detection.html).

`js-aruco2` built-ins are not OpenCV `DICT_4X4_50`. Use its documented custom-dictionary mechanism with `nBits:16` and the generated code list. Its matching implementation accepts a Hamming distance **strictly less than** `tau`. Override `maxHammingDistance:2` to accept at most one wrong bit, or `1` for exact-only. Using the dictionary's minimum-distance value of four as a match threshold allows too many bit errors. Version 2.0.0 takes an ImageData-like object in `detect`, even though newer repository documentation also describes a three-argument overload. [js-aruco2 upstream](https://github.com/damianofalcioni/js-aruco2).

Tests found a duplicate, slightly inset ID-2 quadrilateral in the L fixture with js-aruco2. Merge only detections of the same ID whose centers and extents identify the same physical marker; choose the lower-Hamming/larger quadrilateral. Widely separated duplicates are ambiguous and should fail calibration.

### Suggested validity gates

- Require all four distinct expected IDs, a convex non-self-crossing reference quadrilateral, finite coordinates and a numerically nonsingular transform.
- Prefer each marker's minimum side at least 30 source pixels; warn below 40–50 pixels. This is a PoC heuristic to test, not a formal accuracy bound.
- Reject severe foreshortening or a reference quadrilateral below 5% of the image area. Expose a quality warning rather than extrapolating confidently.
- Four points fit a homography exactly, so their zero residual does **not** validate calibration. Use the other twelve known marker corners, independent printed scale/check lengths, or fit all sixteen known corners and report residuals. A suggested initial gate is RMS residual below 2 source pixels and max below 4; tune from held-out real captures.
- In all presets compute physical coordinates with `sx=W_mm/W_px` and `sy=H_mm/H_px` independently if output dimensions were rounded. Avoid accidental anisotropic scale errors. Or transform image coordinates directly to millimetres.
- Reject malformed polygons: fewer than three vertices, nonfinite values, zero area, self-intersections, holes outside the outer ring, intersecting/overlapping holes or a hole covering the full shape. Preserve input geometry if an edit/snap produces an invalid shape.

These are recommended checks; the application must state which are implemented rather than treating this list as a test result.

## Why pixel scale is not measurement accuracy

A planar homography removes perspective for points on the reference plane. It does not remove lens distortion, curling paper, nonplanarity or the height difference between a thick part's top surface and the markers. Use the main camera without wide-angle distortion, keep the board flat, move back and avoid shallow angles, and put the reference markers at the surface height being measured where possible. A frontoparallel pinhole illustration gives a relative size error about `h/(D-h)` for object height `h` above a reference plane at camera distance `D`; 5 mm at 500 mm is about 1%. This is a derived illustration, not a universal correction for an oblique scene. [Planar homography](https://docs.opencv.org/4.x/d9/dab/tutorial_homography.html), [camera distortion and calibration](https://docs.opencv.org/4.x/d4/d94/tutorial_camera_calibration.html).

The simplification parameter epsilon is a permitted deviation from the **extracted contour**, not a guarantee about the real physical object. Apply it after conversion to millimetres, or use `epsilon_px=epsilon_mm/scale` only for isotropic pixel scales. A 10 mm setting intentionally erases features at that scale. Do not force a round hole into four vertices unless the user explicitly chooses coarse simplification. [OpenCV Douglas–Peucker API](https://docs.opencv.org/4.x/d3/dc0/group__imgproc__shape.html).

## Mode A: GPT-6 Luna

Verified current official API identifier: `gpt-6-luna`. The model supports image input and structured outputs; the Responses API is suitable for a gridded image plus a strict JSON schema. Preserve the exact requested model instead of silently substituting another. [Official model page](https://developers.openai.com/api/docs/models/gpt-6-luna), [structured output guide](https://developers.openai.com/api/docs/guides/structured-outputs).

Use the model only to return geometry and a shape label. Recompute edge lengths, angles and area locally. Validate the output topology and board bounds. Schema-valid JSON is not evidence that inferred coordinates are metrically accurate. A no-key sample response must be visibly labeled synthetic/mock and excluded from AI performance metrics.

For a deployed production service, keep OpenAI credentials server-side. The official API docs warn against client-side exposure. A user-entered BYOK field in a controlled PoC still exposes that key to the page and its dependencies. The initial release was memory-only; the 2026-10-16 user-requested revision persists keys locally per provider, with masking, deletion and explicit storage-risk guidance (see [provider security](PROVIDERS.md)). No key logging or embedded developer key is permitted. Running the request uploads the photo to OpenAI and can incur the user's API charges. No paid inference was used in this research. [OpenAI authentication guidance](https://developers.openai.com/api/reference/overview).

OpenRouter separately documents browser-controlled credentials and currently lists `openai/gpt-6-luna` with JSON-schema structured output. Its chat request uses `response_format:{type:'json_schema',json_schema:{name,strict:true,schema}}` and `provider:{require_parameters:true}`. This is a possible explicit alternative, not an automatic fallback. It introduces an additional provider receiving image data. Account access, current credit balance, exact browser-origin behavior and a successful paid request remain untested. [OpenRouter model](https://openrouter.ai/openai/gpt-6-luna), [browser auth flow](https://openrouter.ai/docs/guides/overview/auth/oauth), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).

## Evaluation and exports

Generated fixtures contain real marker pixels and known geometry. All three photographs passed OpenCV marker detection for IDs 0–3, with corner RMS errors below 0.9 source pixels before subpixel refinement. These are tests of synthetic scenes only. The model receives only the photograph/rectified pixels, never the truth JSON.

### Observed U²-NetP limitation

The independent Python ONNX baseline (`public/samples/u2netp-python-baseline.json`) used the exact synthetic rectified images, faithful rembg preprocessing and a 0.5 probability threshold. L-shape mask IoU was 0.9943, notch IoU 0.9915, and trapezoid-with-hole IoU 0.9165. The model predicted **zero holes**, including for the trapezoid's 40 mm diameter hole. Its thresholded area for that case was 16,654.27 mm² versus the 15,243.87 mm² truth polygon. This establishes a real hole-recovery failure in the selected compact model, even on a controlled scene. Mode C needs an explicitly manual way to add/correct an inner ring. Do not describe automatic hole recovery as validated. This baseline is not browser end-to-end evidence; camera calibration and browser resize differences are excluded.

A bounded test of the full U²-Net model did not solve this. The official rembg `u2net.onnx` is 175,997,641 bytes (verified upstream MD5 `60024c5c889badc19c04ad937298a77b`, SHA-256 `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491`). It gave hole-case IoU 0.9169, zero holes and foreground probability approximately 1.0 at the hole center. L-shape and notch IoUs were 0.9917 and 0.9858, respectively. The full model therefore provides no demonstrated benefit for these fixtures and is not bundled in the site. Results are in `public/samples/u2net-full-python-baseline.json`; the larger model was tested outside the public deliverable. [Official full-U²-Net preprocessing and checksum](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/u2net.py).

Report these independently for A, B and edited C:

1. Calibration detection success and independent check-point error in source pixels and millimetres.
2. Foreground-mask IoU, exterior boundary average symmetric distance and 95th-percentile boundary distance in mm.
3. Hole count and per-hole area/diameter error; IoU alone can conceal a lost small hole.
4. Net area error in mm² and percent; outer and inner perimeter errors separately.
5. Per-edge length error only when an explicit vertex/edge correspondence exists. Different polygon vertex counts require boundary metrics, not index-wise comparison.
6. Original versus simplified vertex counts, epsilon, neural threshold, manual-edit count, latency and model/version/provenance.

Use signed-ring-aware shoelace areas, subtract holes, and export every closed ring. In SVG use physical `width`/`height` in mm and a matching mm `viewBox`; use `fill-rule="evenodd"` for holes and put dimension text on a separate layer. In DXF declare millimetres (`$INSUNITS=4`) and closed `LWPOLYLINE` entities; convert image y-down coordinates to the chosen CAD y-up convention consistently. Curves exported as polygons remain polygonal approximations. Keep JSON full precision; round labels for readability only.

Format references: [SVG fill-rule](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/fill-rule), [Autodesk LWPOLYLINE](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-DXF/files/GUID-748FC305-F3F2-4F74-825A-61F04D757A50.htm), [Autodesk units](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-A58A87BB-482B-4042-A00A-EEF55A2B4FD8.htm).

## Hosting

A static site suits this local-inference PoC and avoids a server GPU bill. GitHub Pages has size/bandwidth limits and is not a general commercial SaaS host; an educational/internal demonstrator should be checked against its current terms before publication. No publication was performed here. [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

If a server becomes necessary, a Dockerized FastAPI CPU service can serve OpenCV and rembg with lazy/session-cached model loading, bounded image dimensions, explicit request timeouts and conservative concurrency. Cloud Run has a free allowance, but requires a billing account; image storage/builds/network and overages may cost money. It must not be described as guaranteed free, and deployment requires an explicit account/cost decision. [Cloud Run pricing](https://cloud.google.com/run/pricing), [Google Cloud Free Tier requirements](https://docs.cloud.google.com/free/docs/free-cloud-features).
