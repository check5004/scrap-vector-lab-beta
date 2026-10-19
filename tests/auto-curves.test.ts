import test from 'node:test';
import assert from 'node:assert/strict';
import { autoFitGeometry, AUTO_FIT_LIMITS, type AutoFitOptions } from '../src/auto-curves';
import { type Geometry, type Point, distance, pointToSegmentDistance, geometryArea } from '../src/geometry';
import { flattenCurve, curveMetrics, validateCurve, curveJson, curveSvg, type CurveGeometry } from '../src/curves';
import { traceMask } from '../src/vision';

const ellipse = (rx = 50, ry = rx, n = 360, cx = 100, cy = 100): Point[] => Array.from({ length: n }, (_, i) => ({ x: cx + rx * Math.cos(2 * Math.PI * i / n), y: cy + ry * Math.sin(2 * Math.PI * i / n) }));
const geometry = (outer: Point[], holes: Point[][] = []): Geometry => ({ outer, holes });
function densePolygon(points: Point[], spacing = .5): Point[] {
  return points.flatMap((a, i) => { const b = points[(i + 1) % points.length], count = Math.max(1, Math.ceil(distance(a, b) / spacing)); return Array.from({ length: count }, (_, j) => ({ x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count })); });
}
const rect = (): Point[] => [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
function fit(raw: Geometry, options: Partial<AutoFitOptions> = {}) {
  const before = structuredClone(raw), result = autoFitGeometry(raw, { toleranceMm: .25, pixelSizeMm: .25, ...options });
  assert.deepEqual(raw, before, 'input must be immutable');
  assert.equal(result.diagnostics.status, 'fitted', result.diagnostics.reason);
  assert.ok(result.geometry);
  assert.ok(validateCurve(result.geometry).valid);
  assert.ok(result.diagnostics.maxErrorBoundMm! <= (options.toleranceMm ?? .25));
  assert.equal(result.diagnostics.anchorCount, result.diagnostics.lineCount + result.diagnostics.cubicCount);
  return { ...result, geometry: result.geometry! };
}
/** Independent dense sampled bidirectional check; implementation uses a stronger analytic bound. */
function sampledDistance(a: Point[], b: Point[], subdivisions = 3): number {
  let maximum = 0;
  for (let i = 0; i < a.length; i++) for (let k = 0; k <= subdivisions; k++) {
    const q = a[(i + 1) % a.length], p = { x: a[i].x + (q.x - a[i].x) * k / subdivisions, y: a[i].y + (q.y - a[i].y) * k / subdivisions };
    let closest = Infinity;
    for (let j = 0; j < b.length; j++) closest = Math.min(closest, pointToSegmentDistance(p, b[j], b[(j + 1) % b.length]));
    maximum = Math.max(maximum, closest);
  }
  return maximum;
}
function assertBoundaryBound(raw: Geometry, fitted: CurveGeometry, bound: number) {
  const flat = flattenCurve(fitted, .002), rawRings = [raw.outer, ...raw.holes], outputRings = [flat.outer, ...flat.holes];
  rawRings.forEach((r, i) => {
    assert.ok(sampledDistance(r, outputRings[i]) <= bound + .002 + 1e-8);
    assert.ok(sampledDistance(outputRings[i], r) <= bound + .002 + 1e-8);
  });
}
function roundedRect(): Point[] {
  const points: Point[] = [];
  const append = (p: Point) => { if (!points.length || distance(points.at(-1)!, p) > 1e-9) points.push(p); };
  for (const [cx, cy, start] of [[90, 10, -Math.PI / 2], [90, 50, 0], [10, 50, Math.PI / 2], [10, 10, Math.PI]]) {
    for (let j = 0; j <= 45; j++) { const a = start + Math.PI / 2 * j / 45; append({ x: cx + 10 * Math.cos(a), y: cy + 10 * Math.sin(a) }); }
    const last = points.at(-1)!, next = start === -Math.PI / 2 ? { x: 100, y: 50 } : start === 0 ? { x: 10, y: 60 } : start === Math.PI / 2 ? { x: 0, y: 10 } : { x: 90, y: 0 };
    const count = Math.ceil(distance(last, next));
    for (let j = 1; j < count; j++) append({ x: last.x + (next.x - last.x) * j / count, y: last.y + (next.y - last.y) * j / count });
  }
  return points;
}

test('dense analytic circle becomes four genuine whole-contour cubics with bounded metrics', () => {
  const raw = geometry(ellipse()), result = fit(raw, { toleranceMm: .1 });
  assert.equal(result.diagnostics.cubicCount, 4); assert.equal(result.diagnostics.cornerCount, 0);
  assert.equal(result.geometry.outer.length, 4);
  const metrics = curveMetrics(result.geometry);
  assert.ok(Math.abs(metrics.outer_length_mm - 100 * Math.PI) < .25);
  assert.ok(Math.abs(metrics.area_approx_mm2 - 2500 * Math.PI) < 15);
  assertBoundaryBound(raw, result.geometry, result.diagnostics.maxErrorBoundMm!);
});

test('ellipse uses cubic controls and its continuous error bound covers independent samples', () => {
  const raw = geometry(ellipse(65, 30)), result = fit(raw, { toleranceMm: .2 });
  assert.ok(result.diagnostics.cubicCount >= 4 && result.diagnostics.cubicCount <= 12);
  assert.ok(Math.abs(curveMetrics(result.geometry).area_approx_mm2 - Math.PI * 65 * 30) < 35);
  assertBoundaryBound(raw, result.geometry, result.diagnostics.maxErrorBoundMm!);
});

test('rounded rectangle retains four true lines and four curves at tangent joins', () => {
  const result = fit(geometry(roundedRect()));
  assert.equal(result.diagnostics.lineCount, 4); assert.equal(result.diagnostics.cubicCount, 4);
  assert.equal(result.diagnostics.cornerCount, 0);
});

test('dense L shape retains all six exact convex and concave corners without cubic handles', () => {
  const vertices = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 80 }, { x: 0, y: 80 }];
  const result = fit(geometry(densePolygon(vertices)));
  assert.equal(result.diagnostics.lineCount, 6); assert.equal(result.diagnostics.cubicCount, 0); assert.equal(result.diagnostics.cornerCount, 6);
  for (const p of vertices) assert.ok(result.geometry.outer.some(q => distance(p, q) < 1e-9));
});

