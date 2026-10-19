import test from 'node:test';
import assert from 'node:assert/strict';
import { bbox, cloneGeometry, edgeMeasurements, geometryArea, validateGeometry, type Geometry, type Point } from '../src/geometry.ts';
import { calibrationContextMatches, createKnownEdgeCalibration, KNOWN_EDGE_SCALE_LIMITS, measurementGeometrySignature,
 transformMeasurementGeometry, type CalibrationContext } from '../src/measurement-calibration.ts';

const context: CalibrationContext = { sourceEpoch: 2, mode: 'B', geometryRevision: 3 };
const rectangle = (x: number, y: number, width: number, height: number): Point[] =>
 [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const sample = (): Geometry => ({ outer: rectangle(13, 17, 100, 60), holes: [rectangle(33, 32, 10, 20), rectangle(73, 47, 15, 10)] });
const close = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const perimeter = (ring: Point[]): number => edgeMeasurements(ring).reduce((total, edge) => total + edge.length_mm, 0);

test('ideal frontal D=500 mm, h=10 mm enlargement is recovered by a known 100 mm upper edge', () => {
 // Analytic synthetic geometry only. This does not measure a real camera or metal photo.
 const ideal = sample(), D = 500, h = 10, enlargement = D / (D - h), anchor = ideal.outer[0];
 const enlarge = (p: Point): Point => ({ x: anchor.x + (p.x - anchor.x) * enlargement, y: anchor.y + (p.y - anchor.y) * enlargement });
 const observed = { outer: ideal.outer.map(enlarge), holes: ideal.holes.map(ring => ring.map(enlarge)) };
 close(bbox(observed).width, 102.04081632653062);
 close(bbox(observed).height, 61.22448979591837);
 const calibration = createKnownEdgeCalibration(observed, 0, 100, context);
 close(calibration.originalLengthMm, 102.04081632653062);
 close(calibration.scaleFactor, .98);
 const corrected = transformMeasurementGeometry(observed, calibration, context);
 close(bbox(corrected).width, 100); close(bbox(corrected).height, 60);
 [corrected.outer, ...corrected.holes].forEach((ring, r) => ring.forEach((point, i) => {
  const expected = [ideal.outer, ...ideal.holes][r][i]; close(point.x, expected.x); close(point.y, expected.y);
 }));
});

test('all outer and hole lengths/perimeters scale by k and net area by k squared', () => {
 const original = sample(), before = cloneGeometry(original), calibration = createKnownEdgeCalibration(original, 0, 75, context);
 const result = transformMeasurementGeometry(original, calibration), k = .75;
 assert.equal(calibration.scaleFactor, k);
 assert.equal(result.holes.length, original.holes.length);
 [result.outer, ...result.holes].forEach((ring, r) => {
  const originalRing = [original.outer, ...original.holes][r];
  close(perimeter(ring), perimeter(originalRing) * k);
  edgeMeasurements(ring).forEach((edge, i) => {
   close(edge.length_mm, edgeMeasurements(originalRing)[i].length_mm * k);
   close(edge.angle_deg, edgeMeasurements(originalRing)[i].angle_deg);
  });
 });
 close(geometryArea(result), geometryArea(original) * k * k);
 assert.deepEqual(original, before);
 assert.equal(validateGeometry(result).valid, true);
});

test('the selected first vertex anchors every ring, including the implicit closing edge', () => {
 const original = sample(), calibration = createKnownEdgeCalibration(original, 3, 120, context);
 assert.equal(calibration.edgeId, 'E4'); assert.equal(calibration.originalLengthMm, 60);
 assert.deepEqual(calibration.anchor, original.outer[3]);
 const result = transformMeasurementGeometry(original, calibration);
 assert.deepEqual(result.outer[3], original.outer[3]);
 assert.deepEqual(result.outer[0], { x: 13, y: -43 });
 assert.deepEqual(result.holes[0][0], { x: 53, y: -13 });
 close(edgeMeasurements(result.outer)[3].length_mm, 120);
 // Measurement coordinates may extend outside the photograph; no clipping or image warp is performed.
 assert.equal(validateGeometry(result).valid, true);
});

test('apply and replacement always use the original, never compound a previous correction', () => {
 const original = sample(), calibration = createKnownEdgeCalibration(original, 0, 90, context);
 const once = transformMeasurementGeometry(original, calibration);
 assert.deepEqual(transformMeasurementGeometry(original, calibration), once);
 assert.throws(() => transformMeasurementGeometry(once, calibration), /輪郭が変わりました/);
 const replaced = createKnownEdgeCalibration(original, 0, 80, context);
 close(bbox(transformMeasurementGeometry(original, replaced)).width, 80);
 close(bbox(transformMeasurementGeometry(original, replaced)).height, 48);
 assert.deepEqual(original, sample());
});

test('removing the calibration returns a deep original clone without reverse-scaling loss', () => {
 const original = sample();
 for (const correction of [null, undefined]) {
  const restored = transformMeasurementGeometry(original, correction);
  assert.deepEqual(restored, original);
  assert.notEqual(restored, original); assert.notEqual(restored.outer, original.outer);
  assert.notEqual(restored.outer[0], original.outer[0]); assert.notEqual(restored.holes[0][0], original.holes[0][0]);
  restored.holes[0][0].x++;
  assert.deepEqual(original, sample());
 }
});

test('invalid/nonfinite known lengths and extreme scale factors are rejected', () => {
 const original = sample();
 for (const length of [0, -10, NaN, Infinity, -Infinity, 24.999, 400.001, Number.MIN_VALUE, Number.MAX_VALUE]) {
  assert.throws(() => createKnownEdgeCalibration(original, 0, length, context));
 }
 assert.equal(createKnownEdgeCalibration(original, 0, 25, context).scaleFactor, KNOWN_EDGE_SCALE_LIMITS.min);
 assert.equal(createKnownEdgeCalibration(original, 0, 400, context).scaleFactor, KNOWN_EDGE_SCALE_LIMITS.max);
});

test('invalid selected edges, zero edges, and invalid geometry are rejected', () => {
 for (const index of [-1, 4, .5, NaN, Infinity]) assert.throws(() => createKnownEdgeCalibration(sample(), index, 100, context));
 const duplicate = sample(); duplicate.outer[1] = { ...duplicate.outer[0] };
 assert.throws(() => createKnownEdgeCalibration(duplicate, 0, 100, context), /zero-length edge/);
 const invalid = sample(); invalid.outer[0].x = Infinity;
 assert.throws(() => createKnownEdgeCalibration(invalid, 0, 100, context), /non-finite/);
 assert.throws(() => createKnownEdgeCalibration({ outer: [], holes: [] }, 0, 100, context));
});

test('coordinate, hole, ring-order and vertex edits invalidate the exact signature', () => {
 const original = sample(), calibration = createKnownEdgeCalibration(original, 0, 90, context);
 const outerEdit = cloneGeometry(original); outerEdit.outer[1].x += .000001;
 const holeEdit = cloneGeometry(original); holeEdit.holes[0][0].x += .000001;
 const holeRemoved = cloneGeometry(original); holeRemoved.holes.pop();
 const reordered = cloneGeometry(original); reordered.outer.push(reordered.outer.shift()!);
 const inserted = cloneGeometry(original); inserted.outer.splice(1, 0, { x: 63, y: 17 });
 for (const changed of [outerEdit, holeEdit, holeRemoved, reordered, inserted]) {
  assert.equal(validateGeometry(changed).valid, true);
  assert.notEqual(measurementGeometrySignature(changed), calibration.geometrySignature);
  assert.throws(() => transformMeasurementGeometry(changed, calibration), /輪郭が変わりました/);
 }
 assert.equal(measurementGeometrySignature(cloneGeometry(original)), calibration.geometrySignature);
});

test('image epoch, analysis method and editor revision are separate invalidation boundaries', () => {
 const original = sample(), calibration = createKnownEdgeCalibration(original, 0, 90, context);
 assert.equal(calibrationContextMatches(calibration, { ...context }), true);
 for (const changed of [{ ...context, sourceEpoch: 3 }, { ...context, mode: 'A' as const }, { ...context, geometryRevision: 4 }, { sourceEpoch: 2, mode: 'B' as const }]) {
  assert.equal(calibrationContextMatches(calibration, changed), false);
  assert.throws(() => transformMeasurementGeometry(original, calibration, changed), /解析方式または輪郭/);
 }
 const noRevision = createKnownEdgeCalibration(original, 0, 90, { sourceEpoch: 2, mode: 'B' });
 assert.equal(calibrationContextMatches(noRevision, { sourceEpoch: 2, mode: 'B' }), true);
});

test('invalid source context cannot create or validate a calibration', () => {
 for (const invalid of [{ ...context, sourceEpoch: -1 }, { ...context, sourceEpoch: Infinity }, { ...context, sourceEpoch: .5 },
  { ...context, geometryRevision: NaN }, { ...context, geometryRevision: -1 }, { ...context, mode: 'other' }]) {
  assert.throws(() => createKnownEdgeCalibration(sample(), 0, 100, invalid as CalibrationContext));
 }
});

test('metadata records the chosen physical reference and limitations without inferred height or pose', () => {
 const original = sample(), calibration = createKnownEdgeCalibration(original, 1, 57, context);
 assert.equal(calibration.kind, 'known-top-edge');
 assert.equal(calibration.edgeIndex, 1); assert.equal(calibration.edgeId, 'E2');
 assert.equal(calibration.knownLengthMm, 57); assert.equal(calibration.originalLengthMm, 60);
 assert.equal(calibration.scaleFactor, .95); assert.equal(calibration.sourceEpoch, 2); assert.equal(calibration.mode, 'B');
 assert.equal(calibration.geometryRevision, 3);
 assert.equal(calibration.provenance.selected_outer_edge, 'E2');
 assert.equal(calibration.provenance.target_surface, 'top-face');
 assert.equal(calibration.provenance.observed_length_mm, 60);
 assert.equal(calibration.provenance.known_length_mm, 57);
 assert.equal(calibration.provenance.scale_factor, .95);
 assert.deepEqual(calibration.provenance.anchor_mm, original.outer[1]);
 assert.ok(calibration.provenance.limitations.includes('does_not_correct_sidewall_contours'));
 assert.ok(calibration.provenance.limitations.includes('does_not_correct_residual_perspective'));
 assert.ok(calibration.provenance.limitations.includes('does_not_estimate_thickness_or_camera_pose'));
 assert.equal(Object.isFrozen(calibration), true); assert.equal(Object.isFrozen(calibration.anchor), true);
 assert.equal(Object.isFrozen(calibration.provenance), true); assert.equal(Object.isFrozen(calibration.provenance.limitations), true);
});

test('tampered or deserialized calibration cannot silently alter the transform', () => {
 const original = sample(), calibration = createKnownEdgeCalibration(original, 0, 90, context);
 for (const changed of [{ ...calibration, scaleFactor: NaN }, { ...calibration, scaleFactor: 2 },
  { ...calibration, anchor: { x: 0, y: 0 } }, { ...calibration, edgeId: 'E2' }, { ...calibration, originalLengthMm: 80 }]) {
  assert.throws(() => transformMeasurementGeometry(original, changed), /補正データが不正/);
 }
 const deserialized = JSON.parse(JSON.stringify(calibration));
 assert.deepEqual(transformMeasurementGeometry(original, deserialized), transformMeasurementGeometry(original, calibration));
});
