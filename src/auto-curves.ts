/**
 * Whole-contour fitting, based on Schneider, Graphics Gems (1990), pp. 612–626.
 * Independent TypeScript implementation. See docs/AUTO_CURVES_ALGORITHM.md.
 * Input must be the calibrated dense mask contour, BEFORE polygon simplification.
 */
import { type Geometry, type Point, distance, pointToSegmentDistance, segmentsIntersect, pointInRing, signedArea } from './geometry';
import { type CurveGeometry, type CurveVertex, flattenCurve } from './curves';

export interface AutoFitOptions {
  toleranceMm: number;
  /** Actual mask pixel size in mm (use the larger axis for anisotropic pixels). */
  pixelSizeMm?: number;
  /** Minimum raw arc-length support for a cubic. Shorter features stay piecewise linear. */
  minCurveLengthMm?: number;
  maxInputPoints?: number;
  maxSegments?: number;
  maxOperations?: number;
}
export interface AutoFitRingDiagnostics {
  ringIndex: number;
  rawPointCount: number;
  anchorCount: number;
  cornerCount: number;
  lineCount: number;
  cubicCount: number;
  maxErrorBoundMm: number;
  minCurveLengthMm: number;
  pixelSizeMm: number;
}
export interface AutoFitDiagnostics {
  status: 'fitted' | 'fallback' | 'invalid';
  reason?: string;
  algorithm: 'schneider-1990-dense-contour-v1';
  toleranceMm: number;
  minCurveLengthMm: number;
  pixelSizeMm: number | null;
  straightPriority: true;
  /** Display-only sampling heuristic; never changes the requested fitting tolerance. */
  recommendedToleranceMm: number;
  fragmented: boolean;
  warnings: string[];
  maxErrorBoundMm: number | null;
  rawPointCount: number;
  anchorCount: number;
  cornerCount: number;
  lineCount: number;
  cubicCount: number;
  operations: number;
  elapsedMs: number;
  rings: AutoFitRingDiagnostics[];
}
export interface AutoFitResult { geometry: CurveGeometry | null; diagnostics: AutoFitDiagnostics }
export const AUTO_FIT_LIMITS = Object.freeze({ maxInputPoints: 8000, maxSegments: 256, maxOperations: 1200000, maxHoles: 64, maxDepth: 24 });

