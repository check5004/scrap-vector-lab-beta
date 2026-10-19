import { assertValidGeometry, cloneGeometry, distance, type Geometry, type Point } from './geometry';

/** A bounded manual reference, not an estimate of thickness or camera pose. */
export const KNOWN_EDGE_SCALE_LIMITS = Object.freeze({ min: .25, max: 4 });
export type MeasurementMode = 'A' | 'B' | 'C';
export interface CalibrationContext {
 sourceEpoch: number;
 mode: MeasurementMode;
 geometryRevision?: number;
}
export interface KnownEdgeCalibration {
 readonly kind: 'known-top-edge';
 /** Zero-based outer edge, including the implicit closing edge. */
 readonly edgeIndex: number;
 readonly edgeId: string;
 readonly originalLengthMm: number;
 readonly knownLengthMm: number;
 readonly scaleFactor: number;
 /** First vertex of the selected edge, in the original rectified coordinates. */
 readonly anchor: Readonly<Point>;
 readonly sourceEpoch: number;
 readonly mode: MeasurementMode;
 readonly geometryRevision: number | undefined;
 /** Exact coordinate snapshot, not a lossy or collision-prone rounded hash. */
 readonly geometrySignature: string;
 readonly provenance: Readonly<{
  method: 'known_top_edge_uniform_scale';
  target_surface: 'top-face';
  selected_outer_edge: string;
  selected_outer_edge_index: number;
  observed_length_mm: number;
  known_length_mm: number;
  scale_factor: number;
  anchor_mm: Readonly<Point>;
  source_epoch: number;
  mode: MeasurementMode;
  geometry_revision: number | null;
  assumption: 'single_planar_top_face_uniform_scale';
  limitations: readonly string[];
 }>;
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const validContext = (context: CalibrationContext): boolean => !!context &&
 Number.isSafeInteger(context.sourceEpoch) && context.sourceEpoch >= 0 &&
 ['A', 'B', 'C'].includes(context.mode) &&
 (context.geometryRevision === undefined || Number.isSafeInteger(context.geometryRevision) && context.geometryRevision >= 0);

/** Coordinates and ring order are deliberately significant: an edit invalidates the reference. */
export function measurementGeometrySignature(geometry: Geometry): string {
 assertValidGeometry(geometry);
 return JSON.stringify([geometry.outer.map(p => [p.x, p.y]), geometry.holes.map(ring => ring.map(p => [p.x, p.y]))]);
}

/**
 * The input must always be the original, unscaled analysis/editor geometry.
 * L / d is applied to every outer/hole coordinate around the selected edge's
 * first vertex. It corrects a uniform size error only; it cannot repair a
 * sidewall silhouette, an incorrect upper edge, or residual perspective.
 */
export function createKnownEdgeCalibration(
 geometry: Geometry, edgeIndex: number, knownLengthMm: number, context: CalibrationContext,
): KnownEdgeCalibration {
 if (!finitePositive(knownLengthMm)) throw Error('既知の上面辺長は正の有限値（mm）で入力してください。');
 if (!validContext(context)) throw Error('既知辺補正の画像・解析方式・編集履歴を確認できません。');
 const geometrySignature = measurementGeometrySignature(geometry);
 if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= geometry.outer.length) throw Error('補正する上面の外周辺を選んでください。');
 const from = geometry.outer[edgeIndex], to = geometry.outer[(edgeIndex + 1) % geometry.outer.length];
 const originalLengthMm = distance(from, to);
 if (!finitePositive(originalLengthMm)) throw Error('長さが0または有限値でない辺では補正できません。');
 const scaleFactor = knownLengthMm / originalLengthMm;
 if (!Number.isFinite(scaleFactor) || scaleFactor < KNOWN_EDGE_SCALE_LIMITS.min || scaleFactor > KNOWN_EDGE_SCALE_LIMITS.max) {
  throw Error('補正倍率は0.25〜4倍の範囲にしてください。辺・単位・基準寸法を確認してください。');
 }
 const anchor = Object.freeze({ x: from.x, y: from.y }), edgeId = `E${edgeIndex + 1}`;
 const provenance: KnownEdgeCalibration['provenance'] = Object.freeze({
  method: 'known_top_edge_uniform_scale', target_surface: 'top-face',
  selected_outer_edge: edgeId, selected_outer_edge_index: edgeIndex,
  observed_length_mm: originalLengthMm, known_length_mm: knownLengthMm, scale_factor: scaleFactor,
  anchor_mm: anchor, source_epoch: context.sourceEpoch, mode: context.mode,
  geometry_revision: context.geometryRevision ?? null,
  assumption: 'single_planar_top_face_uniform_scale',
  limitations: Object.freeze(['does_not_correct_sidewall_contours', 'does_not_correct_residual_perspective', 'does_not_estimate_thickness_or_camera_pose']),
 });
 return Object.freeze({ kind: 'known-top-edge', edgeIndex, edgeId, originalLengthMm, knownLengthMm,
  scaleFactor, anchor, sourceEpoch: context.sourceEpoch, mode: context.mode,
  geometryRevision: context.geometryRevision, geometrySignature, provenance });
}

/** Use with the current app context as well as the geometry signature. */
export function calibrationContextMatches(calibration: KnownEdgeCalibration, context: CalibrationContext): boolean {
 return validContext(context) && calibration.sourceEpoch === context.sourceEpoch && calibration.mode === context.mode &&
  calibration.geometryRevision === context.geometryRevision;
}

/**
 * Measurement/export geometry only. Keep photo overlays and editable vertices
 * in original rectified coordinates. Reapplying to the same original is safe;
 * passing an already transformed or edited polygon is rejected by signature.
 * Removal means passing null/undefined, which returns a fresh original clone.
 */
export function transformMeasurementGeometry(
 geometry: Geometry, calibration?: KnownEdgeCalibration | null, context?: CalibrationContext,
): Geometry {
 const signature = measurementGeometrySignature(geometry);
 if (!calibration) return cloneGeometry(geometry);
 if (calibration.geometrySignature !== signature || context && !calibrationContextMatches(calibration, context)) {
  throw Error('画像・解析方式または輪郭が変わりました。既知辺補正を解除して設定し直してください。');
 }
 // Fail closed even for an externally deserialized or altered calibration.
 const expected = createKnownEdgeCalibration(geometry, calibration.edgeIndex, calibration.knownLengthMm, calibration);
 if (calibration.kind !== expected.kind || calibration.edgeId !== expected.edgeId ||
  calibration.originalLengthMm !== expected.originalLengthMm || calibration.scaleFactor !== expected.scaleFactor ||
  calibration.anchor?.x !== expected.anchor.x || calibration.anchor?.y !== expected.anchor.y) {
  throw Error('既知辺補正データが不正です。元の輪郭から設定し直してください。');
 }
 const { anchor, scaleFactor } = expected;
 const transform = (point: Point): Point => ({
  x: anchor.x + (point.x - anchor.x) * scaleFactor,
  y: anchor.y + (point.y - anchor.y) * scaleFactor,
 });
 const transformed = { outer: geometry.outer.map(transform), holes: geometry.holes.map(ring => ring.map(transform)) };
 assertValidGeometry(transformed);
 return transformed;
}
