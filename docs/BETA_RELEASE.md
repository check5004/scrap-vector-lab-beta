# Isolated automatic-adjustment beta

Release line: **0.3.0-dev.5**. This is a beta of the existing measurement app, not a replacement for the production URL.

## Source and delivery

- Production repository: `check5004/scrap-vector-lab`; production `main` and its Pages deployment are managed separately from this beta.
- Development source branch: `beta/auto-curves-20261019` in that repository. No merge or update to production `main` is part of this beta.
- Distribution repository: `check5004/scrap-vector-lab-beta`.
- Beta Pages path: `/scrap-vector-lab-beta/`; production path stays `/scrap-vector-lab/`.
- Each distribution commit contains the exact reviewed source tree plus `release-source.json` with `repository`, `branch`, and the full source `commit`. The distribution commit is the GitHub Actions run's commit; the pinned source commit is the identity displayed by the app.
- Before a distribution build, `scripts/verify-release.mjs` fetches the pinned public source Git tree and compares every tracked path and Git blob hash, excluding only the mapping file. Mismatch or incomplete source metadata fails the build. Assets are generated or fetched from the existing pinned sources after this check.
- Both Pages artifact upload and deployment are gated on repository **and** `main`: only `check5004/scrap-vector-lab-beta` can deploy this workflow. Running the source branch cannot deploy production.
- Future beta updates repeat source review → new source-branch commit → exact distribution copy + updated mapping → tests/container checks → beta Pages. Production promotion requires separate user approval and an explicitly reviewed production deployment change. This beta workflow must not be blindly merged into production.

`SCRAP_SOURCE_COMMIT` is set from the verified mapping and passed into both Vite and Docker. The screen, diagnostic JSON, measurement JSON, SVG metadata, and DXF comment all use `0.3.0-dev.5+<7-character source SHA>` and the same full source SHA. A local, uncommitted build is honestly labeled `+local`. Increment `dev.1`, `dev.2`, etc. for a new reviewed development iteration; distinct CI corrections within an iteration are distinguished by source SHA.

## Single analysis flow (dev.2)

Choose a photo and either **クラウドAI（A）** (external structured polygon inference) or **この端末のAI（B）** (local U²-NetP segmentation), then press **解析する**. The same scene handles actual marker detection, board-plane correction, selected inference, and dimensions. A never visits B’s mask stage. A missing key opens adjacent setup without discarding the photo/method or running B. Initial loading is only “photo ready,” not a completed analysis. Switching A/B displays only that same-input method’s cached result or an explicit unanalysed state.

B automatically runs bounded local adjustment in the normal flow, retaining its pre-adjustment comparison and restore operation in details. Its optional **LLMで画像との一致も確認** setting is off by default. When enabled, provider, image transmission, paid use, and maximum calls are disclosed beside the single Analyze action; the app does not require another per-stage start. The disclosure and maximum calls are captured at that start. Key/provider changes abort the run. Advanced manual controls remain in the collapsed step-02 analysis settings for troubleshooting, not as mandatory workflow steps. Main Analyze overrides hidden expert step mode so it cannot stall waiting for a hidden Next button.

Computation has its own running/complete/error/cancel state and Cancel button. Playback pause/replay/skip affects only presentation. A failed/cancelled rerun retains a clearly labelled prior completed result for the same input; source/calibration changes invalidate cached results. Retry requires a new explicit click and never silently resends. On a first run that stops after a valid B contour has already completed, that same actual partial contour remains visible in the scene, metrics and exports, with an explicit unfinished-stage warning and `pipeline_completion` metadata. Review attempt/charge records remain even when a prior measurement is restored.

