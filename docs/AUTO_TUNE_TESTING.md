# Beta automatic-adjustment regression tests

## Scope and evidence

`tests/browser/auto-tune.spec.ts` exercises the shipped UI and downloads against
real same-origin photographs, marker detection, rectification, the pinned
U²-NetP ONNX model, its actual probability mask, contour tracing, and candidate
search. It does not replace model output, worker messages, probabilities,
geometries, photographs, or truth files. Existing synthetic/adversarial mask
cases remain in `tests/auto-tune.test.ts`; those are unit tests, not evidence of
real-image model accuracy.

External-provider responses in this browser suite are explicitly **TEST ONLY**.
They prove request construction, consent/routing, bounded orchestration,
accounting, and UI state handling. They do not demonstrate live GPT-6 Luna
availability, paid API success, model review quality, or physical measurement
accuracy. Both provider keys are unmistakably synthetic constants.

### Network safety

- Before navigation, a browser-context route aborts all off-origin requests.
- Only exact expected provider endpoints are intercepted at page scope and
  fulfilled locally. Those handlers never call `continue`, `fetch`, or a real API.
- An unexpected provider, CDN, alternate model endpoint, or other remote URL is
  both blocked and an assertion failure. WebSockets are closed.
- Same-origin model/WASM/image/dictionary assets are genuine, unmodified bytes.
- No real API key, paid call, or environment credential is needed.

## Unified one-click workflow (dev.2)

`tests/browser/unified-analysis.spec.ts` covers the normal user surface with
advanced settings closed. Selecting a sample or importing a photo decodes it
only. One primary Analyze click performs calibration and the selected method:

- B uses real marker detection, rectification, pinned ONNX inference, bounded
  local candidate search, and matching dimensions/export geometry. A restored
  synthetic provider key cannot opt the user into external review.
- A uses strictly local TEST-ONLY provider responses on the selected provider's
  exact endpoints. It renders the returned top-face polygon and dimensions in
  the shared journey without inventing a segmentation mask. Mock success includes
  the required bounded `surface_assessment` fields. Uncertainty, occluded edges
  and sidewall-risk flags remain visible; an unidentifiable top face fails closed
  without inventing dimensions. This does not validate live
  top-face recognition or measurement accuracy.
- The primary Analyze action consumes the visible disclosure. Legacy A/review
  consent checkboxes remain unchecked in these tests. Inherited diagnostic
  stepping cannot turn the main action into a multi-stage workflow.
- Same-photo A/B switching restores the appropriate cached result, matching
  metrics, overlay and exported provenance, without new requests. Expert B
  threshold/epsilon changes, search and candidate adoption switch the radios,
  metrics and journey back to B consistently. Changing the source invalidates
  both methods.
- Optional B review is explicitly switched on, bounded to two mock evaluations,
  and checked for plateau handling, earlier-best retention and unknown-cost
  accounting. The underlying candidates and refinement use the real ONNX mask.
- Cancellation rejects a late mock response, releases input controls, invalidates
  stale source state, and permits another analysis. A cancelled or failed repeat
  restores the completed polygon in the scene as well as metrics and exports.
  First-run B cancellation during a held review retains its genuine local result
  consistently, labels it `partial_cancelled`, preserves attempted-call/unknown-
  cost accounting, and cannot accept a late reply. A further cancelled B repeat
  restores the prior scene/export while retaining its new single sent/unknown-
  cost attempt as an unapplied diagnostic record, separate from prior provenance. Safe provider failures expose
  the retry action without leaking provider text.
- Known-edge correction checks the explicit assumptions gate, exact length and
  area scaling, original overlay preservation, JSON provenance, full-size SVG
  extents, repeat application without compounding, out-of-range rejection,
  clear, rerun and source-change invalidation using a labeled mock A polygon.
  Visible reference-edge highlighting is checked against original coordinates;
  saved E4 correction survives A → uncomputed B → A without retargeting to E1.
- Both methods retain desktop/mobile screenshots; 320 px and 393 px touch-layout
  checks verify reachable primary controls and no horizontal overflow. Start,
  held-running and result viewport screenshots are retained on desktop and
  393 × 740 mobile. Running assertions require the real live-progress message
  and 44 px primary Cancel simultaneously inside the viewport without scrolling
  either control separately.

`tests/browser/legacy-ui.ts` explicitly opens the diagnostic UI and presses the
calibration action after source selection for the existing stage-level tests.
Those regressions are retained, including inference, manual edits, actual-pixel
journey comparisons, export, key safety, photo decoding, EXIF orientation,
marker rejection, review consent, cancellation and bounded search. Hidden legacy
controls are not used to drive the normal one-click tests. The legacy helper
opens the CSS-hidden key panel through the visible Configure Key action and
restores the selected method; it never force-clicks a hidden summary or mutates
its open state. Journey cancellation and editor access use the visible primary
Cancel and editor-toggle controls, with the same semantic and touch assertions.

## Coverage

### Analysis-settings placement (dev.3)

`tests/browser/analysis-settings.spec.ts` runs on both Chromium and Pixel 7.
It asserts that the one default-collapsed `#analysisSettings` disclosure belongs
to step 02 before Analyze. The threshold/epsilon ranges, A image-grid setting,
and existing local-search/review/candidate/restore controls each retain one ID
there. Optional B review and its 1–3 call limit stay visible beside the method
choice; provider settings remain nearby. Known-edge calibration and exports
remain in step 03.

The suite checks that opening settings, changing provider, switching review
consent, and choosing a call limit do not start analysis or transmit data, even
with restored synthetic keys. A genuine ONNX run then exercises both moved
ranges, exact 0.001-step values, stale candidate/automatic-adjustment provenance
invalidation, fresh local search, candidate adoption, and exact restore. The
probability and rectification diagnostic records remain unchanged throughout
those manual operations. A markerless failure fixture verifies that recovery
opens the step-02 settings, while missing-key recovery still opens API settings.

