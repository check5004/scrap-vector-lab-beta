> dev.5 beta: 解析時に直線優先の自動曲線候補を生成します。B は DP 前の密な輪郭から誤差・計算予算付きで推定します。A は元画像から直線/ベジェ混合輪郭を推定する新 schema（実 API 未検証、ローカル stub 検証のみ）です。A に B の密輪郭誤差保証はありません。いずれも実物精度を保証せず、加工前に写真・実測・CAD を確認してください。詳細: [A_NATIVE_CURVES.md](docs/A_NATIVE_CURVES.md)。

# 端材ラボ · Scrap Vector Lab Beta

Smartphone-photo scrap-material vectorization and per-edge measurement PoC. A **separate, static project** with real ArUco calibration, real browser-local neural segmentation, optional GPT-6 Luna visual inference, and a touch-friendly polygon editor.

## Beta 0.3.0-dev.5

This beta has one primary flow: choose a photo, choose **クラウドAI（A）** or **この端末のAI（B）**, then press **解析する**. Marker detection, rectification, the selected real AI method, bounded B threshold/epsilon search, and dimensions run continuously in the same scene. B’s optional paid visual-review loop is off by default; enabling it beside the method choice includes its disclosed provider and call cap in that single explicit start. Manual B threshold/epsilon controls, bounded-search candidates and expert visual review are grouped in the closed **解析の詳細設定** within step **02**. The optional upper-edge correction and exports remain in step **03**. Expert per-stage controls and diagnostics are collapsed. **Beta deployment does not modify the production app or its main branch; stable releases use a separately reviewed release workflow.** The separate beta URL is https://check5004.github.io/scrap-vector-lab-beta/ . See [release isolation, source/distribution commit mapping, version contract, usage, and limitations](docs/BETA_RELEASE.md).

Local search uses actual neural masks and does not promise an optimum or improved measurement accuracy. The original result can be compared and restored. The original filled-hole failure remains visible. Beta keys use their own provider-specific namespace and are never imported from production; both URLs still share the same browser origin.

The optional curve editor supports native cubic Bézier handles, local tolerance-bounded fit previews, guarded adjacent-point merging, and SVG/JSON/DXF exports. Drafts survive closing/reopening the same result; they are not saved across reloads. See [curve editing and precision limits](docs/CURVE_EDITING.md).

## What is implemented

- Real OpenCV-compatible `DICT_4X4_50` marker decoding using js-aruco2 2.0.0 (vendored unchanged algorithms with ESM import/export adaptation), IDs 0/1/2/3 at top-left/top-right/bottom-right/bottom-left. The inward-facing canonical corner defines the reference rectangle.
- A4 landscape 297 × 210 mm SVG/PNG print sheet. Reference rectangle 250 × 170 mm; A4 rectification 2500 × 1700 px. Also 500/1000 mm square presets at 2000 × 2000, and custom sizes.
- Six controlled perspective sample images: the original three deterministic fixtures plus three using genuinely AI-generated steel textures, each covering L-shape, concave notch, and trapezoid with a 40 mm round hole. AI textures are composited into exact geometric shapes with code-rendered valid markers. These are labeled synthetic composites, not untouched real photographs. Ground truth lives separately and is used **only for evaluation**. [Generation/provenance](assets/README.md).
- Mode A: actual GPT-6 Luna image input with millimetre grid and strict structured output. Default **OpenRouter** uses `openai/gpt-6-luna`; optional **OpenAI direct** uses `gpt-6-luna`. A visible provider selector fixes the destination; wrong-provider key formats are blocked locally before any network request. User-entered keys are saved in this browser's localStorage separately for each provider and restored after reload; a visible delete button removes the selected provider's key. Authentication/model availability are checked only when Run is pressed. **A without a key leads to nearby key settings while retaining the photo and selected method; it never falls back to B or simulated inference.** Sending the image is explicit and paid API usage is disclosed.
- Mode B: actual U²-NetP ONNX inference in a Web Worker using ONNX Runtime Web WASM. The binary mask comes from neural probabilities. Boundary tracing and Douglas–Peucker are applied to that mask in millimetres. No Canny/photographic threshold segmentation and no fixture-to-prediction shortcuts.
- Continuous measurement view: real marker corners are highlighted on the original photo, then the same marker plane zooms and rectifies into the selected method’s actual output and millimetre dimensions. B shows its real neural mask and contours; A shows its returned polygon directly, without an invented mask stage. Play/pause/replay/skip controls affect presentation only; actual computation has its own status and cancellation. Reduced-motion uses static stages. The optional A/B/C editing canvas remains available below the shared result. [Animation, mapping, and safety contract](docs/CONTINUOUS_JOURNEY.md).
- Visible debug pipeline: input → decoded/rejected marker candidates → homography/rectification → grid → real neural output → binary mask → raw contours → simplified dimensions. Actual timings, per-stage pause/step, cancellation, safe metadata-only diagnostic export. [Debug guide](docs/DEBUG_PIPELINE.md).
- Mode C: clone A or B, drag/add/delete vertices, undo, ±5° horizontal/vertical snapping, manually draw an outer contour or missing hole. Invalid/self-crossing geometry and invalid hole topology are rejected.
- Compare overlays, net area, per-edge lengths/angles, sampled bidirectional boundary error, area error, hole-count mismatch, and topology-gated edge-length errors.
- JSON, physical-mm SVG (separate dimensions layer, evenodd holes), and DXF closed LWPOLYLINE (INSUNITS=4, y-up CAD coordinates).