Optional known-top-edge correction is inside closed result details. It scales measurement/export geometry uniformly, never the board grid or photo. See [the geometry, export, and physical-limit contract](../README.md#upper-face-limits-and-optional-known-edge-correction).

## Local search

Normal B Analyze performs local search automatically. The expert **閾値・εを自動調整** button can repeat it against the actual local neural output. If no completed mask is cached, the existing real U²-NetP inference runs first. Search never changes the photograph, ArUco calibration, homography, board dimensions, scale, or model. It uses neither ground-truth fixture data nor photographic color/edge segmentation.

Search is bounded to threshold 0.10–0.90 and epsilon 0.5–10 mm, with epsilon candidates no greater than the current value. Coarse settings, requested bounded refinements, and fine neighbors are tested. At most 80 candidate settings per local search and a 30-second default between-candidate time budget apply. A synchronous contour calculation cannot be interrupted halfway through; cancellation is checked between candidates. Empty/full masks, invalid geometry, excessive complexity, poor fidelity, ambiguous component selection, border proximity, and changing topology are handled explicitly. See [the algorithm and exact numerical guards](AUTO_TUNE_ALGORITHM.md).

The score is an internal heuristic for mask stability and preservation. **It is not image correctness, dimensional accuracy, or a guaranteed optimum.** The UI exposes stability, mask fidelity, holes, and discarded area; the numerical score is in the detailed record only. The original result and overlay remain available with **調整前に戻す**. Ambiguous candidates require manual selection instead of automatic adoption. No valid setting within the tested range is reported as such; the search does not invent a result or assume an out-of-range answer.

**設定が無効なとき…復旧候補を探す** defaults on for this beta. An invalid manual threshold/epsilon can trigger the same local search. It never triggers an external API call. Cancellation/failure preserves the prior completed measurement; changed sources invalidate old candidates. A candidate's exact epsilon and threshold are used for measurement and recorded in provenance. Manual parameter changes invalidate prior tuning/LLM provenance.

## Optional visual review

In the normal flow, LLM review starts only when its optional setting is enabled and the user presses **解析する** beside the image/cost disclosure. The separate expert diagnostic action retains its explicit consent and **LLM評価・再調整を開始** button. It uses the selected provider and its beta-specific key: OpenRouter `openai/gpt-6-luna`, or direct OpenAI `gpt-6-luna`. There is no automatic cross-provider fallback. No real credential or paid request was used in development verification; provider behavior is covered by explicit mock-response tests and live account access is checked only on the user's start.

Each request contains a rectified photograph and up to four actual candidate mask/polygon overlays. Images are resized to at most 900 pixels on their long side before transmission. Keys, raw API responses, images, and user filenames are excluded from diagnostic/export records. Printed text in the images is treated as untrusted evidence, not instructions. Responses have a strict schema and runtime validation: candidate IDs must be supplied IDs, scores finite and bounded, and adjustment directions restricted to `lower`, `higher`, or `none`. The model cannot change scale or supply arbitrary executable instructions.

The user selects **1, 2, or 3 maximum calls**, default 2. Each response is capped at 1,200 output tokens; raster bytes and candidate counts also have hard limits. These are not a guaranteed dollar cap. The UI shows actual reported token usage and OpenRouter-reported USD cost where available, plus explicitly unknown usage/cost for failures or providers that omit it. Cancellation cannot reverse charges for an already submitted request.

Geometrically valid but heuristic-ambiguous candidates may also be visually reviewed. Their warnings remain and they require a human to press the adoption button; an LLM verdict cannot override that gate. The loop preserves the best geometrically eligible evaluated candidate, including a comparison anchor on later calls. It stops at a clean acceptable visual evaluation, a plateau, no new candidate, the model's stop suggestion, the call cap, a failure, or cancellation. The visual score cutoff is a heuristic, not a precision claim. Refinements run actual local mask threshold/epsilon calculations before another image is sent. Failure before any valid evaluation leaves the local candidate marked unreviewed. Cancellation does not replace the previous measurement; completed evaluations remain in the bounded record. Even an LLM-accepted result requires human dimensional verification.

## Security and limitations

Beta uses `scrap-vector-lab-beta:provider-key:v1:<provider>`. It does not read, migrate, overwrite, or delete production `scrap-vector-lab:provider-key:v1:<provider>` records. Both Pages paths share the `check5004.github.io` origin: separate namespaces prevent accidental collisions, **not a security-origin boundary**. Keys remain readable to scripts on that origin and browser extensions; they are not encrypted. Use a trusted device, review the source, and remove keys when no longer needed.

The original synthetic 40 mm hole can remain entirely filled at every tested threshold. A high stability score cannot recover information the neural model missed. Independent checks also found examples where a top-ranked candidate's ground-truth area error was worse than the initial setting. Ground truth is used only after selection to evaluate this limitation, never to score or tune candidates. Thin details and small holes remain limited by the model's 320×320 output and polygon approximation. No automatic result is a measurement certificate.

## Validation

Unit tests exercise adversarial real-valued masks, bounded search, invalid/full/empty inputs, topology, thin/small material, deterministic results, cancellation, strict LLM responses, provider routing, no-secret diagnostics, and limited calls. Browser tests use real ArUco and ONNX on delivered sample pixels; provider-only tests explicitly use synthetic credentials and mock responses. CI also runs tests against the actual Docker/nginx container, including runtime MIME and model hashes. See [test coverage and verification limits](AUTO_TUNE_TESTING.md).

## dev.3 placement refinement

Step **02 · 解析方法を選ぶ** contains the default-closed **解析の詳細設定**: B foreground threshold and epsilon, local recovery/search/candidate comparison and restore, expert optional LLM review, and A's grid spacing. The primary optional B review switch and call cap remain visible beside method selection. Opening or closing these controls never starts processing or sends a photo. Normal one-click analysis needs no additional interaction. Result-only known-edge correction, editing, dimensions and exports remain in step **03**. Diagnostic stage buttons and processing logs stay in the separate closed diagnostic section.

## Curve editing (dev.4)

Optional same-page curve editor from the measurement canvas. See [curve contract](CURVE_EDITING.md). Original analysis and production are unchanged.

## Automatic whole-contour curves (dev.5)

Automatic curves are ON by default in the single analysis flow. B fits the dense boundary before DP simplification, chooses a line whenever allowed by tolerance, preserves corners/holes and uses operation/segment limits with explicit polygon fallback. A requests native mixed cubic/line coordinates from the input image; its new schema has stub tests only, not a paid live-model validation. It has no dense-contour error bound. Neither mode guarantees physical dimensions.

The main result overlays the photograph, retains comparison/cancel, separates straight edge lengths from curve arc lengths and uses the selected geometry in all exports. Optional handles adjust the generated result. Original stable version 0.3.0 is unaffected. Full independent review, terminal CI success, exact source mapping and public live QA are required before completion.