type Cubic = [Point, Point, Point, Point];
type FitEdge = { curve: Cubic; line: boolean; error: number; source: Point[] };
const EPS = 1e-9;
const copy = (p: Point): Point => ({ x: p.x, y: p.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (p: Point, s: number): Point => ({ x: p.x * s, y: p.y * s });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const norm = (p: Point) => Math.hypot(p.x, p.y);
const unit = (p: Point): Point => { const n = norm(p); return n > EPS ? scale(p, 1 / n) : { x: 0, y: 0 }; };
const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const same = (a: Point, b: Point) => distance(a, b) <= EPS;
const cross2 = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const angle = (a: Point, b: Point) => Math.atan2(Math.abs(cross2(a, b)), dot(a, b));
class FitFailure extends Error {
  constructor(message: string, readonly invalid = false) { super(message); }
}
class Budget {
  operations = 0;
  segments = 0;
  constructor(readonly maxOperations: number, readonly maxSegments: number) {}
  tick(n = 1) {
    if (this.operations + n > this.maxOperations) throw new FitFailure('operation_limit: Automatic fitting exceeded its bounded computation budget. Keep the polygon or use a less detailed contour.');
    this.operations += n;
  }
  edge() {
    if (++this.segments > this.maxSegments) throw new FitFailure('segment_limit: The contour needs too many verified segments at this tolerance. Keep the polygon or increase the fitting tolerance.');
  }
}

interface Box { minX: number; minY: number; maxX: number; maxY: number }
function bounds(points: Point[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}
const overlap = (a: Box, b: Box) => a.minX <= b.maxX + EPS && a.maxX + EPS >= b.minX && a.minY <= b.maxY + EPS && a.maxY + EPS >= b.minY;
interface Segment extends Box { a: Point; b: Point; ring: number; index: number; id: number }
interface Tree extends Box { left?: Tree; right?: Tree; items?: Segment[] }
function makeTree(items: Segment[], budget: Budget): Tree {
  budget.tick(items.length);
  const box = bounds(items.flatMap(e => [e.a, e.b]));
  if (items.length <= 8) return { ...box, items };
  const axis = box.maxX - box.minX >= box.maxY - box.minY ? 'x' : 'y';
  items.sort((a, b) => { budget.tick(); return (a.a[axis] + a.b[axis]) - (b.a[axis] + b.b[axis]); });
  const middle = items.length >> 1;
  return { ...box, left: makeTree(items.slice(0, middle), budget), right: makeTree(items.slice(middle), budget) };
}
/** Bounded broad-phase validation; no O(n²) dense-contour prerequisite. */
function validateDense(rings: Point[][], budget: Budget, source: boolean) {
  const fail = (message: string) => { throw new FitFailure(`${source ? 'invalid_input' : 'topology_rejected'}: ${message}`, source); };
  const all: Segment[] = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (ring.length < 3) fail(`Ring ${r} needs at least three distinct points.`);
    if (Math.abs(signedArea(ring)) <= EPS) fail(`Ring ${r} has zero area.`);
    for (let i = 0; i < ring.length; i++) {
      budget.tick();
      const a = ring[i], b = ring[(i + 1) % ring.length], previous = ring[(i + ring.length - 1) % ring.length];
      if (same(a, b)) fail(`Ring ${r} contains a zero-length edge.`);
      const u = sub(previous, a), v = sub(b, a);
      if (Math.abs(cross2(u, v)) <= EPS * Math.max(1, norm(u), norm(v)) && dot(u, v) > EPS) fail(`Ring ${r} backtracks along an edge.`);
      all.push({ ...bounds([a, b]), a, b, ring: r, index: i, id: all.length });
    }
  }
  const tree = makeTree([...all], budget);
  for (const edge of all) {
    const visit = (node: Tree) => {
      budget.tick(); if (!overlap(edge, node)) return;
      if (!node.items) { visit(node.left!); visit(node.right!); return; }
      for (const other of node.items) {
        budget.tick(); if (other.id <= edge.id || !overlap(edge, other)) continue;
        if (other.ring === edge.ring) {
          const n = rings[edge.ring].length, delta = Math.abs(edge.index - other.index);
          if (delta === 1 || delta === n - 1) continue;
        }
        if (segmentsIntersect(edge.a, edge.b, other.a, other.b)) fail('A boundary crosses, overlaps or touches itself or another ring.');
      }
    };
    visit(tree);
  }
  // With disjoint simple boundaries, a single containment test determines the entire ring.
  for (let h = 1; h < rings.length; h++) {
    budget.tick(rings[0].length);
    if (pointInRing(rings[h][0], rings[0]) !== 'inside') fail(`Hole ${h} is not strictly inside the outer boundary.`);
    for (let k = 1; k < h; k++) {
      budget.tick(rings[h].length + rings[k].length);
      if (pointInRing(rings[h][0], rings[k]) !== 'outside' || pointInRing(rings[k][0], rings[h]) !== 'outside') fail('Holes overlap or contain one another.');
    }
  }
}

class RingSamples {
  readonly cumulative: number[] = [0];
  readonly length: number;
  readonly pixel: number;
  readonly radius: number;
  constructor(readonly points: Point[], readonly tolerance: number, pixel: number | undefined, readonly budget: Budget) {
    const lengths = [];
    for (let i = 0; i < points.length; i++) { budget.tick(); const d = distance(points[i], points[(i + 1) % points.length]); lengths.push(d); this.cumulative.push(this.cumulative[i] + d); }
    this.length = this.cumulative[points.length];
    lengths.sort((a, b) => a - b);
    // The median is only a fallback noise scale; explicit mask calibration is preferred.
    this.pixel = pixel ?? Math.min(lengths[lengths.length >> 1], this.length / 200);
    this.radius = Math.min(this.length / 32, Math.max(this.pixel * 3, tolerance * 2, this.length / 1000));
  }
  at(s: number): Point {
    this.budget.tick();
    s = ((s % this.length) + this.length) % this.length;
    let lo = 0, hi = this.points.length;
    while (lo + 1 < hi) { this.budget.tick(); const mid = (lo + hi) >> 1; if (this.cumulative[mid] <= s) lo = mid; else hi = mid; }
    return mix(this.points[lo], this.points[(lo + 1) % this.points.length], (s - this.cumulative[lo]) / (this.cumulative[lo + 1] - this.cumulative[lo]));
  }
  nearest(s: number): number {
    s = ((s % this.length) + this.length) % this.length;
    let lo = 0, hi = this.points.length;
    while (lo + 1 < hi) { this.budget.tick(); const mid = (lo + hi) >> 1; if (this.cumulative[mid] <= s) lo = mid; else hi = mid; }
    return s - this.cumulative[lo] <= this.cumulative[lo + 1] - s ? lo : (lo + 1) % this.points.length;
  }
  tangent(index: number, side: 'smooth' | 'forward' | 'backward', span = Infinity): Point {
    const s = this.cumulative[index], h = Math.min(Math.max(this.pixel * 8, this.tolerance * 4, this.radius, this.length / 64), span / 4);
    if (side === 'forward') return unit(sub(this.at(s + h), this.points[index]));
    if (side === 'backward') return unit(sub(this.points[index], this.at(s - h)));
    // Symmetric least-squares derivative suppresses quantized stair directions.
    // Its odd part is also the derivative term of a local quadratic fit.
    let derivative: Point = { x: 0, y: 0 };
    for (let k = 1; k <= 8; k++) {
      const offset = h * k / 8;
      derivative = add(derivative, scale(sub(this.at(s + offset), this.at(s - offset)), offset));
    }
    return unit(derivative);
  }
  corners(): number[] {
    const candidates: { index: number; score: number }[] = [];
    for (let i = 0; i < this.points.length; i++) {
      const s = this.cumulative[i], p = this.points[i], h = this.radius;
      const before = this.at(s - h), after = this.at(s + h), farBefore = this.at(s - 2 * h), farAfter = this.at(s + 2 * h);
      const small = angle(sub(p, before), sub(after, p));
      const large = angle(sub(p, farBefore), sub(farAfter, p));
      // A real corner persists across scales. Smooth curvature roughly doubles
      // its turning angle; a one-pixel stair step disappears at these supports.
      const stableArms = angle(sub(p, before), sub(before, farBefore)) < 0.25 && angle(sub(after, p), sub(farAfter, after)) < 0.25;
      if (small >= Math.PI * 35 / 180 && small >= large * 0.72 && stableArms && pointToSegmentDistance(p, before, after) > this.tolerance) candidates.push({ index: i, score: small });
    }
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    const selected: number[] = [];
    for (const c of candidates) {
      if (selected.every(i => { this.budget.tick(); const d = Math.abs(this.cumulative[i] - this.cumulative[c.index]); return Math.min(d, this.length - d) >= this.radius; })) selected.push(c.index);
    }
    return selected.sort((a, b) => a - b);
  }
}

function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const a = mix(c[0], c[1], t), b = mix(c[1], c[2], t), d = mix(c[2], c[3], t), e = mix(a, b, t), f = mix(b, d, t), p = mix(e, f, t);
  return [[c[0], a, e, p], [p, f, d, c[3]]];
}
function cubicAt(c: Cubic, t: number): Point { return splitCubic(c, t)[0][3]; }
function subCubic(c: Cubic, a: number, b: number): Cubic {
  if (a === 0) return b === 1 ? c : splitCubic(c, b)[0];
  const tail = splitCubic(c, a)[1]; return b === 1 ? tail : splitCubic(tail, (b - a) / (1 - a))[0];
}
function chordParameters(points: Point[], budget: Budget): number[] {
  const u = [0];
  for (let i = 1; i < points.length; i++) { budget.tick(); u.push(u[i - 1] + distance(points[i - 1], points[i])); }
  const last = u[u.length - 1]; return u.map(v => v / last);
}
/** Schneider's two-unknown least-squares solve for handle lengths. */
function generateBezier(points: Point[], u: number[], left: Point, right: Point, budget: Budget): Cubic {
  const p = points[0], q = points[points.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < points.length; i++) {
    budget.tick();
    const t = u[i], s = 1 - t, b0 = s * s * s, b1 = 3 * t * s * s, b2 = 3 * t * t * s, b3 = t * t * t;
    const a = scale(left, b1), b = scale(right, b2), residual = sub(points[i], add(scale(p, b0 + b1), scale(q, b2 + b3)));
    c00 += dot(a, a); c01 += dot(a, b); c11 += dot(b, b); x0 += dot(a, residual); x1 += dot(b, residual);
  }
  const det = c00 * c11 - c01 * c01, length = distance(p, q);
  let alpha = det > 1e-14 ? (x0 * c11 - x1 * c01) / det : 0;
  let beta = det > 1e-14 ? (c00 * x1 - c01 * x0) / det : 0;
  if (alpha < length * 1e-6 || beta < length * 1e-6 || alpha > length * 3 || beta > length * 3) alpha = beta = length / 3;
  return [copy(p), add(p, scale(left, alpha)), add(q, scale(right, beta)), copy(q)];
}
function reparameterize(c: Cubic, points: Point[], parameters: number[], budget: Budget): number[] | null {
  const u = [0];
  for (let i = 1; i < points.length - 1; i++) {
    budget.tick();
    const t = parameters[i], s = 1 - t, value = cubicAt(c, t), difference = sub(value, points[i]);
    const derivative = add(add(scale(sub(c[1], c[0]), 3 * s * s), scale(sub(c[2], c[1]), 6 * s * t)), scale(sub(c[3], c[2]), 3 * t * t));
    const second = add(scale(add(sub(c[2], scale(c[1], 2)), c[0]), 6 * s), scale(add(sub(c[3], scale(c[2], 2)), c[1]), 6 * t));
    const denominator = dot(derivative, derivative) + dot(difference, second);
    const next = Math.abs(denominator) > 1e-14 ? t - dot(difference, derivative) / denominator : t;
    if (!Number.isFinite(next) || next <= u[i - 1] || next >= 1) return null;
    u.push(next);
  }
  u.push(1); return u;
}
function vertexError(c: Cubic, points: Point[], u: number[], budget: Budget): { error: number; split: number } {
  let error = 0, split = points.length >> 1;
  for (let i = 1; i < points.length - 1; i++) { budget.tick(); const d = distance(cubicAt(c, u[i]), points[i]); if (d > error) { error = d; split = i; } }
  return { error, split };
}
/**
 * Exact polynomial difference on every raw edge, bounded by the convex hull.
 * Subdivision tightens this bound. The continuous monotone correspondence
 * certifies BOTH directed distances, including between the input vertices.
 */
function certify(c: Cubic, points: Point[], u: number[], tolerance: number, budget: Budget): number | null {
  let bound = 0;
  const boundDifference = (d: Cubic, depth: number): number | null => {
    budget.tick();
    const upper = Math.max(...d.map(norm));
    if (upper <= tolerance) return upper;
    if (norm(d[0]) > tolerance || norm(d[3]) > tolerance || depth >= 12) return null;
    const [a, b] = splitCubic(d, 0.5), first = boundDifference(a, depth + 1);
    if (first === null) return null;
    const second = boundDifference(b, depth + 1); return second === null ? null : Math.max(first, second);
  };
  for (let i = 0; i < points.length - 1; i++) {
    budget.tick();
    const part = subCubic(c, u[i], u[i + 1]), a = points[i], b = points[i + 1];
    const difference: Cubic = [sub(part[0], a), sub(part[1], mix(a, b, 1 / 3)), sub(part[2], mix(a, b, 2 / 3)), sub(part[3], b)];
    const error = boundDifference(difference, 0); if (error === null) return null;
    bound = Math.max(bound, error);
  }
  // A scale-aware roundoff reserve is kept below the user's actual tolerance.
  return bound;
}
function lineBound(points: Point[], budget: Budget) {
  let error = 0;
  for (const p of points) { budget.tick(); error = Math.max(error, pointToSegmentDistance(p, points[0], points[points.length - 1])); }
  return error;
}
/** Curvature must occupy real raw arc-length support, not just one weld scar. */
function sustainedBend(points: Point[], support: number, minimum: number, pixel: number, tolerance: number, budget: Budget): boolean {
  if (support < minimum || points.length < 6) return false;
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
  const at = (s: number) => {
    let lo = 0, hi = points.length - 1;
    while (lo + 1 < hi) { budget.tick(); const mid = (lo + hi) >> 1; if (cumulative[mid] <= s) lo = mid; else hi = mid; }
    return mix(points[lo], points[lo + 1], (s - cumulative[lo]) / (cumulative[lo + 1] - cumulative[lo]));
  };
  const h = Math.min(support / 8, Math.max(pixel * 6, tolerance * 4, minimum / 2, support / 20));
  const count = Math.min(64, Math.max(8, Math.ceil(support / h))), step = (support - 4 * h) / count;
  let bending = 0;
  for (let i = 0; i < count; i++) {
    budget.tick();
    const s = 2 * h + (i + 0.5) * step, p = at(s), before = at(s - h), after = at(s + h);
    const smallU = sub(p, before), smallV = sub(after, p), largeU = sub(p, at(s - 2 * h)), largeV = sub(at(s + 2 * h), p);
    const small = angle(smallU, smallV), large = angle(largeU, largeV);
    if (small > 0.003 && small <= large * 1.2 && cross2(smallU, smallV) * cross2(largeU, largeV) > 0) bending += step;
  }
  // The observed interior excludes two support windows at each endpoint.
  return bending >= Math.max(minimum * 0.45, support * 0.15);
}
function monotone(c: Cubic): boolean {
  const d = sub(c[3], c[0]), length2 = dot(d, d);
  const a = dot(sub(c[1], c[0]), d), b = dot(sub(c[2], c[0]), d);
  return length2 > EPS * EPS && a >= -EPS && b >= a - EPS && b <= length2 + EPS;
}

function fitRing(ring: Point[], ringIndex: number, tolerance: number, pixel: number | undefined, minimumCurveLength: number | undefined, budget: Budget): { ring: CurveVertex[]; edges: FitEdge[]; diagnostics: AutoFitRingDiagnostics } {
  const samples = new RingSamples(ring, tolerance, pixel, budget), corners = samples.corners(), locked = new Set(corners);
  const minCurveLengthMm = minimumCurveLength ?? Math.max(5, tolerance * 6, samples.pixel * 6);
  const cuts = new Set(corners);
  // Preserve measured straight runs at tangent-continuous line/arc joins.
  // These are segmentation cuts only: every fit still uses all raw points.
  // A true collinear plateau has stronger evidence than a noisy local turn.
  const straightTangents = new Map<number, Point>();
  const breaks: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    budget.tick();
    const incoming = unit(sub(ring[i], ring[(i + ring.length - 1) % ring.length]));
    const outgoing = unit(sub(ring[(i + 1) % ring.length], ring[i]));
    if (angle(incoming, outgoing) > 1e-7) breaks.push(i);
  }
  for (let k = 0; k < breaks.length; k++) {
    const a = breaks[k], b = breaks[(k + 1) % breaks.length];
    const count = (b - a + ring.length) % ring.length;
    const span = (samples.cumulative[b] - samples.cumulative[a] + samples.length) % samples.length;
    if (count >= 2 && span >= Math.max(minCurveLengthMm * 2, samples.pixel * 16, samples.length / 16)) { cuts.add(a); cuts.add(b); const tangent = unit(sub(ring[b], ring[a])); if (!locked.has(a)) straightTangents.set(a, tangent); if (!locked.has(b)) straightTangents.set(b, tangent); }
  }
  if (cuts.size < 3) {
    let seed = 0;
    for (let i = 1; i < ring.length; i++) if (ring[i].x < ring[seed].x || (ring[i].x === ring[seed].x && ring[i].y < ring[seed].y)) seed = i;
    for (let k = 0; k < 4; k++) cuts.add(samples.nearest(samples.cumulative[seed] + k * samples.length / 4));
  }
  // Never ask one cubic to wrap around most of a closed ring.
  let ordered = [...cuts].sort((a, b) => a - b);
  for (let j = 0; j < ordered.length; j++) {
    const a = ordered[j], b = ordered[(j + 1) % ordered.length];
    const span = (samples.cumulative[b] - samples.cumulative[a] + samples.length) % samples.length;
    const support: Point[] = [];
    for (let i = a; ; i = (i + 1) % ring.length) { support.push(ring[i]); if (i === b && support.length > 1) break; }
    // Straight-priority must happen before arbitrary closed-ring safety cuts:
    // placing a seed on a noise extreme can otherwise fragment a valid line.
    const count = lineBound(support, budget) <= tolerance * .999 ? 1 : Math.ceil(span / (samples.length * 0.3));
    for (let k = 1; k < count; k++) cuts.add(samples.nearest(samples.cumulative[a] + span * k / count));
  }
  ordered = [...cuts].sort((a, b) => a - b);
  const edges: FitEdge[] = [];
  const coordinateScale = ring.reduce((m, p) => Math.max(m, Math.abs(p.x), Math.abs(p.y)), 1);
  const reserve = Math.max(1e-10, coordinateScale * Number.EPSILON * 256);
  const allowed = tolerance - reserve;
  if (allowed <= 0) throw new FitFailure('numerical_precision: The requested tolerance is too small for these coordinates.');
  const emit = (edge: FitEdge) => { budget.edge(); edges.push(edge); };
  const fit = (points: Point[], left: Point, right: Point, depth: number) => {
    budget.tick();
    if (depth > AUTO_FIT_LIMITS.maxDepth) throw new FitFailure('subdivision_limit: The contour could not be fitted within the bounded recursion depth.');
    const linearError = lineBound(points, budget);
    // Bias flat runs to true lines; do not turn every tiny raster step into a cubic.
    if (linearError <= allowed || points.length === 2) {
      emit({ curve: [copy(points[0]), copy(points[0]), copy(points[points.length - 1]), copy(points[points.length - 1])], line: true, error: linearError + reserve, source: points }); return;
    }
    const support = points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);
    const curveSupported = sustainedBend(points, support, minCurveLengthMm, samples.pixel, tolerance, budget);
    let u = chordParameters(points, budget), c = generateBezier(points, u, left, right, budget), test = vertexError(c, points, u, budget);
    for (let iteration = 0; iteration <= 4; iteration++) {
      if (curveSupported && test.error <= allowed && monotone(c)) {
        const error = certify(c, points, u, allowed, budget);
        if (error !== null) { emit({ curve: c, line: false, error: error + reserve, source: points }); return; }
      }
      if (!curveSupported || iteration === 4 || test.error > tolerance * 8) break;
      const next = reparameterize(c, points, u, budget); if (!next) break;
      u = next; c = generateBezier(points, u, left, right, budget); test = vertexError(c, points, u, budget);
    }
    let split = Math.max(1, Math.min(points.length - 2, test.split));
    // Balanced fallback bounds pathological recursion near repeated error maxima.
    if (depth > 12 && (split < points.length / 8 || split > points.length * 7 / 8)) split = points.length >> 1;
    const h = Math.min(Math.max(samples.pixel * 2, samples.radius / 3), distance(points[0], points[points.length - 1]) / 4);
    let before = split - 1, after = split + 1, length = 0;
    while (before > 0 && length < h) { budget.tick(); length += distance(points[before], points[before + 1]); before--; }
    length = 0; while (after < points.length - 1 && length < h) { budget.tick(); length += distance(points[after], points[after - 1]); after++; }
    const tangent = unit(sub(points[after], points[before]));
    fit(points.slice(0, split + 1), left, scale(tangent, -1), depth + 1);
    fit(points.slice(split), tangent, right, depth + 1);
  };
  for (let j = 0; j < ordered.length; j++) {
    const first = ordered[j], last = ordered[(j + 1) % ordered.length], points = [];
    for (let i = first; ; i = (i + 1) % ring.length) { points.push(ring[i]); if (i === last && points.length > 1) break; }
    const span = (samples.cumulative[last] - samples.cumulative[first] + samples.length) % samples.length;
    fit(points, straightTangents.get(first) ?? samples.tangent(first, locked.has(first) ? 'forward' : 'smooth', span), scale(straightTangents.get(last) ?? samples.tangent(last, locked.has(last) ? 'backward' : 'smooth', span), -1), 0);
  }
  // Remove arbitrary smooth-ring cuts and recursive split anchors when the
  // joined raw support still admits one line. Real detected corners stay locked.
  let changed = true;
  while (changed && edges.length > 3) {
    changed = false;
    for (let i = 0; i < edges.length; i++) {
      const j = (i + 1) % edges.length, a = edges[i], b = edges[j];
      if (!a.line || !b.line || corners.some(index => same(ring[index], b.curve[0]))) continue;
      const source = [...a.source, ...b.source.slice(1)], error = lineBound(source, budget);
      if (error > allowed) continue;
      const joined: FitEdge = { curve: [a.curve[0], a.curve[0], b.curve[3], b.curve[3]], line: true, error: error + reserve, source };
      if (j === 0) { edges[i] = joined; edges.splice(0, 1); } else { edges[i] = joined; edges.splice(j, 1); }
      changed = true; break;
    }
  }
  const out: CurveVertex[] = edges.map(e => copy(e.curve[0]));
  edges.forEach((e, i) => { if (!e.line) { out[i].outgoing = copy(e.curve[1]); out[(i + 1) % out.length].incoming = copy(e.curve[2]); } });
  if (out.length < 3) throw new FitFailure('anchor_limit: A closed curve needs at least three anchors.');
  return { ring: out, edges, diagnostics: { ringIndex, rawPointCount: ring.length, anchorCount: out.length, cornerCount: corners.length, lineCount: edges.filter(e => e.line).length, cubicCount: edges.filter(e => !e.line).length, maxErrorBoundMm: Math.max(...edges.map(e => e.error)), minCurveLengthMm, pixelSizeMm: samples.pixel } };
}