## Photo library and camera

Use the separate **写真を選ぶ** button for saved images, or **カメラで撮影** for camera capture. The library input has no `capture` attribute. Both routes share validation and local decoding; HEIC failures provide JPEG/PNG recovery guidance. [Import behavior, EXIF tests, and iPhone verification limits](docs/PHOTO_IMPORT.md).

## Important observed limitation

**Automatic hole extraction is not solved by this model.** In real local CPU model tests, U²-NetP completely filled the synthetic 40 mm hole. A bounded test of the much larger full U²-Net model (176 MB) also filled it and did not improve the other fixtures. The app explicitly warns about this failure, benchmarks it as a missed hole, and supports drawing the hole in Mode C. It never substitutes truth geometry or a color-threshold hole for an AI result. See `public/samples/u2netp-python-baseline.json`, `public/samples/u2net-full-python-baseline.json`, and [runtime research](docs/RUNTIME_RESEARCH.md).

The native AI input is 320 × 320. For A4 this corresponds to about 0.781 × 0.531 mm per mask sample. A 0.1 mm rectified pixel is **not** a 0.1 mm accuracy claim. These synthetic results cannot certify real metal measurement. Thickness, lens distortion, camera angle, blur, glare, paper stretch, and print scaling matter. Keep markers and the measured surface coplanar and verify important dimensions with a ruler/caliper.

## Upper-face limits and optional known-edge correction

Rectification maps the **marker/board plane**, not the elevated top surface of thick metal. It cannot remove visible sidewalls, infer thickness, or eliminate height-induced scale error. A is prompted to identify only the upper-face boundary and upper hole rim, exclude sidewalls/bevels/shadows, and report uncertainty/occlusion/sidewall risk. Those flags are shown and exported, but are not verification that the boundary is correct. B’s foreground model cannot distinguish upper face from sidewalls.

In the closed result detail **既知の上面寸法で補正する**, choose an observed upper-face edge and enter its independently measured length. After confirming the planar/parallel/small-distortion assumptions, the app computes `k = known / observed`, scales all outer/hole measurement lengths by `k` and area by `k²`, and exports that derived geometry. The source polygon, photo overlay, marker homography, and board grid do not change. Apply is bounded to 0.25–4×; repeated application uses the original geometry, never compounds. Removing the correction restores exact original values. A changed photo, calibration, or shape invalidates it. A/B corrections are scoped separately; prior analysis restoration retains its own correction. Synthetic benchmark numbers remain explicitly based on the uncorrected contour.

JSON/SVG metadata contain the selected edge, original/known lengths, factor, anchor, source/mode, and original polygon. SVG uses a signed board-plus-geometry extent so corrected shapes are not clipped; its physical width/height equal that extent in millimetres. DXF/JSON keep signed coordinates without hidden translations. This is a uniform manual scale reference, not sidewall removal or perspective repair. Real physical accuracy has not been measured. The ideal pinhole unit test uses camera distance 500 mm and height 10 mm: observed 102.0408×61.2245 mm becomes 100×60 mm after setting the known 100 mm edge.

## Local development

Node 22+ and Python 3.11+:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements-fixtures.txt
python scripts/generate_samples.py
npm ci
npm run assets
npm run dev
```

The fixture generator writes all print/photo/truth assets. `npm run assets` downloads the 4.6 MB upstream model if absent, validates its SHA-256, and copies the exact locked 1.23.2 WASM/MJS runtime after validating hashes. Model and runtime bytes are served from the same origin; no model CDN request is made at runtime. Approximately 17 MB of model/runtime assets are needed for the first Mode B run.

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run preview
```

Browser tests use real marker decoding and real neural inference for all six samples. They do not mock those operations and do not make paid API calls. Explicitly mocked provider failures test 401 display and key routing. Playwright covers desktop/mobile layout, step-by-step artifacts, continuous projective mapping, replay/pause/cancellation, reduced-motion, inference, editing, JSON/diagnostic download, custom calibration, rejected marker-less inputs and provider-isolated local key persistence, reload, deletion and storage-failure handling. The cloud workspace used during development could not launch local Chromium due to sandbox restrictions, so CI and the deployed browser are the authoritative browser checks.

