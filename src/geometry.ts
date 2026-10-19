import { APP_BUILD } from "./build-info";
/**
 * Geometry lives in calibrated millimetres, with image/SVG coordinates (y down).
 * Rings are implicitly closed: do not repeat the first point at the end.
 * Measurements retain full floating-point precision; only display labels round.
 */
export interface Point { x: number; y: number }
export interface Geometry { outer: Point[]; holes: Point[][] }
export interface BoardSize { width: number; height: number }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
export interface GeometryValidation { valid: boolean; errors: string[] }
export interface Provenance {
  scale_mm_per_px?: number | null;
  scaleMmPerPx?: number | null;
  [key: string]: unknown;
}
export interface MeasuredVertex extends Point { id: string }
export interface MeasuredEdge {
  id: string;
  from: string;
  to: string;
  length_mm: number;
  /** Directed angle in the image's y-down coordinate system, [0, 360). */
  angle_deg: number;
}
export interface Measurement {
  schema_version: '1.0';
  units: 'mm';
  coordinate_system: 'image_x_right_y_down';
  angle_convention: 'clockwise_from_positive_x_0_to_360_degrees';
  preset_mode: string;
  board_size_mm: { width_mm: number; height_mm: number };
  /** Null means source pixel scale was not provided; never silently assume 1. */
  scale_mm_per_px: number | null;
  outer_vertices_mm: MeasuredVertex[];
  holes_vertices_mm: MeasuredVertex[][];
  edges_mm: MeasuredEdge[];
  hole_edges_mm: MeasuredEdge[][];
  total_area_mm2: number;
  provenance: Provenance;
}

const EPS = 1e-9;
const finitePoint = (p: Point): boolean => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
const samePoint = (a: Point, b: Point): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= EPS;
const cross = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const orientationTolerance = (a: Point, b: Point, c: Point): number => EPS * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y));
const orient = (a: Point, b: Point, c: Point): number => {
  const value = cross(a, b, c), tolerance = orientationTolerance(a, b, c);
  return value > tolerance ? 1 : value < -tolerance ? -1 : 0;
};
export const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
export function edgeAngle(a: Point, b: Point): number {
  const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  return (angle + 360) % 360;
}
export function cloneGeometry(geometry: Geometry): Geometry {
  return { outer: geometry.outer.map(p => ({ ...p })), holes: geometry.holes.map(ring => ring.map(p => ({ ...p }))) };
}
export const clone = cloneGeometry;

/** Signed shoelace area, translated to a local origin for numerical stability. */
export function signedArea(ring: Point[]): number {
  if (ring.length < 3) return 0;
  const origin = ring[0];
  let sum = 0;
  for (let i = 1; i < ring.length - 1; i++) sum += cross(origin, ring[i], ring[i + 1]);
  return sum / 2;
}
export const polygonArea = (ring: Point[]): number => Math.abs(signedArea(ring));
export const geometryArea = (geometry: Geometry): number => polygonArea(geometry.outer) - geometry.holes.reduce((total, hole) => total + polygonArea(hole), 0);
export const totalArea = geometryArea;