Collapsed-page and expanded-step-02 screenshots are retained at 1280 px desktop
and 320/393 px mobile widths, including real candidates and nested review/record
details. Horizontal-overflow assertions also check visible control bounds.
These are CI runtime assertions and screenshot outputs, not evidence produced
by test discovery alone. The existing one-click and stage-level tests are kept.

| Flow | Assertions |
| --- | --- |
| AI-textured L-shape, desktop and Pixel 7 | Genuine inference timing and pinned model hash; bounded threshold/epsilon search; real candidate overlays; exact 0.501 mm epsilon survives the HTML range, candidate application, polygon diagnostics, and JSON provenance |
| Before/after | The prior image is decodable; restoring recovers exact vertices, holes, area, calibration, settings, and provenance; candidate list remains usable |
| Build identity | Header, tuning record, diagnostic export, geometry provenance, and DXF comment agree on `0.3.0-dev.4+<short-sha>` or `+local`; full source commit agrees with the displayed short SHA |
| Cancellation and repetition | A deterministic same-turn start/duplicate-start/stop sequence retains prior geometry and provenance; repeated runs do not accumulate old attempts; source changes clear comparison, candidates, review state and exports; a new source receives genuine fresh ONNX inference |
| Invalid manual settings | Deliberately corrupting numeric UI bounds creates collapsed geometry or empty foreground; recovery reuses the original genuine mask and stays within supported settings; ambiguous results retain the previous geometry until manual selection |
| Known hole miss | The legacy hole fixture still reports its real model miss and truth discrepancy; tuning does not hide hole/semantic-accuracy warnings |
| Explicit starts and review scope | The primary Analyze action authorizes the visible selected method and disclosed recipient; B review stays off unless its optional switch is enabled. Advanced diagnostic review still requires its separate consent and Start; changing provider clears that consent |
| Provider selection and bounds | Only the selected provider's exact model/authentication endpoints receive mock requests; image count, actual JPEG inputs, output-token cap, no fallback, and OpenAI `store:false` are checked; the one-call limit is enforced and the UI exposes only 1–3 |
| Two-round review | Refinement searches the real mask; the previous best is carried into the second request; lower second-round scores stop on plateau and retain the earlier evaluated candidate; exact candidate settings remain usable after refinement |
| Ambiguous review | When real candidates are ambiguous, mocked favorable ratings cannot auto-apply them; the original measurement remains, the UI says “not applied,” warnings persist, and explicit candidate selection is required |
| Failure/cancellation accounting | A failed sent request has unknown cost, is not retried, and is not labeled evaluated; cancellation retains geometry and a late locally fulfilled reply cannot repopulate state after a source change |
| Stale provenance | A manual threshold/epsilon change clears the previous LLM evaluation and automatic-adjustment provenance from geometry and diagnostic exports |
| C editing gates | Unfinished hole drawings and pointer-down vertex drags disable search, review, restore, candidate application, and exports; canceling the draft retains prior C geometry |
| Storage separation | Beta never reads/writes/deletes production provider-key slots; saving and clearing affects beta slots only; the UI still warns that same-origin storage names are not a security boundary |
| Mobile layout | Real inference, candidate comparisons, expanded diagnostics/review, and restore remain within the viewport; a screenshot is retained as a test artifact |

The invalid-settings test only changes control bounds/values to reach recovery
paths that native range controls ordinarily prevent. It does not manufacture AI
results. Ambiguous candidates are intentionally not treated as a test failure
or as safe automatic results; the suite asserts the appropriate manual gate.
The two-round case requires a genuinely new candidate overlay and fails if the
real refinement never reaches that second evaluation.

## Running and interpreting results

Prepare assets using the repository's normal setup, then run:

```sh
npm test
npm run build
npx playwright test tests/browser/unified-analysis.spec.ts tests/browser/analysis-settings.spec.ts tests/browser/auto-tune.spec.ts --project=chromium
npx playwright test tests/browser/unified-analysis.spec.ts tests/browser/analysis-settings.spec.ts tests/browser/auto-tune.spec.ts --project=mobile
```

The standard `npm run test:browser` includes this file. The existing CI workflow
runs the complete browser suite on the built static app and again against the
actual container on Chromium. Runtime assertions must pass there before the
beta is described as verified. `APP_URL` may target a separately served beta;
never point this safety fixture at a production environment carrying real keys.

For a browser-free syntax/discovery check:

```sh
npx tsc --noEmit
npx playwright test --list
```

A discovered test, a TypeScript pass, or a unit-test pass is **not** a browser
runtime pass. Chromium launch is blocked in the current authoring sandbox, so
this suite was prepared for execution in the permitted CI browser environment;
no launch bypass or paid-provider check is part of this work. Record the CI run
URL and exact commit when reporting runtime results. Retained Playwright traces,
HTML reports, screenshots, and container reports are the relevant artifacts.

## Deliberate limits

- Heuristic candidate scores are not image-match percentages or accuracy claims.
- A genuine model can consistently fill a real hole or miss detail; stable masks
  and favorable test-only reviews do not repair that semantic blind spot.
- Review call limits bound attempts, not dollars. Authentication/model discovery
  requests are distinct from image-bearing inference; failed/cancelled sent
  inference may be charged and can have unknown tokens/cost.
- Unit tests cover exhaustive 1–3 call limits, malformed provider responses,
  unsafe/duplicate candidates, narrow valid bands, full/empty masks, topology,
  disconnected regions and hard search budgets. Browser tests focus on real
  end-to-end integration rather than replacing that matrix with artificial AI.
- The tests do not claim the tool measures real scrap to a physical tolerance.
