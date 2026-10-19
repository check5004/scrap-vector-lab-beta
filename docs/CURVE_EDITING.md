# Curve beta contract (0.3.0-dev.4)

## Why the previous contour was polygonal

A requests vertices-only JSON. B thresholds a 320×320 probability mask, traces raster contours, converts to millimetres and applies Douglas–Peucker (`CV.approxPolyDP`). Neither pipeline previously had a curve representation. Epsilon is the deviation allowed when replacing a contour with straight segments, not a distance within which vertices are welded. Geometry validation uses 1e-9 mm equality; near vertices are deliberately distinct. The closed ring does not repeat its initial point. Near-axis snap changes alignment, not point count.

The beta does not automatically smooth an extracted contour or certify an image-derived shape as exact. Optional editing is a same-page modal with the rectified photograph and original polygon beneath the new outline. Close returns to the existing result while keeping the curve draft in memory. Reopening the same analysis result resumes that draft. A new source/result identity or changed calibration/geometry invalidates it. Page reload loses the draft; export is required for a durable copy. Explicit reset asks before replacing the draft with the original contour, and can be undone. Closing during a candidate preview retains the last accepted draft, not the unaccepted candidate.

## Editing and compatibility

- Outer and hole rings use the original mm coordinate frame. Each anchor optionally has absolute incoming/outgoing cubic control points.
- Select an anchor, then make its next edge a curve. Initial handles lie at 1/3 and 2/3 of the straight edge: this operation does not change its shape. Independent blue handles can then be dragged by mouse/touch.
- A local candidate can replace the two straight edges around one selected anchor. It interpolates the three anchor positions as a quadratic represented as a cubic. Turns over 45 degrees, existing handles and fewer than four anchors are rejected. Candidate preview requires explicit acceptance or cancellation.
- Candidate tolerance is relative to the prior two straight edges, **not** to the photograph. Adaptive flattening (0.002 mm) plus sample-spacing/2 gives the displayed conservative bidirectional distance bound. A 100,000-operation budget and early excess-error rejection avoid long synchronous fitting; oversized requests retain the original shape and suggest a shorter section or manual controls.
- This iteration does not automatically fit an entire raster contour or sequentially refit existing curves. It is intentionally a small optional editor, not a complete drawing application.
- Adjacent close points can be merged only at turns ≤5 degrees, or exact duplicates, without moving the remaining anchors. Handles prevent merging affected segments. All proposals are validated as a whole; a broken outer/hole topology reverts the whole proposal. Near nonadjacent points and separate rings never snap together. Sharp corners and a densely sampled circle cannot disappear through proximity chaining.
- Known-edge calibration is applied once before opening. The photograph receives the same scale around the same anchor to align with those measurement coordinates. Edits do not change the original calibration; scale provenance describes the imported reference, not a new assertion that a changed edge still has the original known length.
- Undo is bounded to 50 accepted edits. Pointer cancellation/lost capture rolls back. Pointer IDs and drag offsets prevent another finger or a large hit target from moving geometry unexpectedly.

## Measurements and exports

Subdivision uses de Casteljau. The control polygon bounds arc length above and the endpoint chord below; their difference supplies a per-edge length error bound. Flatness bounds use control-point distance to the chord segment. This implementation stops if subdivision becomes too complex or the full geometry exceeds 2,048 flattened segments, keeping topology checks bounded.

- Native SVG cubic `C` commands and even-odd holes preserve controls; physical dimensions/viewBox remain 1:1 mm. Bounds include the entire control hull.
- JSON schema `2.0-beta` retains all anchors and handles losslessly and clearly labels approximate area/measurement provenance. Existing polygon exports remain schema 1.0 outside the modal. This beta has no curve-JSON import UI.
- DXF remains AutoCAD R2000 closed LWPOLYLINE with INSUNITS=4, outer/hole layers and y-up reflection. It is **not** a native spline: a leading comment explicitly states maximum chord deviation 0.01 mm. The same geometry is sampled for area and topology checks.
- Area is approximate shoelace integration after flattening. It has no certified area error bound. Length is a midpoint of the mathematical lower/upper bounds, not a sum of anchor-to-anchor chords.
- Crossing, touching, overlapping rings and holes outside the outer boundary are rejected by flattened geometry validation. Sub-0.01 mm topology can still evade an approximation; this is not certified manufacturing geometry and must be checked in CAD and by measurement before cutting.

## Primary specifications

- W3C SVG 2 Paths: https://www.w3.org/TR/SVG2/paths.html (cubic Bezier, closepath, compound paths).
- Autodesk DXF SPLINE: https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-E1F884F8-AA90-4864-A215-3182D47A9C74.htm (native spline definition inspected; this beta intentionally exports explicit-tolerance LWPOLYLINE instead).

No new dependencies or network services are introduced. Automated browser tests block off-origin traffic; B still uses its real local ONNX pipeline.
- Autodesk LWPOLYLINE group codes: https://help.autodesk.com/cloudhelp/2017/ENU/AutoCAD-DXF/files/GUID-748FC305-F3F2-4F74-825A-61F04D757A50.htm.
- Michigan Technological University Bezier construction notes: https://pages.mtu.edu/~shene/COURSES/cs3621/NOTES/spline/Bezier/bezier-construct.html (affine invariance and control-polygon construction).
