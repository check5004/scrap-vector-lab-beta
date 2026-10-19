import { AR } from "./vendor/aruco.js";
import { CV } from "./vendor/cv.js";
import {
  polygonArea,
  validateGeometry,
  type Geometry,
  type Point,
} from "./geometry";
export interface Board {
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  preset: string;
}
export interface Marker {
  id: number;
  corners: Point[];
  hammingDistance: number;
}
export const PRESETS: Record<string, Board> = {
  a4: {
    width: 250,
    height: 170,
    pixelWidth: 2500,
    pixelHeight: 1700,
    preset: "A4_LANDSCAPE_250x170",
  },
  medium: {
    width: 500,
    height: 500,
    pixelWidth: 2000,
    pixelHeight: 2000,
    preset: "TABLE_500x500",
  },
  large: {
    width: 1000,
    height: 1000,
    pixelWidth: 2000,
    pixelHeight: 2000,
    preset: "TABLE_1000x1000",
  },
};
export function customBoard(width: number, height: number): Board {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 10 ||
    height < 10 ||
    width > 10000 ||
    height > 10000 ||
    Math.max(width, height) / Math.min(width, height) > 20
  )
    throw Error("基準寸法は 10〜10,000 mm、縦横比は 20:1 以内にしてください。");
  const s = Math.max(width, height) / 2000;
  return {
    width,
    height,
    pixelWidth: Math.round(width / s),
    pixelHeight: Math.round(height / s),
    preset: "CUSTOM",
  };
}
export async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}
export function canvas(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}
export function imageCanvas(img: HTMLImageElement) {
  if (img.naturalWidth * img.naturalHeight > 60e6)
    throw Error("画像が大きすぎます。60 MP以下に縮小してください。");
  const s = Math.min(1, 3200 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = canvas(
    Math.round(img.naturalWidth * s),
    Math.round(img.naturalHeight * s),
  );
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
export interface MarkerDetectionReport {
  markers: Marker[];
  decodedMarkers: Marker[];
  rejectedCandidates: Point[][];
  missingIds: number[];
  duplicateIds: number[];
  candidateCount: number;
  sourceSize: [number, number];
  detectorSize: [number, number];
  elapsedMs: number;
}
let dictionaryReady = false;
export async function inspectMarkers(
  source: HTMLCanvasElement,
): Promise<MarkerDetectionReport> {
  const start = performance.now();
  if (!dictionaryReady) {
    const r = await fetch(`${import.meta.env.BASE_URL}print/dictionary.json`);
    if (!r.ok) throw Error("マーカー辞書を読み込めません。");
    const dict = await r.json();
    AR.DICTIONARIES.DICT_4X4_50 = dict.dictionary ?? dict;
    dictionaryReady = true;
  }
  const scale = Math.min(1, 1800 / Math.max(source.width, source.height));
  const c = canvas(
    Math.round(source.width * scale),
    Math.round(source.height * scale),
  );
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const detector = new AR.Detector({
    dictionaryName: "DICT_4X4_50",
    maxHammingDistance: 1,
  });
  const decodedMarkers: Marker[] = detector
    .detect(ctx.getImageData(0, 0, c.width, c.height))
    .map((m: Marker) => ({
      ...m,
      corners: m.corners.map((p) => ({ x: p.x / scale, y: p.y / scale })),
    }));
  const center = (points: Point[]) => ({
    x: points.reduce((sum, p) => sum + p.x, 0) / 4,
    y: points.reduce((sum, p) => sum + p.y, 0) / 4,
  });
  const candidateQuads: Point[][] = detector.candidates.map((quad: Point[]) =>
    quad.map((p) => ({ x: p.x / scale, y: p.y / scale })),
  );
  // These are detector quadrilaterals which did not decode, not photographic scrap edges.
  const rejectedCandidates = candidateQuads.filter(
    (quad) =>
      !decodedMarkers.some((m) => {
        const a = center(quad),
          b = center(m.corners);
        return (
          Math.hypot(a.x - b.x, a.y - b.y) < 2 / scale &&
          Math.abs(polygonArea(quad) - polygonArea(m.corners)) < 4 / scale
        );
      }),
  );
  const found: Marker[] = [];
  for (const m of decodedMarkers
    .filter((m) => m.id >= 0 && m.id <= 3)
    .sort((a, b) => polygonArea(b.corners) - polygonArea(a.corners))) {
    const c = center(m.corners),
      side = Math.sqrt(polygonArea(m.corners));
    if (
      !found.some(
        (f) =>
          f.id === m.id &&
          Math.hypot(center(f.corners).x - c.x, center(f.corners).y - c.y) <
            side * 0.15,
      )
    )
      found.push(m);
  }
  return {
    markers: found.sort((a, b) => a.id - b.id),
    decodedMarkers,
    rejectedCandidates,
    missingIds: [0, 1, 2, 3].filter((id) => !found.some((m) => m.id === id)),
    duplicateIds: [0, 1, 2, 3].filter(
      (id) => found.filter((m) => m.id === id).length > 1,
    ),
    candidateCount: candidateQuads.length,
    sourceSize: [source.width, source.height],
    detectorSize: [c.width, c.height],
    elapsedMs: performance.now() - start,
  };
}
export function assertMarkerReport(report: MarkerDetectionReport): Marker[] {
  if (report.missingIds.length)
    throw Error(
      `マーカー ID ${report.missingIds.join(", ")} が見つかりません。デバッグ画像で検出結果を確認してください。`,
    );
  if (report.duplicateIds.length)
    throw Error(
      `ID ${report.duplicateIds.join(", ")} が重複しています。同じマーカーを2枚置かないでください。`,
    );
  return report.markers;
}
export async function detectMarkers(
  source: HTMLCanvasElement,
): Promise<Marker[]> {
  return assertMarkerReport(await inspectMarkers(source));
}
export function homographyDetails(markers: Marker[], board: Board) {
  const sourcePoints = [2, 3, 0, 1].map(
    (corner, id) => markers.find((m) => m.id === id)!.corners[corner],
  );
  const destination = [
    { x: 0, y: 0 },
    { x: board.pixelWidth, y: 0 },
    { x: board.pixelWidth, y: board.pixelHeight },
    { x: 0, y: board.pixelHeight },
  ];
  return {
    reference_corner_indices: [2, 3, 0, 1],
    source_points_px: sourcePoints,
    destination_points_px: destination,
    source_to_rectified_h: solveHomography(sourcePoints, destination),
    rectified_to_source_h: solveHomography(destination, sourcePoints),
    board_size_mm: { width_mm: board.width, height_mm: board.height },
    output_size_px: [board.pixelWidth, board.pixelHeight],
    warning:
      "Four reference points fit exactly; this is not an independent calibration-accuracy check.",
  };
}
export function solveHomography(from: Point[], to: Point[]): number[] {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i],
      u = to[i].x,
      v = to[i].y;
    a.push(
      [x, y, 1, 0, 0, 0, -u * x, -u * y, u],
      [0, 0, 0, x, y, 1, -v * x, -v * y, v],
    );
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++)
      if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-10)
      throw Error(
        "マーカー配置が退化しています。撮影角度を浅くしすぎないでください。",
      );
    [a[p], a[c]] = [a[c], a[p]];
    const v = a[c][c];
    for (let j = c; j < 9; j++) a[c][j] /= v;
    for (let r = 0; r < 8; r++)
      if (r !== c) {
        const k = a[r][c];
        for (let j = c; j < 9; j++) a[r][j] -= k * a[c][j];
      }
  }
  return a.map((r) => r[8]).concat(1);
}
export function project(h: number[], p: Point): Point {
  const d = h[6] * p.x + h[7] * p.y + 1;
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / d,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / d,
  };
}
export function rectify(
  source: HTMLCanvasElement,
  markers: Marker[],
  board: Board,
): HTMLCanvasElement {
  // Canonical ArUco corner order TL,TR,BR,BL. Always select the inward-facing corner.
  const corners = [2, 3, 0, 1].map(
    (corner, id) => markers.find((m) => m.id === id)!.corners[corner],
  );
  const quad = { outer: corners, holes: [] };
  if (
    !validateGeometry(quad).valid ||
    polygonArea(corners) < source.width * source.height * 0.005
  )
    throw Error(
      "基準点が不正、または小さすぎます。マーカーの位置と向きを確認してください。",
    );
  const center = {
    x: corners.reduce((s, p) => s + p.x, 0) / 4,
    y: corners.reduce((s, p) => s + p.y, 0) / 4,
  };
  for (const m of markers) {
    const nearest = m.corners
      .map((p, index) => ({
        index,
        d: Math.hypot(p.x - center.x, p.y - center.y),
      }))
      .sort((a, b) => a.d - b.d)[0].index;
    if (nearest !== [2, 3, 0, 1][m.id])
      throw Error(
        "マーカーの向きが規定と違います。切り離した各マーカーも台紙と同じ向きに配置してください。写真全体の回転は問題ありません。",
      );
  }
  const signs = corners.map((p, i) => {
    const q = corners[(i + 1) % 4],
      r = corners[(i + 2) % 4];
    return (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
  });
  if (!signs.every((x) => x > 0))
    throw Error(
      "ID配置が規定順序ではありません。0左上、1右上、2右下、3左下です。",
    );
  const w = board.pixelWidth,
    h = board.pixelHeight;
  // Continuous board bounds are [0,Wpx]x[0,Hpx]; pixel centers sample at +0.5.
  const inv = solveHomography(
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    corners,
  );
  const src = source
    .getContext("2d", { willReadFrequently: true })!
    .getImageData(0, 0, source.width, source.height);
  const result = canvas(w, h),
    ctx = result.getContext("2d")!,
    out = ctx.createImageData(w, h),
    s = src.data,
    d = out.data,
    sw = source.width,
    sh = source.height;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = project(inv, { x: x + 0.5, y: y + 0.5 }),
        sx = q.x - 0.5,
        sy = q.y - 0.5,
        ix = Math.floor(sx),
        iy = Math.floor(sy),
        fx = sx - ix,
        fy = sy - iy,
        k = (y * w + x) * 4;
      if (ix < 0 || iy < 0 || ix + 1 >= sw || iy + 1 >= sh) {
        d[k] = d[k + 1] = d[k + 2] = 255;
        d[k + 3] = 255;
        continue;
      }
      const j = (iy * sw + ix) * 4;
      for (let c = 0; c < 3; c++)
        d[k + c] =
          (s[j + c] * (1 - fx) + s[j + 4 + c] * fx) * (1 - fy) +
          (s[j + sw * 4 + c] * (1 - fx) + s[j + sw * 4 + 4 + c] * fx) * fy;
      d[k + 3] = 255;
    }
  ctx.putImageData(out, 0, 0);
  return result;
}
export function gridImage(
  source: HTMLCanvasElement,
  board: Board,
  step: number,
): HTMLCanvasElement {
  const out = canvas(source.width, source.height),
    ctx = out.getContext("2d")!;
  ctx.drawImage(source, 0, 0);
  const sx = out.width / board.width,
    sy = out.height / board.height;
  ctx.strokeStyle = "rgba(0,90,120,.4)";
  ctx.fillStyle = "#034e66";
  ctx.lineWidth = 1.5;
  ctx.font = `${Math.max(14, out.width / 130)}px sans-serif`;
  for (let x = 0; x <= board.width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x * sx, 0);
    ctx.lineTo(x * sx, out.height);
    ctx.stroke();
    ctx.fillText(`${x}`, x * sx + 3, 22);
  }
  for (let y = 0; y <= board.height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y * sy);
    ctx.lineTo(out.width, y * sy);
    ctx.stroke();
    ctx.fillText(`${y}`, 3, y * sy + 18);
  }
  return out;
}
function inside(p: Point, ring: Point[]) {
  let b = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    if (
      ring[i].y > p.y !== ring[j].y > p.y &&
      p.x <
        ((ring[j].x - ring[i].x) * (p.y - ring[i].y)) /
          (ring[j].y - ring[i].y) +
          ring[i].x
    )
      b = !b;
  return b;
}
export interface MaskResult {
  probabilities: Float32Array;
  width: number;
  height: number;
  elapsedMs: number;
  timingsMs?: {
    modelLoad: number;
    preprocess: number;
    inference: number;
    normalize: number;
    total: number;
  };
}
export interface MaskTrace {
  rawGeometry: Geometry;
  contours: { hole: boolean; points: Point[] }[];
  discardedComponentCount: number;
  warnings: string[];
}
export function traceMask(
  mask: MaskResult,
  board: Board,
  threshold = 0.5,
): MaskTrace {
  const binary = Uint8Array.from(mask.probabilities, (v) =>
    v >= threshold ? 255 : 0,
  );
  const contours: (Point[] & { hole: boolean })[] = CV.findContours(
    new CV.Image(mask.width, mask.height, binary),
    [],
  );
  const mapped = contours.map((c) => ({
    hole: c.hole,
    points: c.map((p) => ({
      x: ((p.x + 0.5) * board.width) / mask.width,
      y: ((p.y + 0.5) * board.height) / mask.height,
    })),
  }));
  const outers = mapped
    .filter((c) => !c.hole)
    .sort((a, b) => polygonArea(b.points) - polygonArea(a.points));
  if (
    !outers.length ||
    polygonArea(outers[0].points) < board.width * board.height * 0.0005
  )
    throw Error(
      "AIマスクから有効な端材が見つかりません。背景・照明を変えて撮影し直してください。",
    );
  const main = outers[0].points,
    holes = mapped.filter(
      (c) => c.hole && c.points.length >= 3 && inside(c.points[0], main),
    );
  const warnings: string[] = [];
  if (outers.length > 1)
    warnings.push(
      `${outers.length - 1}個の小さな別成分を除外し、最大の端材を採用。`,
    );
  if (
    main.some(
      (p) =>
        p.x < (board.width / mask.width) * 2 ||
        p.y < (board.height / mask.height) * 2 ||
        p.x > board.width * (1 - 2 / mask.width) ||
        p.y > board.height * (1 - 2 / mask.height),
    )
  )
    warnings.push(
      "領域が画像の端に接しています。端材の一部が切れている可能性があります。",
    );
  warnings.push(
    "穴の検出保証はありません。AIが穴を埋めていないか、写真とマスクで確認してください。",
  );
  return {
    rawGeometry: { outer: main, holes: holes.map((h) => h.points) },
    contours: mapped,
    discardedComponentCount: outers.length - 1,
    warnings,
  };
}
export function simplifyMaskTrace(
  trace: MaskTrace,
  epsilon: number,
): { geometry: Geometry; warnings: string[] } {
  // Coordinates are converted to millimetres BEFORE Douglas–Peucker.
  const approx = (ring: Point[]) => CV.approxPolyDP(ring, epsilon) as Point[];
  const geometry = {
    outer: approx(trace.rawGeometry.outer),
    holes: trace.rawGeometry.holes.map(approx),
  };
  const valid = validateGeometry(geometry);
  if (!valid.valid)
    throw Error(
      `マスクの輪郭が不正です。εや閾値を調整してください。${valid.errors.join(" ")}`,
    );
  return { geometry, warnings: trace.warnings };
}
export function vectorizeMask(
  mask: MaskResult,
  board: Board,
  epsilon: number,
  threshold = 0.5,
) {
  return simplifyMaskTrace(traceMask(mask, board, threshold), epsilon);
}