/** Convex-hull separation through a shared endpoint proves adjacent edges only meet there. */
function endpointSeparated(a: Cubic, b: Cubic, p: Point): boolean {
  const ap = a.filter(v => !same(v, p)), bp = b.filter(v => !same(v, p));
  if (!ap.length || !bp.length) return false;
  const av = ap.reduce((x, v) => add(x, unit(sub(v, p))), { x: 0, y: 0 });
  const bv = bp.reduce((x, v) => add(x, unit(sub(v, p))), { x: 0, y: 0 });
  const normal = unit(sub(unit(bv), unit(av)));
  return ap.every(v => dot(sub(v, p), normal) < -EPS) && bp.every(v => dot(sub(v, p), normal) > EPS);
}
/** Reject even possible sub-flattening crossings; unresolved near touches fall back. */
function certifySeparation(a: Cubic, b: Cubic, shared: Point | null, budget: Budget, depth = 0): boolean {
  budget.tick();
  const ab = bounds(a), bb = bounds(b);
  if (!overlap(ab, bb)) return true;
  if (shared && (same(a[0], shared) || same(a[3], shared)) && (same(b[0], shared) || same(b[3], shared)) && endpointSeparated(a, b, shared)) return true;
  if (depth >= 28) return false;
  const extentA = ab.maxX - ab.minX + ab.maxY - ab.minY, extentB = bb.maxX - bb.minX + bb.maxY - bb.minY;
  if (extentA >= extentB) { const [left, right] = splitCubic(a, 0.5); return certifySeparation(left, b, shared, budget, depth + 1) && certifySeparation(right, b, shared, budget, depth + 1); }
  const [left, right] = splitCubic(b, 0.5); return certifySeparation(a, left, shared, budget, depth + 1) && certifySeparation(a, right, shared, budget, depth + 1);
}
function certifyTopology(edgeRings: FitEdge[][], budget: Budget) {
  const edges = edgeRings.flatMap((ring, r) => ring.map((edge, i) => ({ ...edge, r, i, n: ring.length })));
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    let shared: Point | null = null;
    if (a.r === b.r && (a.i + 1) % a.n === b.i) shared = a.curve[3];
    else if (a.r === b.r && (b.i + 1) % b.n === a.i) shared = b.curve[3];
    if (!certifySeparation(a.curve, b.curve, shared, budget)) throw new FitFailure('topology_uncertain: Fitted curves may cross or touch. The polygon was kept instead.');
  }
}

