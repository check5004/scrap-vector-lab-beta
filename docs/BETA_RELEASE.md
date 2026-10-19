# Isolated automatic-adjustment beta

Release line: **0.3.0-dev.1**. This is a beta of the existing measurement app, not a replacement for the production URL.

## Source and delivery

- Production repository: `check5004/scrap-vector-lab`; production `main` remains `e28c9c9490b54023528a5410a9943511a847255d` for this release.
- Development source branch: `beta/auto-threshold-20261019` in that repository. No merge or update to production `main` is part of this beta.
- Distribution repository: `check5004/scrap-vector-lab-beta`.
- Beta Pages path: `/scrap-vector-lab-beta/`; production path stays `/scrap-vector-lab/`.
- Each distribution commit contains the exact reviewed source tree plus `release-source.json` with `repository`, `branch`, and the full source `commit`. The distribution commit is the GitHub Actions run's commit; the pinned source commit is the identity displayed by the app.
- Before a distribution build, `scripts/verify-release.mjs` fetches the pinned public source Git tree and compares every tracked path and Git blob hash, excluding only the mapping file. Mismatch or incomplete source metadata fails the build. Assets are generated or fetched from the existing pinned sources after this check.
- Both Pages artifact upload and deployment are gated on repository **and** `main`: only `check5004/scrap-vector-lab-beta` can deploy this workflow. Running the source branch cannot deploy production.
- Future beta updates repeat source review → new source-branch commit → exact distribution copy + updated mapping → tests/container checks → beta Pages. Production promotion requires separate user approval and an explicitly reviewed production deployment change. This beta workflow must not be blindly merged into production.

`SCRAP_SOURCE_COMMIT` is set from the verified mapping and passed into both Vite and Docker. The screen, diagnostic JSON, measurement JSON, SVG metadata, and DXF comment all use `0.3.0-dev.1+<7-character source SHA>` and the same full source SHA. A local, uncommitted build is honestly labeled `+local`. Increment `dev.1`, `dev.2`, etc. for a new reviewed development iteration; distinct CI corrections within an iteration are distinguished by source SHA.

## Local search

Press **閾値・εを自動調整** to search the actual local neural output. If no completed mask is cached, the existing real U²-NetP inference runs first. Search never changes the photograph, ArUco calibration, homography, board dimensions, scale, or model. It uses neither ground-truth fixture data nor photographic color/edge segmentation.

Search is bounded to threshold 0.10–0.90 and epsilon 0.5–10 mm, with epsilon candidates no greater than the current value. Coarse settings, requested bounded refinements, and fine neighbors are tested. At most 80 candidate settings per local search and a 30-second default between-candidate time budget apply. A synchronous contour calculation cannot be interrupted halfway through; cancellation is checked between candidates. Empty/full masks, invalid geometry, excessive complexity, poor fidelity, ambiguous component selection, border proximity, and changing topology are handled explicitly. See [the algorithm and exact numerical guards](AUTO_TUNE_ALGORITHM.md).

The score is an internal heuristic for mask stability and preservation. **It is not image correctness, dimensional accuracy, or a guaranteed optimum.** The UI exposes stability, mask fidelity, holes, and discarded area; the numerical score is in the detailed record only. The original result and overlay remain available with **調整前に戻す**. Ambiguous candidates require manual selection instead of automatic adoption. No valid setting within the tested range is reported as such; the search does not invent a result or assume an out-of-range answer.

**設定が無効なとき…復旧候補を探す** defaults on for this beta. An invalid manual threshold/epsilon can trigger the same local search. It never triggers an external API call. Cancellation/failure preserves the prior completed measurement; changed sources invalidate old candidates. A candidate's exact epsilon and threshold are used for measurement and recorded in provenance. Manual parameter changes invalidate prior tuning/LLM provenance.

## Optional visual review

LLM review starts only after the user separately checks the image/cost consent and presses **LLM評価・再調整を開始**. It uses the selected provider and its beta-specific key: OpenRouter `openai/gpt-6-luna`, or direct OpenAI `gpt-6-luna`. There is no automatic cross-provider fallback. No real credential or paid request was used in development verification; provider behavior is covered by explicit mock-response tests and live account access is checked only on the user's start.

Each request contains a rectified photograph and up to four actual candidate mask/polygon overlays. Images are resized to at most 900 pixels on their long side before transmission. Keys, raw API responses, images, and user filenames are excluded from diagnostic/export records. Printed text in the images is treated as untrusted evidence, not instructions. Responses have a strict schema and runtime validation: candidate IDs must be supplied IDs, scores finite and bounded, and adjustment directions restricted to `lower`, `higher`, or `none`. The model cannot change scale or supply arbitrary executable instructions.

The user selects **1, 2, or 3 maximum calls**, default 2. Each response is capped at 1,200 output tokens; raster bytes and candidate counts also have hard limits. These are not a guaranteed dollar cap. The UI shows actual reported token usage and OpenRouter-reported USD cost where available, plus explicitly unknown usage/cost for failures or providers that omit it. Cancellation cannot reverse charges for an already submitted request.

Geometrically valid but heuristic-ambiguous candidates may also be visually reviewed. Their warnings remain and they require a human to press the adoption button; an LLM verdict cannot override that gate. The loop preserves the best geometrically eligible evaluated candidate, including a comparison anchor on later calls. It stops at a clean acceptable visual evaluation, a plateau, no new candidate, the model's stop suggestion, the call cap, a failure, or cancellation. The visual score cutoff is a heuristic, not a precision claim. Refinements run actual local mask threshold/epsilon calculations before another image is sent. Failure before any valid evaluation leaves the local candidate marked unreviewed. Cancellation does not replace the previous measurement; completed evaluations remain in the bounded record. Even an LLM-accepted result requires human dimensional verification.

## Security and limitations

Beta uses `scrap-vector-lab-beta:provider-key:v1:<provider>`. It does not read, migrate, overwrite, or delete production `scrap-vector-lab:provider-key:v1:<provider>` records. Both Pages paths share the `check5004.github.io` origin: separate namespaces prevent accidental collisions, **not a security-origin boundary**. Keys remain readable to scripts on that origin and browser extensions; they are not encrypted. Use a trusted device, review the source, and remove keys when no longer needed.

The original synthetic 40 mm hole can remain entirely filled at every tested threshold. A high stability score cannot recover information the neural model missed. Independent checks also found examples where a top-ranked candidate's ground-truth area error was worse than the initial setting. Ground truth is used only after selection to evaluate this limitation, never to score or tune candidates. Thin details and small holes remain limited by the model's 320×320 output and polygon approximation. No automatic result is a measurement certificate.

## Validation

Unit tests exercise adversarial real-valued masks, bounded search, invalid/full/empty inputs, topology, thin/small material, deterministic results, cancellation, strict LLM responses, provider routing, no-secret diagnostics, and limited calls. Browser tests use real ArUco and ONNX on delivered sample pixels; provider-only tests explicitly use synthetic credentials and mock responses. CI also runs tests against the actual Docker/nginx container, including runtime MIME and model hashes. See [test coverage and verification limits](AUTO_TUNE_TESTING.md).