## Docker

```sh
docker build -t scrap-vector-lab .
docker run --rm -p 8080:8080 scrap-vector-lab
```

Open http://localhost:8080. The build regenerates fixtures, verifies/downloads assets, runs geometry tests, and produces a static Nginx image. No credentials are embedded. Port 8080 is also compatible with a future Cloud Run deployment, but this project **does not activate billing, provision Cloud Run, or assume a guaranteed-free cloud runtime**. GitHub Pages is sufficient.

## GitHub Pages

`Verify beta and deploy isolated Pages` verifies the pinned source mapping, then builds from source, regenerates the synthetic fixtures, verifies model/runtime integrity, runs unit and real-browser tests, builds and starts Docker with HTTP/model-hash smoke tests, then publishes `dist` with GitHub Pages. Select GitHub Actions as the Pages source. Relative Vite base `./` works under `/scrap-vector-lab-beta/`. Deployment is gated on tests and the exact beta repository/main reference. Production deployment settings are untouched.

No backend, database, analytics, inventory, OCR or nesting subsystem is included. API keys are stored only in the browser as described below.

## Model A security and cost

OpenAI's general guidance is not to expose secret API keys in browsers. This personal BYOK PoC is for a trusted, reviewed page on a trusted device, with explicit consent. There is no application-owned API key in the source, bundle or CI. At the user's explicit request, a validly formatted key entered in the UI is automatically saved in provider-separated, versioned localStorage records and restored after reload. It is never added to sessionStorage, exports, diagnostic reports, URLs or logs. Display remains masked. The selected provider's delete button clears its saved key and current input; the other provider's key is unaffected. Clearing/changing the key or consent aborts an outstanding request, but cannot undo data already sent or charges already incurred. Switching providers restores only that provider's saved key. The explicit Analyze action authorizes only the currently disclosed provider, method, optional review, and call cap; changes during a run cancel the captured authorization. Reloading never runs inference automatically. Storage failures are visible; if deletion fails, the app clears its input and warns that browser site data must be removed. There is no cross-provider retry or fallback. localStorage is not encrypted or a credential vault: scripts on the same origin (including other GitHub Pages projects under the same hostname), browser extensions, or someone with access to this browser profile may read it. The app-specific storage names prevent accidental collisions, not same-origin access. Use only a trusted personal device, delete keys on shared devices, and use a secure authenticated backend for production. These records are local to this browser profile/origin; the app does not sync them to other devices. Browser cleanup, private browsing, or storage policies can remove/block them. Photo and dimensions are sent only to the selected fixed endpoint when the user explicitly presses Analyze with Mode A or the optional B visual-review setting enabled (expert diagnostic starts have their own consent): `https://openrouter.ai` (and its inference provider) or `https://api.openai.com`. Mode B itself stays on the device; its optional visual review sends only when explicitly enabled and started. Provider retention rules still apply; OpenAI requests use `store:false`. Errors report the provider, stage, endpoint and HTTP status without reflecting raw server messages. HTTP 401 alone does not establish a specific cause. [Provider setup and official references](docs/PROVIDERS.md). No paid call was made to validate this PoC; model documentation was verified, while a particular user's account/model entitlement is checked at runtime.

## Geometry and print contract

On the A4 page, the reference corners are `(23.5,20)`, `(273.5,20)`, `(273.5,190)`, `(23.5,190)` mm. Each marker is 12 mm square and sits outside the working rectangle. Canonical marker corner indices are `[2,3,0,1]`. Use canonical detected corner order, not screen-coordinate sorting. Print SVG at A4 landscape, **actual size / 100%**, with fit-to-page disabled. Keep individually cut-out markers in the same orientation as the sheet; rotating the whole photo is supported. A nearest-reference-corner check rejects individually rotated markers. Independently check both 100 mm rulers. PNG metadata is 254 DPI.

Coordinates are image-style x-right/y-down millimetres; exported directed angles are clockwise from +x in `[0,360)`. DXF uses `y = board.height - imageY`. Ring closure is implicit; each hole is a separate closed ring. The supplied L fixture area is correctly recomputed as **12,800 mm²**.

## License and attribution

Application code: MIT (see LICENSE). U²-Net upstream: Apache-2.0. rembg reference glue: MIT. ONNX Runtime and js-aruco2: MIT. Third-party notices and model provenance are in `public/licenses`, `public/models/u2netp.provenance.json`, and `docs/RUNTIME_RESEARCH.md`. Dependencies are locked in package-lock.json; the weight SHA-256 is pinned in scripts/fetch-assets.mjs. Synthetic assets contain no private user photographs or uploaded specification text.