export function bbox(input: Geometry | Point[]): Bounds {
  const points = Array.isArray(input) ? input : [input.outer, ...input.holes].flat();
  if (!points.length || points.some(p => !finitePoint(p))) throw new Error('Bounding box requires finite points.');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  return orient(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
}
/** True for crossings, collinear overlaps, and single-point touches. */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (o1 === 0 && pointOnSegment(c, a, b)) || (o2 === 0 && pointOnSegment(d, a, b)) || (o3 === 0 && pointOnSegment(a, c, d)) || (o4 === 0 && pointOnSegment(b, c, d));
}
/** Boundary is deliberately separate, so holes can require strict containment. */
export function pointInRing(point: Point, ring: Point[]): 'inside' | 'outside' | 'boundary' {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (pointOnSegment(point, a, b)) return 'boundary';
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}
function ringsIntersect(a: Point[], b: Point[]): boolean {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  }
  return false;
}
export function validateRing(ring: Point[], label = 'Ring'): GeometryValidation {
  const errors: string[] = [];
  if (!Array.isArray(ring) || ring.length < 3) return { valid: false, errors: [`${label} needs at least three vertices.`] };
  if (ring.some(p => !finitePoint(p))) return { valid: false, errors: [`${label} has a non-finite coordinate.`] };
  let duplicate = false;
  for (let i = 0; i < ring.length && !duplicate; i++) for (let j = i + 1; j < ring.length; j++) if (samePoint(ring[i], ring[j])) { duplicate = true; break; }
  if (duplicate) errors.push(`${label} has duplicate vertices or a zero-length edge. Rings close automatically.`);
  let crossing = false;
  for (let i = 0; i < ring.length && !crossing; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    // Adjacent collinear edges may continue straight, but must not backtrack.
    const previous = ring[(i - 1 + ring.length) % ring.length];
    if (orient(previous, a, b) === 0 && (previous.x - a.x) * (b.x - a.x) + (previous.y - a.y) * (b.y - a.y) > EPS) crossing = true;
    for (let j = i + 1; j < ring.length && !crossing; j++) {
      if (j === (i + 1) % ring.length || (j + 1) % ring.length === i) continue;
      if (segmentsIntersect(a, b, ring[j], ring[(j + 1) % ring.length])) crossing = true;
    }
  }
  if (crossing) errors.push(`${label} self-intersects, touches itself, or contains overlapping edges.`);
  if (polygonArea(ring) <= EPS) errors.push(`${label} has zero area.`);
  return { valid: errors.length === 0, errors };
}
export function validateGeometry(geometry: Geometry): GeometryValidation {
  if (!geometry || !Array.isArray(geometry.outer) || !Array.isArray(geometry.holes)) return { valid: false, errors: ['Geometry requires an outer ring and a holes array.'] };
  const outer = validateRing(geometry.outer, 'Outer boundary');
  const holes = geometry.holes.map((hole, i) => validateRing(hole, `Hole ${i + 1}`));
  const errors = [...outer.errors, ...holes.flatMap(v => v.errors)];
  if (outer.valid) for (let i = 0; i < geometry.holes.length; i++) {
    if (!holes[i].valid) continue;
    const hole = geometry.holes[i];
    if (hole.some(p => pointInRing(p, geometry.outer) !== 'inside') || ringsIntersect(geometry.outer, hole)) errors.push(`Hole ${i + 1} must be strictly inside the outer boundary without touching or crossing it.`);
  }
  for (let i = 0; i < geometry.holes.length; i++) for (let j = i + 1; j < geometry.holes.length; j++) {
    if (!holes[i].valid || !holes[j].valid) continue;
    const a = geometry.holes[i], b = geometry.holes[j];
    if (ringsIntersect(a, b) || pointInRing(a[0], b) !== 'outside' || pointInRing(b[0], a) !== 'outside') errors.push(`Holes ${i + 1} and ${j + 1} overlap, touch, intersect, or contain one another.`);
  }
  return { valid: errors.length === 0, errors };
}
export function assertValidGeometry(geometry: Geometry): void {
  const result = validateGeometry(geometry);
  if (!result.valid) throw new Error(result.errors.join(' '));
}
function assertBoard(board: BoardSize): void {
  if (!board || !Number.isFinite(board.width) || !Number.isFinite(board.height) || board.width <= 0 || board.height <= 0) throw new Error('Board width and height must be finite positive millimetres.');
}
export function edgeMeasurements(ring: Point[], prefix = 'V', edgePrefix = 'E'): MeasuredEdge[] {
  return ring.map((p, i) => ({ id: `${edgePrefix}${i + 1}`, from: `${prefix}${i + 1}`, to: `${prefix}${(i + 1) % ring.length + 1}`, length_mm: distance(p, ring[(i + 1) % ring.length]), angle_deg: edgeAngle(p, ring[(i + 1) % ring.length]) }));
}
export function buildMeasurement(geometry: Geometry, board: BoardSize, preset = 'custom', provenance: Provenance = {}): Measurement {
  assertValidGeometry(geometry); assertBoard(board);
  const scale = provenance.scale_mm_per_px ?? provenance.scaleMmPerPx ?? null;
  if (scale !== null && (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)) throw new Error('Pixel scale must be finite and positive, or null when unknown.');
  return {
    schema_version: '1.0', units: 'mm', coordinate_system: 'image_x_right_y_down',
    angle_convention: 'clockwise_from_positive_x_0_to_360_degrees', preset_mode: preset,
    board_size_mm: { width_mm: board.width, height_mm: board.height }, scale_mm_per_px: scale,
    outer_vertices_mm: geometry.outer.map((p, i) => ({ id: `V${i + 1}`, x: p.x, y: p.y })),
    holes_vertices_mm: geometry.holes.map((hole, h) => hole.map((p, i) => ({ id: `H${h + 1}V${i + 1}`, x: p.x, y: p.y }))),
    edges_mm: edgeMeasurements(geometry.outer),
    hole_edges_mm: geometry.holes.map((hole, h) => edgeMeasurements(hole, `H${h + 1}V`, `H${h + 1}E`)),
    total_area_mm2: geometryArea(geometry), provenance: { ...provenance, app_build: APP_BUILD },
  };
}

