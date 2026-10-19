# Automatic dense-contour fitting (dev.5)

## Scope and source

The input is B's **dense, calibrated mask boundary before Douglas–Peucker**, with one outer ring and all holes. No image-gradient contour, polygon-corner rounding, local three-point editing, or AI-invented coordinate is substituted for that source. Output is editable line/cubic `CurveGeometry` in millimetres. The model and measurements are estimates, not manufacturing certification.

The cubic solver is an independent TypeScript implementation of Philip J. Schneider's **“An Algorithm for Automatically Fitting Digitized Curves,” Graphics Gems (1990), pp. 612–626**: initialize parameters by chord length, solve a two-variable least-squares system for tangent handle lengths, refine parameters by Newton iteration, and recursively split unsuccessful fits. Primary references:

- [Original chapter](https://lhf.impa.br/cursos/tmg/Schneider-1990.pdf)
- [Graphics Gems original C implementation](https://github.com/erich666/GraphicsGems/blob/master/gems/FitCurves.c)
- [Graphics Gems code-use notice](https://github.com/erich666/GraphicsGems/blob/master/LICENSE.md)

The segmentation, straight-priority rules, continuous error check, topology proof and computation budgets below are application-specific additions, not claims made by the original algorithm.

## API and atomic fallback

`autoFitGeometry(raw, options)` returns `{geometry, diagnostics}`. `geometry` is either a complete curve result or `null`. A null result means **keep the existing valid polygon**; never replace it with a partial fit. Invalid input/options return status `invalid`; computation, validation and unresolved topology failures return `fallback` with an explicit reason. The input is never mutated. Hole count/order and orientation are retained.

Options:

| Option | Meaning |
|---|---|
| `toleranceMm` | Required positive tolerance, at most 100 mm, measured against the supplied raw polyline. |
| `pixelSizeMm` | Actual calibrated mask pixel size; use the larger axis for anisotropic pixels. If omitted, median raw-edge spacing, capped by perimeter/200, is only a fallback sampling/noise scale. |
| `minCurveLengthMm` | Optional positive minimum raw arc-length support for fitting a cubic, at most 1000 mm. Default: max(5 mm, 6 × tolerance, 6 × sampling scale). An explicit UI value overrides this automatic support threshold. |
| `maxInputPoints`, `maxSegments`, `maxOperations` | May reduce the hard safety budgets below. They cannot enlarge the caps. |

Diagnostics include algorithm/version, requested tolerance, actual minimum support and sampling scale by ring, raw/anchor/corner/line/cubic counts, maximum verified boundary-error bound, operations, elapsed time and fallback reason. `straightPriority` is true.

`recommendedToleranceMm = max(0.05 mm, 1.5 × sampling scale)` is a **display-only heuristic** for reducing pixel-stair fragmentation. It is not a physical measurement accuracy estimate or a lower bound on permissible tolerance. It never changes a user-supplied tolerance. `fragmented` and `warnings` expose many short retained pieces at tight tolerances, so a valid fit is not mistaken for guaranteed simple geometry. In particular, very coarse masks or a tolerance smaller than raster noise can legitimately retain many lines instead of producing a clean curve.

## Segmentation and straight priority

1. Remove exactly repeated consecutive/closing vertices only. Distinct near-duplicates are not silently welded. Reject invalid dense boundaries first.
2. Compute supports in **millimetres of raw arc length**, not point count. A prospective corner must turn at least 35°, persist at both support radii, have relatively straight arms, and deviate by more than the fitting tolerance within its local support. Nonmaximum suppression keeps one nearby corner. Smooth curvature normally grows with support; isolated pixel stair turns do not qualify as physical corners.
3. Preserve detected corners as exact original anchors. Preserve sufficiently long, genuinely collinear raw plateaus at tangent-continuous line/curve joins. To avoid classifying the cardinal plateau of a digital circle as a straight material edge, these cuts require support of at least max(2 × minimum curve support, 16 × pixel scale, perimeter/16).
4. Uncornered rings get deterministic distributed seeds. Avoid asking one cubic to wrap around most of a closed ring. **Check a full supported line before adding arbitrary safety cuts**, so a seed on a noise peak cannot fragment an otherwise valid straight side.
5. Prefer a genuine line when all original support is within the allowed line error. A straight segment has no cubic handles, so its edge length remains directly readable. Joining adjacent line segments is allowed only when their combined original raw support passes the same bound and the removed anchor is not a locked corner.
6. Cubics require a minimum arc-length support, at least six raw points, and distributed same-direction bending observed over larger neighborhoods. A short localized weld scar cannot make a whole long edge a decorative curve. If such a feature exceeds tolerance, preserve it using additional verified lines or fail safely; do not erase it as noise.
7. For smooth whole-contour seeds, estimate tangent direction by a symmetric least-squares derivative over a neighborhood of at least eight pixel spacings, four tolerances and perimeter/64, capped by the interval span. This suppresses raster-step directions. True supported line/arc joins use the line's exact tangent. This robust initialization is essential: a two-pixel tangent created alternating short lines and curves on otherwise circular masks.

Lines and curved regions are determined from the dense source. These tests do not claim to identify the physical intent of a scratch, weld or small notch. The requested tolerance controls which deviations may be simplified; original comparison must remain available.

## Continuous bidirectional boundary-error bound

The error is **not only a residual at input vertices** and not only a sparse closest-distance sample.

For a cubic `C(t)`, fitted raw vertices receive strictly increasing parameters `u[i]`, with endpoints 0 and 1. On each interval `[u[i], u[i+1]]`, restrict the cubic exactly by de Casteljau subdivision. Represent the corresponding original straight raw edge as a cubic with controls:

`P[i], 2P[i]/3 + P[i+1]/3, P[i]/3 + 2P[i+1]/3, P[i+1]`.

Subtract these four controls from the restricted curve controls. The resulting cubic is the displacement under a continuous monotone correspondence between the entire raw edge and the entire curve interval. Its distance from zero is bounded above by the largest norm of its control vectors, because a Bézier point is a convex combination of its controls. Subdivision tightens an inconclusive bound. Accept only when **every** interval is certified within the requested tolerance after reserving scale-aware floating-point headroom.

This continuous onto correspondence bounds both raw-to-curve and curve-to-raw distances, including all unsampled positions between input vertices. It is an upper bound; it need not equal the exact Hausdorff distance or the maximum sampled residual.

For a line, distance to the closed chord is convex along each raw segment, so endpoint maxima bound the entire raw polyline. Continuity of the raw path's projection, covering both chord endpoints, also bounds the reverse direction. All joining/simplification decisions use the original supporting points.

The implementation uses IEEE-754 arithmetic and a numerical reserve, not interval arithmetic or a proof assistant. Source segmentation, calibration, photography, lens correction and rasterization error are **outside this bound**. Area is measured from the existing 0.01 mm curve flattening; length uses the existing chord/control-polygon bracket. Do not describe area or physical accuracy as certified by the boundary-fit tolerance.

## Topology protection

- Validate raw simple rings, cross-ring separation, strict hole containment and nonnested holes using a bounded AABB tree broad phase. Do not run an unbounded quadratic prerequisite on a dense contour.
- Require each accepted cubic's control projections to be monotone along its endpoint chord, excluding self-loops within that cubic.
- For every pair of fitted edges, recursively prove disjoint control-hull bounding boxes. Adjacent edges may share their exact endpoint only when opposite control-hull half-planes prove separation there. An unresolved near-touch falls back rather than accepting a possibly hidden sub-flattening crossing.
- Flatten through the existing curve export validator budget, check flattened topology and preserve each ring's orientation. Holes are never silently deleted, reordered, filled or joined.

## Bounded work and measured performance

Hard caps in `AUTO_FIT_LIMITS`:

- 8,000 input points across all rings
- 64 holes
- 256 emitted segments across all rings, including intermediate segments before optional line merging
- 1,200,000 counted operations
- 24 fitting recursion levels, 12 error-bound subdivisions and 28 pair-separation recursion levels
- Existing export/validation limit: 2,048 flattened segments at 0.01 mm
- At most four Newton refinements per fitting attempt

No tolerance is relaxed and no hole is discarded when a cap is reached. Reasons include `input_limit`, `operation_limit`, `segment_limit`, `subdivision_limit`, `validation_limit`, `topology_uncertain` and `numerical_precision`.

On the development executor, typical 320 px anisotropic circle/ellipse/annulus mask traces (492–728 raw points) fitted in roughly 15–35 ms after warmup. An 8,000-point highly jagged radial contour returned an explicit budget fallback in roughly 100–160 ms in focused tests. These are local observations, not device-independent latency guarantees. Earlier 24,000-point/4-million-operation caps took over 500 ms in the stress case and were reduced. A worker remains appropriate for slower devices; the algorithm does not perform network requests.

## Retained verification

Run `node --import tsx --test tests/auto-curves.test.ts` and the repository's complete tests/build.

Coverage includes analytic circle and ellipse metrics; rounded rectangle; convex/concave L corners; exact 90/30/30 mm straight edges joined to a semicircle; ordered holes; actual `traceMask` circle, ellipse, annulus and rotated-rectangle raster traces; large-radius low-curvature 1 mm quantization; high-frequency straight jitter; small spike; localized weld-like bump; broad genuine arc; small real notch; minimum-support control; invalid/self-touching/crossing/nested-hole rejection; close boundaries; exact duplicate normalization; finite options; deterministic computation caps; stress timing; scale covariance; lossless controls in JSON and cubic SVG export; and an independent dense sampled bidirectional cross-check of the analytic error bound.

Expected default-quality examples: analytic and 320 px anisotropic mask circles/ellipses use four cubics and zero lines; a rounded rectangle uses four lines and four cubics; the L uses six lines; the mixed straight/semicircle uses three lines and two cubics; within-tolerance jitter uses four lines. These are regression examples, not a promise of a fixed segment count for arbitrary masks or tolerances.
