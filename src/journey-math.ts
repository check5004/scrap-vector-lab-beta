import type { Point } from './geometry';

export type Quad = [Point, Point, Point, Point];
export type ProjectiveMatrix = [number, number, number, number, number, number, number, number, number];
export interface ViewTransform { scale: number; x: number; y: number; rotation?: number }
export interface Viewport { width: number; height: number }

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
export const smoothStep = (value: number): number => { const t = clamp01(value); return t * t * (3 - 2 * t); };
export const lerp = (from: number, to: number, progress: number): number => from + (to - from) * clamp01(progress);
export function interpolateQuad(from: Quad, to: Quad, progress: number): Quad {
  return from.map((p, i) => ({ x: lerp(p.x, to[i].x, progress), y: lerp(p.y, to[i].y, progress) })) as Quad;
}
export function rectangleQuad(width: number, height: number, x = 0, y = 0): Quad {
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}
export function fitPoints(points: Point[], viewport: Viewport, padding = 32): ViewTransform {
  if (!points.length || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw Error('Invalid view coordinates.');
  const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
  const width = Math.max(...points.map(p => p.x)) - left, height = Math.max(...points.map(p => p.y)) - top;
  if (width <= 0 || height <= 0 || viewport.width <= padding * 2 || viewport.height <= padding * 2) throw Error('Invalid view bounds.');
  const scale = Math.min((viewport.width - padding * 2) / width, (viewport.height - padding * 2) / height);
  return { scale, x: (viewport.width - width * scale) / 2 - left * scale, y: (viewport.height - height * scale) / 2 - top * scale };
}
export function transformPoint(point: Point, view: ViewTransform): Point {
  const angle = view.rotation ?? 0, cosine = Math.cos(angle), sine = Math.sin(angle);
  return { x: (point.x * cosine - point.y * sine) * view.scale + view.x, y: (point.x * sine + point.y * cosine) * view.scale + view.y };
}
export function interpolateView(from: ViewTransform, to: ViewTransform, progress: number): ViewTransform {
  return { scale: lerp(from.scale, to.scale, progress), x: lerp(from.x, to.x, progress), y: lerp(from.y, to.y, progress), rotation: lerp(from.rotation ?? 0, to.rotation ?? 0, progress) };
}

/** Rotate the original camera first, so a 180° source never collapses in corner interpolation. */
export function orientCropCamera(corners: Quad, viewport: Viewport, padding = 32): ViewTransform {
  const rotation = -Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x);
  const rotated = corners.map(point => transformPoint(point, { scale: 1, x: 0, y: 0, rotation }));
  return { ...fitPoints(rotated, viewport, padding), rotation };
}
/** Blend camera focus in source coordinates, rather than swinging around the image origin. */
export function interpolateCamera(from: ViewTransform, to: ViewTransform, progress: number, viewport: Viewport): ViewTransform {
  const center = (view: ViewTransform): Point => {
    const x = (viewport.width / 2 - view.x) / view.scale, y = (viewport.height / 2 - view.y) / view.scale;
    const angle = -(view.rotation ?? 0);
    return { x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) };
  };
  const a = center(from), b = center(to), rotation = lerp(from.rotation ?? 0, to.rotation ?? 0, progress);
  const scale = lerp(from.scale, to.scale, progress);
  const focus = transformPoint({ x: lerp(a.x, b.x, progress), y: lerp(a.y, b.y, progress) }, { scale, x: 0, y: 0, rotation });
  return { scale, rotation, x: viewport.width / 2 - focus.x, y: viewport.height / 2 - focus.y };
}

/** A real projective map from a rectangle to TL/TR/BR/BL; never an affine approximation. */
export function rectangleToQuad(width: number, height: number, corners: Quad): ProjectiveMatrix {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height) || corners.length !== 4 || corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw Error('Invalid projective plane.');
  // A folding or collapsed quad cannot represent the visible side of one planar photo.
  const turns = corners.map((a, i) => {
    const b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  const areaScale = Math.max(1, ...corners.map((p, i) => Math.hypot(p.x - corners[(i + 1) % 4].x, p.y - corners[(i + 1) % 4].y))) ** 2;
  if (turns.some(v => Math.abs(v) < areaScale * 1e-10) || !turns.every(v => Math.sign(v) === Math.sign(turns[0]))) throw Error('Degenerate or folded projective plane.');
  const [a, b, c, d] = corners;
  const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < areaScale * 1e-12) throw Error('Singular projective plane.');
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  if ([1, 1 + g, 1 + g + h, 1 + h].some(v => v <= 1e-9)) throw Error('Projective plane crosses its horizon.');
  return [(b.x - a.x + g * b.x) / width, (d.x - a.x + h * d.x) / height, a.x,
    (b.y - a.y + g * b.y) / width, (d.y - a.y + h * d.y) / height, a.y,
    g / width, h / height, 1];
}
export function projectPoint(matrix: readonly number[], point: Point): Point {
  if (matrix.length !== 9 || matrix.some(n => !Number.isFinite(n))) throw Error('Invalid homography.');
  const divisor = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-10) throw Error('Point lies on projective horizon.');
  const projected = { x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / divisor, y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / divisor };
  if (!Number.isFinite(projected.x + projected.y)) throw Error('Non-finite projected point.');
  return projected;
}
export const CSS_PLANE_EXTENT = 100;
/**
 * Condition the DOM plane's coordinate domain without changing its raster buffer.
 * Chromium can quantize very small CSS perspective coefficients. A fixed 100×100
 * CSS box keeps those coefficients useful; the canvas still contains every native
 * pixel. The square also avoids fractional CSS layout-size rounding. Overlays and
 * exported geometry continue to use the authoritative native-pixel homography.
 */
export function conditionedPlaneMatrix(matrix: ProjectiveMatrix, pixelWidth: number, pixelHeight: number): ProjectiveMatrix {
  if (!(pixelWidth > 0 && pixelHeight > 0) || !Number.isFinite(pixelWidth + pixelHeight) || matrix.some(value => !Number.isFinite(value))) throw Error('Invalid CSS plane domain.');
  const x = pixelWidth / CSS_PLANE_EXTENT, y = pixelHeight / CSS_PLANE_EXTENT;
  return [matrix[0] * x, matrix[1] * y, matrix[2], matrix[3] * x, matrix[4] * y, matrix[5], matrix[6] * x, matrix[7] * y, matrix[8]];
}

/** CSS is column-major; its w component performs the same division as projectPoint. */
export function matrix3d(matrix: ProjectiveMatrix): string {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  return `matrix3d(${[a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, i].join(',')})`;
}

export interface DimensionEdge { id: string; from: Point; to: Point; lengthMm: number; hole: boolean }
/** Retains every genuine supplied edge, including holes; rounding is a display decision only. */
export function dimensionEdges(outer: Point[], holes: Point[][] = []): DimensionEdge[] {
  return [outer, ...holes].flatMap((ring, r) => ring.map((from, i) => {
    const to = ring[(i + 1) % ring.length];
    return { id: r ? `H${r}E${i + 1}` : `E${i + 1}`, from, to, lengthMm: Math.hypot(to.x - from.x, to.y - from.y), hole: r > 0 };
  }));
}