test('mixed straight sides and semicircle preserve readable 90/30/30 mm line lengths', () => {
  const raw = [...densePolygon([{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 40 }, { x: 10, y: 40 }]).filter(p => p.y < 40), ...Array.from({ length: 181 }, (_, i) => ({ x: 55 + 45 * Math.cos(i * Math.PI / 180), y: 40 + 45 * Math.sin(i * Math.PI / 180) }))];
  // Construct ordered open straight edges and the closing left edge explicitly.
  const ring = Array.from({ length: 90 }, (_, i) => ({ x: 10 + i, y: 10 })).concat(Array.from({ length: 30 }, (_, i) => ({ x: 100, y: 10 + i })), raw.slice(-181), Array.from({ length: 29 }, (_, i) => ({ x: 10, y: 39 - i })));
  const result = fit(geometry(ring), { toleranceMm: 1 });
  assert.equal(result.diagnostics.lineCount, 3); assert.equal(result.diagnostics.cubicCount, 2);
  const lengths = result.geometry.outer.flatMap((p, i, r) => p.outgoing || r[(i + 1) % r.length].incoming ? [] : [distance(p, r[(i + 1) % r.length])]).sort((a, b) => a - b);
  lengths.forEach((n, i) => assert.ok(Math.abs(n - [30, 30, 90][i]) < 1e-8));
});

test('holes are individually fitted, kept in order, and subtract from area', () => {
  const raw = geometry(ellipse(80), [ellipse(12, 12, 120, 70, 100).reverse(), ellipse(10, 7, 120, 125, 100)]);
  const result = fit(raw); assert.equal(result.geometry.holes.length, 2); assert.equal(result.diagnostics.rings.length, 3);
  assert.ok(result.geometry.holes.every(r => r.some(p => p.outgoing)));
  assert.ok(Math.abs(curveMetrics(result.geometry).area_approx_mm2 - (Math.PI * (80 ** 2 - 12 ** 2 - 70))) < 60);
});

