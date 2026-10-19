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

## Coverage

| Flow | Assertions |
| --- | --- |
| AI-textured L-shape, desktop and Pixel 7 | Genuine inference timing and pinned model hash; bounded threshold/epsilon search; real candidate overlays; exact 0.501 mm epsilon survives the HTML range, candidate application, polygon diagnostics, and JSON provenance |
| Before/after | The prior image is decodable; restoring recovers exact vertices, holes, area, calibration, settings, and provenance; candidate list remains usable |
| Build identity | Header, tuning record, diagnostic export, geometry provenance, and DXF comment agree on `0.3.0-dev.1+<short-sha>` or `+local`; full source commit agrees with the displayed short SHA |
| Cancellation and repetition | A deterministic same-turn start/duplicate-start/stop sequence retains prior geometry and provenance; repeated runs do not accumulate old attempts; source changes clear comparison, candidates, review state and exports; a new source receives genuine fresh ONNX inference |
| Invalid manual settings | Deliberately corrupting numeric UI bounds creates collapsed geometry or empty foreground; recovery reuses the original genuine mask and stays within supported settings; ambiguous results retain the previous geometry until manual selection |
| Known hole miss | The legacy hole fixture still reports its real model miss and truth discrepancy; tuning does not hide hole/semantic-accuracy warnings |
| Explicit review consent | A saved key and Mode A consent cannot start review; review consent and a deliberate Start are required; changing provider clears consent |
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
npx playwright test tests/browser/auto-tune.spec.ts --project=chromium
npx playwright test tests/browser/auto-tune.spec.ts --project=mobile
```

The standard `npm run test:browser` includes this file. The existing CI workflow
runs the complete browser suite on the built static app and again against the
actual container on Chromium. Runtime assertions must pass there before the
beta is described as verified. `APP_URL` may target a separately served beta;
never point this safety fixture at a production environment carrying real keys.

For a browser-free syntax/discovery check:

```sh
npx tsc --noEmit
npx playwright test tests/browser/auto-tune.spec.ts --list
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
