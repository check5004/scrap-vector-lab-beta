# Bounded mask-candidate search

`src/auto-tune.ts` operates on one existing `MaskResult` and its calibrated `Board`. It calls the real `traceMask` and `simplifyMaskTrace` pipeline. It does not run another model, inspect photograph edges, replace segmentation, infer scale, modify homography or dimensions, or read ground truth. There are no network calls and no API-key inputs.

## Public API

- `searchMaskCandidates(mask, board, options)` returns ranked valid candidates, every completed attempt (including invalid reasons), the retained best, elapsed time, stopping reason, and always-on review warnings.
- `Candidate` includes threshold, epsilon in millimetres, raw and simplified geometry, a heuristic score, numeric diagnostics, warnings, and a conservative review grade.
- `candidateSearchDiagnostics(result)` makes a separate JSON-safe summary without images, probability arrays, coordinates, geometry, or credentials. It copies metrics and warning arrays, so editing the summary does not edit the result.
- `onProgress` runs after each completed attempt with counters, the latest attempt, candidate if valid, and best-so-far. `AbortSignal` cancellation returns completed results rather than losing the best.

Candidate IDs encode settings, for example `t0.500-e0.500`. Repeated settings produce the same ID. A deterministic tie-break prefers the current threshold, then lower epsilon, then lower threshold. Timing and time-limited truncation are naturally runtime-dependent.

## Search schedule and limits

1. Try the bounded current threshold, then the 0.1–0.9 coarse grid in increments of 0.1.
2. At each threshold, test the current epsilon, half, quarter, and 0.5 mm, deduplicated and restricted to 0.5–10 mm. There is no automatic increase above the current bounded epsilon.
3. Try at most four distinct, in-range supplied threshold suggestions. Suggestions cannot change the model, board, probabilities, search bounds, or resource limits.
4. Refine around the best coarse/guided threshold at ±0.02, ±0.04 and ±0.06. If every coarse threshold failed, try midpoints where neighboring coarse failures differ, allowing recovery of a narrow band between full and empty masks.

There are at most 80 completed attempts. A threshold-level failure is recorded once because changing epsilon cannot repair an empty/full or untraceable mask. Invalid simplified geometry is retained as a failed attempt and lower epsilons remain eligible. Search does not extend outside 0.1–0.9 if no candidate exists; it explicitly reports that limitation.

The default time budget is 30 seconds, caller-bounded up to 120 seconds. Time and cancellation are checked between candidates; JavaScript cannot interrupt a synchronous contour trace already in progress. Each candidate is preceded by an event-loop yield. The selected raw contour is rejected for manual review above 128 holes or 20,000 vertices, rather than deleting holes or features to fit the budget. Error strings are bounded to 800 characters plus an omission suffix.

## Measurements and ranking

- Empty/full rejection uses exactly zero/all foreground pixels. Small or thin shapes are not rejected simply for a low foreground fraction. The existing contour path still has its own minimum-area and polygon-validity constraints.
- Eight-connected components are measured directly in the thresholded neural mask. The first point of the contour selected by `traceMask` identifies which component to measure. The discarded-area ratio counts actual foreground pixels outside that component, not just the number of discarded fragments.
- Threshold stability is binary IoU at threshold ±0.025, clipped to the permitted range. It measures numerical stability, not correct object recognition.
- Region fidelity compares the simplified geometry against the selected binary component at calibrated pixel centers. All pixels are tested for small masks; larger masks use a deterministic grid targeting at most 65,536 samples. Outer-boundary pixels count as material; traced hole-boundary pixels remain material, matching the contour convention.
- Boundary deviation checks sampled vertices and edge midpoints in both directions, against the other contour's segments. This is not a certified Hausdorff bound. At most 512 vertex positions per ring/direction are sampled, and sampling is disclosed.
- Hole count must match the selected raw trace. Per-hole area agreement is symmetric, so neither shrinking nor expanding a hole is rewarded. Raw/simplified total area and vertex counts are diagnostics, not ground-truth comparisons.

The dimensionless score weights region fidelity 48%, nearby-threshold stability 22%, retained foreground component share 15%, boundary agreement 10%, and per-hole shape agreement 5%, with an image-border-contact penalty. No bonus is awarded for small area, many holes, or few vertices. In particular, a simpler polygon is not rewarded merely for erasing a notch or bridge.

Hole/component counts that vary across searched thresholds and selected-area changes above 25% are explicitly flagged across all retained candidates. Trace observations are retained even when every epsilon fails or a complexity limit rejects that threshold: a failed hole-bearing alternative must not make a hole-free alternative look unambiguous. These observations do not establish which candidate is semantically right. They make every candidate ambiguous for automatic application. Large competing components, actual border contact, less than two pixels of frame clearance, near-full coverage, low stability/fidelity, and material hole/boundary changes also prevent the conservative auto-apply flag.

## How to interpret results

`safeToAutoApply` only means the defined numeric guardrails passed. It cannot establish photographic correctness, dimensional accuracy, or that the intended object was selected. `grade: 'usable'` has the same limited meaning. Every user interface must retain the universal semantic warning, including when this flag is true or the score is high.

A neural mask can confidently fill a real hole at every threshold. Search cannot reconstruct that missing evidence. A smaller outer contour may happen to improve total area error while the hole remains absent; ground-truth area must never be used to choose candidates. A stable hotspot can also receive excellent numerical diagnostics, so differences in selected size across the search require review. Tiny features can lie between diagnostic samples. Keep the photograph, binary mask, raw trace, and simplified contour available for review, preserve prior user results on cancellation/failure, and treat search output as candidates rather than certified measurements.

The focused unit suite covers invalid high/low settings, all-zero/all-one/nonfinite input, narrow recovery bands, retained and missing holes, topology changes, equal competing components, legitimate small/thin regions, disappearing bridges, strong hotspots, notch fidelity, anisotropic physical scaling, cancellation/yielding, deterministic ranking, hard caps, complexity limits, and image/key-free summaries.