test('actual mask stair steps are not all treated as sharp corners; circular hole survives', () => {
  const width = 160, probabilities = new Float32Array(width * width);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) { const r = Math.hypot(x - 80, y - 80); if (r < 60 && r > 17) probabilities[y * width + x] = 1; }
  const raw = traceMask({ probabilities, width, height: width, elapsedMs: 0 }, { width: 80, height: 80, pixelWidth: 160, pixelHeight: 160, preset: 'test' }).rawGeometry;
  const result = fit(raw, { toleranceMm: 1, pixelSizeMm: .5 });
  assert.equal(result.geometry.holes.length, 1); assert.equal(result.diagnostics.cornerCount, 0);
  assert.ok(result.diagnostics.cubicCount >= 4); assert.ok(result.diagnostics.anchorCount < 32);
});

test('rotated raster rectangle remains four lines despite pixel stair-step noise', () => {
  const width = 160, probabilities = new Float32Array(width * width);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) { const u = (x - 80) * Math.cos(.4) + (y - 80) * Math.sin(.4), v = -(x - 80) * Math.sin(.4) + (y - 80) * Math.cos(.4); if (Math.abs(u) < 55 && Math.abs(v) < 30) probabilities[y * width + x] = 1; }
  const raw = traceMask({ probabilities, width, height: width, elapsedMs: 0 }, { width: 80, height: 80, pixelWidth: 160, pixelHeight: 160, preset: 'test' }).rawGeometry;
  const result = fit(raw, { toleranceMm: .6, pixelSizeMm: .5 });
  assert.equal(result.diagnostics.lineCount, 4); assert.equal(result.diagnostics.cubicCount, 0);
});

function topPerturbed(fn: (x: number) => number): Geometry {
  const ring = densePolygon(rect(), .5);
  return geometry(ring.map(p => p.y === 0 && p.x > 0 && p.x < 100 ? { x: p.x, y: fn(p.x) } : p));
}
test('within-tolerance straight jitter always takes line priority', () => {
  const result = fit(topPerturbed(x => .15 * Math.sin(x * 2.1)));
  assert.equal(result.diagnostics.lineCount, 4); assert.equal(result.diagnostics.cubicCount, 0);
  assert.equal(result.diagnostics.straightPriority, true);
});

test('small within-tolerance spike is absorbed by a true line; stricter tolerance preserves it', () => {
  const raw = topPerturbed(x => x === 50 ? -.8 : 0);
  const loose = fit(raw, { toleranceMm: 1 }), tight = fit(raw, { toleranceMm: .25 });
  assert.equal(loose.diagnostics.lineCount, 4); assert.equal(loose.diagnostics.cubicCount, 0);
  assert.equal(tight.diagnostics.cubicCount, 0); assert.ok(tight.diagnostics.lineCount > 4);
  assertBoundaryBound(raw, tight.geometry, tight.diagnostics.maxErrorBoundMm!);
});

test('localized weld-like bump remains short straight detail rather than bending a long edge', () => {
  const raw = topPerturbed(x => Math.abs(x - 50) <= 3 ? -1.5 * (1 - Math.abs(x - 50) / 3) : 0);
  const result = fit(raw, { toleranceMm: 1 });
  assert.equal(result.diagnostics.cubicCount, 0); assert.ok(result.diagnostics.lineCount >= 6);
  assertBoundaryBound(raw, result.geometry, result.diagnostics.maxErrorBoundMm!);
});

test('broad genuine bow automatically becomes a curve while three straight edges remain', () => {
  const result = fit(topPerturbed(x => -8 * Math.sin(x * Math.PI / 100)), { toleranceMm: 1 });
  assert.equal(result.diagnostics.lineCount, 3); assert.ok(result.diagnostics.cubicCount > 0 && result.diagnostics.cubicCount <= 3);
});