class DisjointSet {
  private parent: number[];
  constructor(length: number) { this.parent = Array.from({ length }, (_, i) => i); }
  find(i: number): number { while (this.parent[i] !== i) { this.parent[i] = this.parent[this.parent[i]]; i = this.parent[i]; } return i; }
  join(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}
function snapRing(ring: Point[], thresholdDeg: number): Point[] {
  const xs = new DisjointSet(ring.length), ys = new DisjointSet(ring.length);
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const angle = edgeAngle(ring[i], ring[j]) % 180;
    if (Math.min(angle, 180 - angle) <= thresholdDeg + EPS) ys.join(i, j);
    else if (Math.abs(angle - 90) <= thresholdDeg + EPS) xs.join(i, j);
  }
  const mean = (sets: DisjointSet, axis: 'x' | 'y'): number[] => {
    const groups = new Map<number, { sum: number; count: number }>();
    ring.forEach((point, i) => { const root = sets.find(i), group = groups.get(root) ?? { sum: 0, count: 0 }; group.sum += point[axis]; group.count++; groups.set(root, group); });
    return ring.map((_, i) => { const group = groups.get(sets.find(i))!; return group.sum / group.count; });
  };
  const x = mean(xs, 'x'), y = mean(ys, 'y');
  return ring.map((_, i) => ({ x: x[i], y: y[i] }));
}
/** Snaps near-axis edges together. Rejects the entire proposal if topology breaks. */
export function nearAxisSnap(geometry: Geometry, thresholdDeg = 5): Geometry {
  assertValidGeometry(geometry);
  if (!Number.isFinite(thresholdDeg) || thresholdDeg < 0 || thresholdDeg >= 45) throw new Error('Snap threshold must be between 0 and 45 degrees, exclusive of 45.');
  const result = { outer: snapRing(geometry.outer, thresholdDeg), holes: geometry.holes.map(hole => snapRing(hole, thresholdDeg)) };
  return validateGeometry(result).valid ? result : cloneGeometry(geometry);
}
export function pointToSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, a);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}
function simplifyOpen(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points.map(p => ({ ...p }));
  const keep = new Set<number>([0, points.length - 1]), stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let largest = epsilon, index = -1;
    for (let i = first + 1; i < last; i++) { const error = pointToSegmentDistance(points[i], points[first], points[last]); if (error > largest) { largest = error; index = i; } }
    if (index >= 0) { keep.add(index); stack.push([first, index], [index, last]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => ({ ...points[i] }));
}
/** Closed Douglas–Peucker, with epsilon in mm and two noncoincident anchors. */
export function douglasPeucker(ring: Point[], epsilonMm: number): Point[] {
  const validation = validateRing(ring);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  if (!Number.isFinite(epsilonMm) || epsilonMm < 0) throw new Error('Simplification tolerance must be finite and nonnegative millimetres.');
  if (epsilonMm === 0 || ring.length <= 3) return ring.map(p => ({ ...p }));
  let anchor = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i].x < ring[anchor].x || (ring[i].x === ring[anchor].x && ring[i].y < ring[anchor].y)) anchor = i;
  // Move the canonical seed to a farthest point so a noisy extreme midpoint
  // is not forced to survive merely because it happened to start the ring.
  const seed = anchor;
  for (let i = 0; i < ring.length; i++) if (distance(ring[seed], ring[i]) > distance(ring[seed], ring[anchor])) anchor = i;
  const ordered = [...ring.slice(anchor), ...ring.slice(0, anchor)];
  let split = 1;
  for (let i = 2; i < ordered.length; i++) if (distance(ordered[0], ordered[i]) > distance(ordered[0], ordered[split])) split = i;
  const first = simplifyOpen(ordered.slice(0, split + 1), epsilonMm);
  const second = simplifyOpen([...ordered.slice(split), ordered[0]], epsilonMm);
  const result = [...first.slice(0, -1), ...second.slice(0, -1)];
  return validateRing(result).valid ? result : ring.map(p => ({ ...p }));
}
export const simplifyClosedRing = douglasPeucker;
/** Keep the original geometry if simplification changes valid hole topology. */
export function simplifyGeometry(geometry: Geometry, epsilonMm: number): Geometry {
  assertValidGeometry(geometry);
  const result = { outer: douglasPeucker(geometry.outer, epsilonMm), holes: geometry.holes.map(hole => douglasPeucker(hole, epsilonMm)) };
  return validateGeometry(result).valid ? result : cloneGeometry(geometry);
}