/**
 * Atomic result. Null never authorizes replacing a valid existing polygon.
 * Does not mutate input, delete holes, accept a partially fitted result, or fit
 * curves from a simplified polygon. Error is relative to the supplied polyline,
 * NOT to the physical material, photograph, segmentation or calibration truth.
 */
export function autoFitGeometry(raw: Geometry, options: AutoFitOptions): AutoFitResult {
  const started = performance.now();
  const diagnostics: AutoFitDiagnostics = { status: 'fallback', algorithm: 'schneider-1990-dense-contour-v1', toleranceMm: options?.toleranceMm ?? NaN, minCurveLengthMm: options?.minCurveLengthMm ?? Math.max(5, (options?.toleranceMm ?? 0) * 6, (options?.pixelSizeMm ?? 0) * 6), pixelSizeMm: options?.pixelSizeMm ?? null, straightPriority: true, recommendedToleranceMm: Math.max(.05, (options?.pixelSizeMm ?? 0) * 1.5), fragmented: false, warnings: [], maxErrorBoundMm: null, rawPointCount: 0, anchorCount: 0, cornerCount: 0, lineCount: 0, cubicCount: 0, operations: 0, elapsedMs: 0, rings: [] };
  let budget: Budget | null = null;
  const finish = (geometry: CurveGeometry | null): AutoFitResult => { diagnostics.operations = budget?.operations ?? 0; diagnostics.elapsedMs = performance.now() - started; return { geometry, diagnostics }; };
  try {
    if (!options || !Number.isFinite(options.toleranceMm) || options.toleranceMm <= 0 || options.toleranceMm > 100) throw new FitFailure('invalid_options: Fitting tolerance must be finite, greater than zero and no more than 100 mm.', true);
    if (options.pixelSizeMm !== undefined && (!Number.isFinite(options.pixelSizeMm) || options.pixelSizeMm <= 0)) throw new FitFailure('invalid_options: Mask pixel size must be finite positive millimetres.', true);
    if (options.minCurveLengthMm !== undefined && (!Number.isFinite(options.minCurveLengthMm) || options.minCurveLengthMm <= 0 || options.minCurveLengthMm > 1000)) throw new FitFailure('invalid_options: Minimum curve support must be finite, positive and no more than 1000 mm.', true);
    const maxPoints = options.maxInputPoints ?? AUTO_FIT_LIMITS.maxInputPoints, maxSegments = options.maxSegments ?? AUTO_FIT_LIMITS.maxSegments, maxOperations = options.maxOperations ?? AUTO_FIT_LIMITS.maxOperations;
    if (![maxPoints, maxSegments, maxOperations].every(x => Number.isSafeInteger(x) && x > 0) || maxPoints > AUTO_FIT_LIMITS.maxInputPoints || maxSegments > AUTO_FIT_LIMITS.maxSegments || maxOperations > AUTO_FIT_LIMITS.maxOperations) throw new FitFailure('invalid_options: Computation limits must be positive integers no greater than the documented safety caps.', true);
    budget = new Budget(maxOperations, maxSegments);
    if (!raw || !Array.isArray(raw.outer) || !Array.isArray(raw.holes) || raw.holes.some(r => !Array.isArray(r))) throw new FitFailure('invalid_input: Geometry requires an outer ring and an array of hole rings.', true);
    diagnostics.rawPointCount = raw.outer.length + raw.holes.reduce((sum, r) => sum + r.length, 0);
    if (diagnostics.rawPointCount > maxPoints || raw.holes.length > AUTO_FIT_LIMITS.maxHoles) throw new FitFailure('input_limit: Dense contour exceeds the point or hole safety limit. The existing polygon was kept.');
    const rings: Point[][] = [raw.outer, ...raw.holes].map(r => {
      const out: Point[] = [];
      for (const p of r) {
        budget!.tick();
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new FitFailure('invalid_input: Contour contains a non-finite coordinate.', true);
        if (!out.length || out[out.length - 1].x !== p.x || out[out.length - 1].y !== p.y) out.push(copy(p));
      }
      if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
      return out;
    });
    validateDense(rings, budget, true);
    const fitted = rings.map((ring, i) => fitRing(ring, i, options.toleranceMm, options.pixelSizeMm, options.minCurveLengthMm, budget!));
    const geometry: CurveGeometry = { outer: fitted[0].ring, holes: fitted.slice(1).map(r => r.ring) };
    certifyTopology(fitted.map(r => r.edges), budget);
    let flat: Geometry;
    try { flat = flattenCurve(geometry); } catch (error) { throw new FitFailure(`validation_limit: ${error instanceof Error ? error.message : String(error)}`); }
    const flatRings = [flat.outer, ...flat.holes];
    validateDense(flatRings, budget, false);
    if (flatRings.some((ring, i) => signedArea(ring) * signedArea(rings[i]) <= 0)) throw new FitFailure('topology_rejected: Fitting changed ring orientation.');
    diagnostics.rings = fitted.map(r => r.diagnostics);
    for (const r of diagnostics.rings) { diagnostics.anchorCount += r.anchorCount; diagnostics.cornerCount += r.cornerCount; diagnostics.lineCount += r.lineCount; diagnostics.cubicCount += r.cubicCount; }
    diagnostics.minCurveLengthMm = Math.max(...diagnostics.rings.map(r => r.minCurveLengthMm));
    diagnostics.maxErrorBoundMm = Math.max(...diagnostics.rings.map(r => r.maxErrorBoundMm));
    diagnostics.recommendedToleranceMm = Math.max(.05, ...diagnostics.rings.map(r => r.pixelSizeMm * 1.5));
    diagnostics.fragmented = diagnostics.rings.some(r => r.anchorCount >= 16 && (options.toleranceMm < r.pixelSizeMm * 1.5 || (r.cornerCount === 0 && r.lineCount >= 12)));
    if (diagnostics.fragmented) diagnostics.warnings.push('画素段差や細部まで保持して細分化しています。許容差を上げると単純化できる場合があります。');
    diagnostics.status = 'fitted';
    return finish(geometry);
  } catch (error) {
    diagnostics.status = error instanceof FitFailure && error.invalid ? 'invalid' : 'fallback';
    diagnostics.reason = error instanceof Error ? error.message : String(error);
    return finish(null);
  }
}