test('small real notch outside tolerance is preserved with line geometry', () => {
  const vertices = [{ x: 0, y: 0 }, { x: 48, y: 0 }, { x: 48, y: 1.5 }, { x: 52, y: 1.5 }, { x: 52, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
  const raw = geometry(densePolygon(vertices)), result = fit(raw, { toleranceMm: .25 });
  assert.equal(result.diagnostics.cubicCount, 0); assert.equal(result.diagnostics.lineCount, 8);
  assert.ok(Math.abs(curveMetrics(result.geometry).area_approx_mm2 - geometryArea(raw)) < .01);
});

test('minimum curve support is explicit and can conservatively retain only lines', () => {
  const result = fit(geometry(ellipse(10)), { toleranceMm: .2, minCurveLengthMm: 200 });
  assert.equal(result.diagnostics.cubicCount, 0); assert.equal(result.diagnostics.minCurveLengthMm, 200);
});

test('self crossing, nonadjacent touches, invalid holes, and nested holes are rejected atomically', () => {
  const invalid = [geometry([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }]), geometry([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]), geometry(rect(), [ellipse(5, 5, 50, 100, 20)]), geometry(rect(), [ellipse(10, 10, 60, 30, 25), ellipse(2, 2, 30, 30, 25)])];
  for (const raw of invalid) { const before = structuredClone(raw), r = autoFitGeometry(raw, { toleranceMm: 1 }); assert.equal(r.geometry, null); assert.equal(r.diagnostics.status, 'invalid'); assert.deepEqual(raw, before); }
});

test('close boundaries are either proven separate or return safe explicit topology fallback', () => {
  const raw = geometry(ellipse(40), [ellipse(39.99).reverse()]), result = autoFitGeometry(raw, { toleranceMm: .1 });
  if (result.geometry) { assert.ok(validateCurve(result.geometry).valid); assert.equal(result.geometry.holes.length, 1); }
  else { assert.equal(result.diagnostics.status, 'fallback'); assert.match(result.diagnostics.reason!, /topology|validation|limit/); }
});

test('normalizes exactly repeated endpoints but never silently welds distinct near-points', () => {
  const a = rect(); a.splice(1, 0, { ...a[0] }); a.push({ ...a[0] });
  assert.equal(fit(geometry(a)).diagnostics.lineCount, 4);
  const b = rect(); b.splice(1, 0, { x: 1e-11, y: 0 });
  const result = autoFitGeometry(geometry(b), { toleranceMm: .1 }); assert.equal(result.geometry, null); assert.equal(result.diagnostics.status, 'invalid');
});

test('invalid options and nonfinite inputs are diagnostic results, not thrown exceptions', () => {
  for (const toleranceMm of [0, -1, NaN, Infinity, 101]) assert.equal(autoFitGeometry(geometry(rect()), { toleranceMm }).diagnostics.status, 'invalid');
  for (const options of [{ toleranceMm: 1, pixelSizeMm: 0 }, { toleranceMm: 1, minCurveLengthMm: -1 }, { toleranceMm: 1, maxOperations: Infinity }]) assert.equal(autoFitGeometry(geometry(rect()), options).diagnostics.status, 'invalid');
  assert.equal(autoFitGeometry(geometry([{ x: NaN, y: 0 }, ...rect()]), { toleranceMm: 1 }).diagnostics.status, 'invalid');
});

test('hard point, operation and segment caps return no partially fitted geometry', () => {
  assert.match(autoFitGeometry(geometry(ellipse(50, 50, AUTO_FIT_LIMITS.maxInputPoints + 1)), { toleranceMm: 1 }).diagnostics.reason!, /input_limit/);
  for (const maxOperations of [1, 100, 1000]) { const r = autoFitGeometry(geometry(ellipse()), { toleranceMm: .1, maxOperations }); assert.equal(r.geometry, null); assert.match(r.diagnostics.reason!, /operation_limit/); assert.ok(r.diagnostics.operations <= maxOperations); }
  const r = autoFitGeometry(geometry(ellipse()), { toleranceMm: .1, maxSegments: 3 }); assert.equal(r.geometry, null); assert.match(r.diagnostics.reason!, /segment_limit/);
});

test('8k-point pathological input is bounded, with explicit fallback rather than long unbounded fitting', () => {
  const ring = ellipse(80, 80, 8000).map((p, i) => { const factor = 1 + .1 * Math.sin(i * 1.7); return { x: 100 + (p.x - 100) * factor, y: 100 + (p.y - 100) * factor }; });
  const r = autoFitGeometry(geometry(ring), { toleranceMm: .1, pixelSizeMm: .1 });
  assert.equal(r.geometry, null); assert.match(r.diagnostics.reason!, /operation_limit|segment_limit/);
  assert.ok(r.diagnostics.operations <= AUTO_FIT_LIMITS.maxOperations);
  assert.ok(r.diagnostics.elapsedMs < 2000, `bounded stress case unexpectedly took ${r.diagnostics.elapsedMs}ms`);
});

test('curve exports retain actual cubic controls losslessly and use cubic SVG paths', () => {
  const result = fit(geometry(ellipse())), board = { width: 200, height: 200 };
  assert.deepEqual(JSON.parse(curveJson(result.geometry, board)).geometry, result.geometry);
  assert.match(curveSvg(result.geometry, board), /C /);
});

test('whole-contour fitting is deterministic and calibrated scaling is applied exactly once', () => {
  const raw = geometry(ellipse(50));
  const original = fit(raw, { toleranceMm: .2, minCurveLengthMm: 5 }), repeated = fit(raw, { toleranceMm: .2, minCurveLengthMm: 5 });
  assert.deepEqual(original.geometry, repeated.geometry);
  const scaled = fit(geometry(raw.outer.map(p => ({ x: p.x * 2, y: p.y * 2 }))), { toleranceMm: .4, pixelSizeMm: .5, minCurveLengthMm: 10 });
  assert.equal(original.diagnostics.anchorCount, scaled.diagnostics.anchorCount);
  assert.ok(Math.abs(curveMetrics(scaled.geometry).outer_length_mm / 2 - curveMetrics(original.geometry).outer_length_mm) < .01);
  assert.ok(Math.abs(scaled.diagnostics.maxErrorBoundMm! / 2 - original.diagnostics.maxErrorBoundMm!) < 1e-8);
});

function rasterEllipse(resolution: number, boardWidth: number, boardHeight: number, rx: number, ry: number, holeRadius = 0): Geometry {
  const probabilities = new Float32Array(resolution * resolution);
  for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const xx = (x + .5) / resolution * boardWidth - boardWidth / 2, yy = (y + .5) / resolution * boardHeight - boardHeight / 2;
    if ((xx / rx) ** 2 + (yy / ry) ** 2 < 1 && Math.hypot(xx, yy) > holeRadius) probabilities[y * resolution + x] = 1;
  }
  return traceMask({ probabilities, width: resolution, height: resolution, elapsedMs: 0 }, { width: boardWidth, height: boardHeight, pixelWidth: resolution, pixelHeight: resolution, preset: 'test' }).rawGeometry;
}
test('anisotropic real mask circle/ellipse/annulus retain whole curved regions without spurious line runs', () => {
  for (const [rx, ry, hole] of [[60, 60, 0], [70, 45, 0], [60, 60, 20]]) {
    const raw = rasterEllipse(320, 250, 170, rx, ry, hole), result = fit(raw, { toleranceMm: 1, pixelSizeMm: 250 / 320, minCurveLengthMm: 5 });
    assert.equal(result.diagnostics.lineCount, 0);
    assert.equal(result.diagnostics.cubicCount, hole ? 8 : 4);
    assert.equal(result.diagnostics.cornerCount, 0);
  }
});
test('large low-curvature circle at 1 mm quantization is not converted to alternating tiny lines and curves', () => {
  const raw = rasterEllipse(1000, 1000, 1000, 400, 400), result = fit(raw, { toleranceMm: 1.5, pixelSizeMm: 1, minCurveLengthMm: 5 });
  assert.equal(result.diagnostics.lineCount, 0); assert.ok(result.diagnostics.cubicCount <= 12);
  assert.equal(result.diagnostics.cornerCount, 0);
});

test('recommended tolerance and fragmentation are advisory and never relax the requested error', () => {
  const raw = geometry(ellipse().map((p, i) => { const r = 1 + .008 * Math.sin(i * 1.7); return { x: 100 + (p.x - 100) * r, y: 100 + (p.y - 100) * r }; }));
  const result = autoFitGeometry(raw, { toleranceMm: .15, pixelSizeMm: .5, minCurveLengthMm: 5 });
  assert.equal(result.diagnostics.toleranceMm, .15);
  assert.equal(result.diagnostics.recommendedToleranceMm, .75);
  if (result.geometry) { assert.ok(result.diagnostics.maxErrorBoundMm! <= .15); assert.ok(result.diagnostics.fragmented); assert.ok(result.diagnostics.warnings.length > 0); }
  else assert.ok(result.diagnostics.reason);
});