const escapeXml = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const numberText = (n: number): string => Object.is(n, -0) ? '0' : String(n);
function svgRing(ring: Point[]): string { return `M ${ring.map(p => `${numberText(p.x)} ${numberText(p.y)}`).join(' L ')} Z`; }
function svgDimensions(ring: Point[], isHole = false): string {
  const sign = (signedArea(ring) >= 0 ? 1 : -1) * (isHole ? -1 : 1);
  return ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], length = distance(a, b);
    const nx = sign * (b.y - a.y) / length, ny = sign * -(b.x - a.x) / length;
    const x = (a.x + b.x) / 2 + nx * 4, y = (a.y + b.y) / 2 + ny * 4;
    let angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    if (angle > 90) angle -= 180; else if (angle < -90) angle += 180;
    return `<g data-edge="${i + 1}"><line x1="${numberText(a.x + nx * 3)}" y1="${numberText(a.y + ny * 3)}" x2="${numberText(b.x + nx * 3)}" y2="${numberText(b.y + ny * 3)}"/><text x="${numberText(x)}" y="${numberText(y)}" transform="rotate(${numberText(angle)} ${numberText(x)} ${numberText(y)})">${length.toFixed(2)} mm</text></g>`;
  }).join('\n');
}
/**
 * Keep the board coordinate frame and expand its bounds to include all geometry.
 * Known-edge scaling may move vertices below zero or beyond the marker board.
 * Never shift, clip, fit-to-page, or rescale those measurement coordinates.
 */
export function svgExportBounds(geometry: Geometry, board: BoardSize): Bounds {
  assertValidGeometry(geometry); assertBoard(board);
  const bounds = bbox(geometry);
  const minX = Math.min(0, bounds.minX), minY = Math.min(0, bounds.minY);
  const maxX = Math.max(board.width, bounds.maxX), maxY = Math.max(board.height, bounds.maxY);
  const width = maxX - minX, height = maxY - minY;
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('SVG export bounds must be finite millimetres.');
  return { minX, minY, maxX, maxY, width, height };
}
/** Physical SVG dimensions and its full, possibly signed viewBox use 1:1 millimetres. Holes use evenodd. */
export function createSvg(geometry: Geometry, board: BoardSize, preset = 'custom', provenance: Provenance = {}): string {
  const measurement = buildMeasurement(geometry, board, preset, provenance);
  const bounds = svgExportBounds(geometry, board);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${numberText(bounds.width)}mm" height="${numberText(bounds.height)}mm" viewBox="${numberText(bounds.minX)} ${numberText(bounds.minY)} ${numberText(bounds.width)} ${numberText(bounds.height)}">
<title>Scrap vector measurement — ${escapeXml(preset)}</title>
<metadata>${escapeXml(JSON.stringify(measurement))}</metadata>
<g id="geometry" inkscape:groupmode="layer" inkscape:label="Measured geometry"><path d="${[geometry.outer, ...geometry.holes].map(svgRing).join(' ')}" fill="#c2b593" fill-rule="evenodd" stroke="#26382f" stroke-width="0.35"/></g>
<g id="dimensions" inkscape:groupmode="layer" inkscape:label="Dimensions (mm)" fill="#26382f" stroke="#66756b" stroke-width="0.15" font-family="sans-serif" font-size="3" text-anchor="middle"><style>#dimensions text{stroke:none;paint-order:stroke;dominant-baseline:central}</style>
${svgDimensions(geometry.outer)}
${geometry.holes.map(hole => svgDimensions(hole, true)).join('\n')}
</g>
</svg>`;
}
/** AutoCAD R2000 ASCII DXF: closed LWPOLYLINE entities, INSUNITS=4 (mm). */
export function createDxf(geometry: Geometry, board: BoardSize, _preset = 'custom', provenance: Provenance = {}): string {
  const bounds = svgExportBounds(geometry, board);
  const fields: (number | string)[] = [999, `Scrap Vector Lab ${APP_BUILD.version} source ${APP_BUILD.source_commit}`];
  const add = (...values: (number | string)[]): void => { fields.push(...values); };
  // DXF comments allow a bounded numeric calibration summary only. Never copy
  // arbitrary provider text, keys, image data, or an unchecked metadata string.
  const calibration = provenance.measurement_calibration;
  if (calibration && typeof calibration === 'object' && !Array.isArray(calibration)) {
    const c = calibration as Record<string, unknown>, anchor = c.anchor_mm;
    if (c.method === 'known_top_edge_uniform_scale' && anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
      const a = anchor as Record<string, unknown>;
      const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
      if (typeof c.selected_outer_edge_index === 'number' && Number.isSafeInteger(c.selected_outer_edge_index) && c.selected_outer_edge_index >= 0 &&
        positive(c.observed_length_mm) && positive(c.known_length_mm) && positive(c.scale_factor) &&
        typeof a.x === 'number' && Number.isFinite(a.x) && typeof a.y === 'number' && Number.isFinite(a.y) &&
        c.known_length_mm / c.observed_length_mm === c.scale_factor) {
        add(999, `Calibration known_top_edge_uniform_scale edge_index=${c.selected_outer_edge_index} observed_length_mm=${numberText(c.observed_length_mm)} known_length_mm=${numberText(c.known_length_mm)} scale_factor=${numberText(c.scale_factor)} anchor_x_mm=${numberText(a.x)} anchor_y_mm=${numberText(a.y)}`);
      }
    }
  }
  const rings = [geometry.outer, ...geometry.holes];
  // R2000 table heads, records, and entities need unique hexadecimal handles.
  // Reserve 1 for the layer table, 2–3 for layers, and 4 onward for rings.
  const handle = (value: number): string => value.toString(16).toUpperCase();
  // Reflect the same full board-union-geometry bounds into the unchanged y-up frame.
  add(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 9, '$HANDSEED', 5, handle(4 + rings.length), 9, '$INSUNITS', 70, 4, 9, '$MEASUREMENT', 70, 1, 9, '$EXTMIN', 10, bounds.minX, 20, board.height - bounds.maxY, 30, 0, 9, '$EXTMAX', 10, bounds.maxX, 20, board.height - bounds.minY, 30, 0, 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 5, '1', 330, '0', 100, 'AcDbSymbolTable', 70, 2);
  ([['OUTER', 3], ['HOLES', 1]] as const).forEach(([name, color], i) => {
    add(0, 'LAYER', 5, handle(2 + i), 330, '1', 100, 'AcDbSymbolTableRecord', 100, 'AcDbLayerTableRecord', 2, name, 70, 0, 62, color, 6, 'CONTINUOUS');
  });
  add(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  rings.forEach((ring, i) => {
    add(0, 'LWPOLYLINE', 5, handle(4 + i), 100, 'AcDbEntity', 8, i === 0 ? 'OUTER' : 'HOLES', 100, 'AcDbPolyline', 90, ring.length, 70, 1, 38, 0);
    // Reflect y about the board height: maintain board coordinates in a y-up CAD frame.
    ring.forEach(p => add(10, p.x, 20, board.height - p.y));
  });
  add(0, 'ENDSEC', 0, 'EOF');
  return fields.map(value => typeof value === 'number' ? numberText(value) : value).join('\n') + '\n';
}
export function createJson(geometry: Geometry, board: BoardSize, preset = 'custom', provenance: Provenance = {}): string {
  return JSON.stringify(buildMeasurement(geometry, board, preset, provenance), null, 2);
}

interface DirectedDistance { mean_mm: number; max_mm: number; sample_count: number }
export interface GeometryComparison {
  boundary_mean_mm: number;
  boundary_max_mm: number;
  predicted_to_reference: DirectedDistance;
  reference_to_predicted: DirectedDistance;
  area_error_mm2: number;
  area_error_percent: number;
  hole_count_mismatch: number;
  topology_matches: boolean;
  /** Null rather than misleading numbers if vertex/hole topology differs. */
  edge_length_mae_mm: number | null;
  edge_length_max_error_mm: number | null;
  sample_spacing_mm: number;
}
function boundarySegments(geometry: Geometry): [Point, Point][] {
  return [geometry.outer, ...geometry.holes].flatMap(ring => ring.map((point, i): [Point, Point] => [point, ring[(i + 1) % ring.length]]));
}
function directedBoundaryDistance(from: Geometry, to: Geometry, spacing: number): DirectedDistance {
  const targets = boundarySegments(to);
  let sum = 0, max = 0, count = 0;
  for (const [a, b] of boundarySegments(from)) {
    const samples = Math.max(1, Math.ceil(distance(a, b) / spacing));
    // Edge endpoint b is the next edge's a, avoiding duplicate vertex samples.
    for (let i = 0; i < samples; i++) {
      const t = i / samples, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      let best = Infinity;
      for (const [c, d] of targets) best = Math.min(best, pointToSegmentDistance(p, c, d));
      sum += best; max = Math.max(max, best); count++;
    }
  }
  return { mean_mm: sum / count, max_mm: max, sample_count: count };
}
interface RingAlignment { cost: number; errors: number[] }
function alignRings(predicted: Point[], reference: Point[]): RingAlignment {
  const n = reference.length;
  let bestCost = Infinity, best: Point[] = [];
  for (const direction of [1, -1]) for (let shift = 0; shift < n; shift++) {
    const candidate = reference.map((_, i) => predicted[(shift + direction * i + n * 2) % n]);
    const cost = candidate.reduce((sum, p, i) => sum + (p.x - reference[i].x) ** 2 + (p.y - reference[i].y) ** 2, 0);
    if (cost < bestCost) { bestCost = cost; best = candidate; }
  }
  return { cost: bestCost, errors: reference.map((p, i) => Math.abs(distance(p, reference[(i + 1) % n]) - distance(best[i], best[(i + 1) % n]))) };
}
/** Minimum-cost one-to-one assignment (Hungarian), used for reordered holes. */
function assignment(costs: number[][]): number[] {
  const n = costs.length, u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(n + 1).fill(Infinity), used = Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = costs[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const result = Array(n).fill(0);
  for (let j = 1; j <= n; j++) result[p[j] - 1] = j - 1;
  return result;
}
/**
 * Bidirectional sampled boundary distance includes outer and every hole.
 * Distances are sampled against exact target segments, not only target vertices.
 * The reported maximum approximates Hausdorff distance at sample_spacing_mm.
 * Edge comparisons require matching vertex counts for outer and matched holes.
 */
export function compareGeometry(predicted: Geometry, reference: Geometry, sampleSpacingMm = 1): GeometryComparison {
  assertValidGeometry(predicted); assertValidGeometry(reference);
  if (!Number.isFinite(sampleSpacingMm) || sampleSpacingMm <= 0) throw new Error('Boundary sample spacing must be finite and positive millimetres.');
  const forward = directedBoundaryDistance(predicted, reference, sampleSpacingMm);
  const backward = directedBoundaryDistance(reference, predicted, sampleSpacingMm);
  const areaError = Math.abs(geometryArea(predicted) - geometryArea(reference));
  const predictedCounts = predicted.holes.map(h => h.length).sort((a, b) => a - b);
  const referenceCounts = reference.holes.map(h => h.length).sort((a, b) => a - b);
  const topologyMatches = predicted.outer.length === reference.outer.length && predictedCounts.length === referenceCounts.length && predictedCounts.every((count, i) => count === referenceCounts[i]);
  const edgeErrors: number[] = [];
  if (topologyMatches) {
    edgeErrors.push(...alignRings(predicted.outer, reference.outer).errors);
    for (const vertexCount of new Set(predictedCounts)) {
      const a = predicted.holes.filter(h => h.length === vertexCount), b = reference.holes.filter(h => h.length === vertexCount);
      const alignments = a.map(ring => b.map(other => alignRings(ring, other)));
      const matches = assignment(alignments.map(row => row.map(result => result.cost)));
      matches.forEach((matched, i) => edgeErrors.push(...alignments[i][matched].errors));
    }
  }
  return {
    boundary_mean_mm: (forward.mean_mm + backward.mean_mm) / 2,
    boundary_max_mm: Math.max(forward.max_mm, backward.max_mm),
    predicted_to_reference: forward, reference_to_predicted: backward,
    area_error_mm2: areaError, area_error_percent: areaError / geometryArea(reference) * 100,
    hole_count_mismatch: Math.abs(predicted.holes.length - reference.holes.length), topology_matches: topologyMatches,
    edge_length_mae_mm: topologyMatches ? edgeErrors.reduce((sum, error) => sum + error, 0) / edgeErrors.length : null,
    edge_length_max_error_mm: topologyMatches ? Math.max(...edgeErrors) : null,
    sample_spacing_mm: sampleSpacingMm,
  };
}
