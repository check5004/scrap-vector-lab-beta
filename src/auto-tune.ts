/** Bounded, deterministic review candidates from one unchanged neural probability mask. */
import { geometryArea, pointToSegmentDistance, polygonArea, type Geometry, type Point } from './geometry';
import { simplifyMaskTrace, traceMask, type Board, type MaskResult, type MaskTrace } from './vision';

export const AUTO_TUNE_LIMITS = Object.freeze({
  minimumThreshold: 0.1, maximumThreshold: 0.9,
  minimumEpsilon: 0.5, maximumEpsilon: 10,
  maximumCandidates: 80, maximumGuidedThresholds: 4,
  defaultElapsedMs: 30_000, maximumElapsedMs: 120_000,
  fidelitySampleLimit: 65_536, boundarySampleLimit: 512,
  maximumRawVertices: 20_000, maximumHoles: 128, maximumDiagnosticCharacters: 800,
});
export const AUTO_TUNE_WARNINGS = [
  'Heuristic score only: it is not a calibrated probability, physical accuracy estimate, or guarantee of the best threshold.',
  'Semantic blind spot: a stable neural mask can include background, miss material, or fill a real hole. Compare the photograph, mask, raw contour, and simplified contour.',
  'Holes and fine features are not guaranteed. Search never intentionally drops a traced hole; threshold changes and simplification can still change details.',
  'Search changes only foreground threshold (0.1–0.9) and simplification epsilon (0.5–10 mm). Calibration, dimensions, homography, model, and probabilities stay fixed.',
];

export interface CandidateMetrics {
  foregroundFraction: number;
  foregroundPixels: number;
  selectedComponentPixels: number;
  componentCount: number;
  discardedComponentCount: number;
  /** Actual foreground pixels outside the component selected by traceMask. */
  discardedAreaRatio: number;
  /** Selected component pixels on the image border / its boundary pixels. */
  borderContactRatio: number;
  borderContactPixels: number;
  /** Minimum selected contour clearance from the frame, in source-mask pixels. */
  edgeClearancePx: number;
  /** IoU of nested binary masks at threshold ±0.025, clipped to the allowed range. */
  thresholdStability: number;
  /** Deterministic pixel-center samples, compared with this candidate's actual binary component. */
  regionFidelityIoU: number;
  fidelitySampleCount: number;
  fidelitySampleStride: number;
  /** Bidirectional sampled contour-to-segment distance; not a certified Hausdorff bound. */
  boundaryDeviationMm: number;
  boundarySamplingUsed: boolean;
  rawAreaMm2: number;
  simplifiedAreaMm2: number;
  areaRetentionRatio: number;
  rawHoleCount: number;
  simplifiedHoleCount: number;
  /** Symmetric per-hole area agreement, not a reward for having more holes. */
  minimumHoleAreaAgreement: number;
  rawVertexCount: number;
  simplifiedVertexCount: number;
  observedHoleCountMin: number;
  observedHoleCountMax: number;
  observedComponentCountMin: number;
  observedComponentCountMax: number;
  topologyVariesAcrossThresholds: boolean;
  regionVariesAcrossThresholds: boolean;
}
export interface Candidate {
  id: string;
  threshold: number;
  epsilon: number;
  geometry: Geometry;
  rawGeometry: Geometry;
  /** A dimensionless heuristic on a 0–100 scale, never an accuracy percentage. */
  score: number;
  metrics: CandidateMetrics;
  warnings: string[];
  grade: 'usable' | 'ambiguous';
  /** Numeric guardrails only. The UI must still disclose the universal semantic warnings. */
  safeToAutoApply: boolean;
}
export type SearchStage = 'coarse' | 'guided' | 'fine';
export interface SearchAttempt {
  id: string;
  threshold: number;
  epsilon: number;
  stage: SearchStage;
  valid: boolean;
  invalidReason?: string;
  score?: number;
}
export type SearchStoppedReason = 'completed' | 'cancelled' | 'candidate_limit' | 'time_limit' | 'invalid_input' | 'no_valid_candidate';
export interface SearchResult {
  candidates: Candidate[];
  attempts: SearchAttempt[];
  best?: Candidate;
  elapsedMs: number;
  stoppedReason: SearchStoppedReason;
  universalWarnings: string[];
}
export interface SearchProgress {
  attempts: number;
  validCandidates: number;
  maxCandidates: number;
  elapsedMs: number;
  stage: SearchStage;
  attempt: SearchAttempt;
  candidate?: Candidate;
  best?: Candidate;
}
export interface SearchOptions {
  currentThreshold?: number;
  currentEpsilon?: number;
  /** Optional numeric suggestions, e.g. from an LLM; at most four in-range values are used. */
  candidateThresholds?: readonly number[];
  maxCandidates?: number;
  /** Checked between synchronous candidates. An in-flight trace cannot be interrupted. */
  maxElapsedMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: SearchProgress) => void;
}

interface ThresholdContext {
  trace: MaskTrace;
  selected: Uint8Array;
  foregroundPixels: number;
  selectedPixels: number;
  componentCount: number;
  borderPixels: number;
  boundaryPixels: number;
  stability: number;
}
interface TraceObservation { holeCount: number; componentCount: number; selectedPixels: number }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number) => Math.round(v * 1000) / 1000;
const countVertices = (g: Geometry) => g.outer.length + g.holes.reduce((sum, ring) => sum + ring.length, 0);
const ratioAgreement = (a: number, b: number) => Math.min(a, b) / Math.max(a, b, Number.EPSILON);
const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const now = () => performance.now();
const diagnosticError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'Candidate processing failed.';
  const limit = AUTO_TUNE_LIMITS.maximumDiagnosticCharacters;
  return message.length <= limit ? message : `${message.slice(0, limit)}… [additional diagnostics omitted]`;
};

function validateInput(mask: MaskResult, board: Board): string | undefined {
  if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width < 2 || mask.height < 2 || !Number.isSafeInteger(mask.width * mask.height) || mask.probabilities.length !== mask.width * mask.height)
    return 'Mask dimensions and probability length do not match, or are too small.';
  if (![board.width, board.height, board.pixelWidth, board.pixelHeight].every(v => Number.isFinite(v) && v > 0))
    return 'The calibrated board must have finite positive dimensions. Auto-tune cannot repair calibration.';
  for (const probability of mask.probabilities) if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    return 'Neural mask contains a non-finite or out-of-range probability. Run segmentation again.';
  return undefined;
}

/** Counts real 8-connected foreground components; no replacement segmentation or cleanup. */
function thresholdContext(mask: MaskResult, board: Board, threshold: number, observe: (observation: TraceObservation) => void): ThresholdContext {
  const { width, height, probabilities } = mask;
  const size = width * height, labels = new Int32Array(size), queue = new Int32Array(size);
  let foregroundPixels = 0, lowPixels = 0, highPixels = 0;
  const low = Math.max(0.1, threshold - 0.025), high = Math.min(0.9, threshold + 0.025);
  for (let i = 0; i < size; i++) {
    if (probabilities[i] >= threshold) { labels[i] = -1; foregroundPixels++; }
    if (probabilities[i] >= low) lowPixels++;
    if (probabilities[i] >= high) highPixels++;
  }
  if (!foregroundPixels) throw Error('empty_foreground: no foreground pixels at this threshold.');
  if (foregroundPixels === size) throw Error('full_foreground: every pixel is foreground at this threshold.');
  const components: { pixels: number; border: number; boundary: number }[] = [];
  for (let seed = 0; seed < size; seed++) {
    if (labels[seed] !== -1) continue;
    const id = components.length + 1;
    let head = 0, tail = 1, pixels = 0, border = 0, boundary = 0;
    labels[seed] = id; queue[0] = seed;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      pixels++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || labels[p - 1] === 0 || labels[p + 1] === 0 || labels[p - width] === 0 || labels[p + width] === 0) boundary++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const n = p + dy * width + dx;
        if (labels[n] === -1) { labels[n] = id; queue[tail++] = n; }
      }
    }
    components.push({ pixels, border, boundary });
  }
  // Use exactly the region selected by the existing contour path, not an area-ranked substitute.
  const trace = traceMask(mask, board, threshold), seed = trace.rawGeometry.outer[0];
  const x = clamp(Math.round(seed.x * width / board.width - 0.5), 0, width - 1);
  const y = clamp(Math.round(seed.y * height / board.height - 0.5), 0, height - 1);
  const selectedId = labels[y * width + x];
  if (selectedId <= 0) throw Error('selected_component_unresolved: traced contour does not map to foreground.');
  const stats = components[selectedId - 1];
  // Failed simplification/complexity must not erase evidence that another threshold had holes.
  observe({ holeCount: trace.rawGeometry.holes.length, componentCount: components.length, selectedPixels: stats.pixels });
  if (trace.rawGeometry.holes.length > AUTO_TUNE_LIMITS.maximumHoles || countVertices(trace.rawGeometry) > AUTO_TUNE_LIMITS.maximumRawVertices)
    throw Error(`contour_complexity_limit: ${trace.rawGeometry.holes.length} holes and ${countVertices(trace.rawGeometry)} raw vertices exceed bounded-search limits. No holes or fine features were removed; review manually.`);
  const selected = Uint8Array.from(labels, label => label === selectedId ? 1 : 0);
  return { trace, selected, foregroundPixels, selectedPixels: stats.pixels, componentCount: components.length,
    borderPixels: stats.border, boundaryPixels: stats.boundary, stability: highPixels / Math.max(lowPixels, 1) };
}

interface RowIntervals { inside: [number, number][]; boundary: [number, number][] }
function rowIntervals(ring: Point[], y: number): RowIntervals {
  const crossings: number[] = [], boundary: [number, number][] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (Math.abs(a.y - y) < 1e-8 && Math.abs(b.y - y) < 1e-8) boundary.push([Math.min(a.x, b.x), Math.max(a.x, b.x)]);
    else if (y >= Math.min(a.y, b.y) - 1e-8 && y <= Math.max(a.y, b.y) + 1e-8) {
      const x = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
      boundary.push([x, x]);
    }
    if ((a.y > y) !== (b.y > y)) crossings.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
  }
  crossings.sort((a, b) => a - b);
  const inside: [number, number][] = [];
  for (let i = 0; i + 1 < crossings.length; i += 2) inside.push([crossings[i], crossings[i + 1]]);
  return { inside, boundary };
}
function rowContains(row: RowIntervals, x: number, includeBoundary: boolean): boolean {
  if (row.boundary.some(([a, b]) => x >= a - 1e-8 && x <= b + 1e-8)) return includeBoundary;
  return row.inside.some(([a, b]) => x > a && x < b);
}
function fidelity(geometry: Geometry, context: ThresholdContext, mask: MaskResult, board: Board) {
  const stride = Math.max(1, Math.ceil(Math.sqrt(mask.width * mask.height / AUTO_TUNE_LIMITS.fidelitySampleLimit)));
  let intersection = 0, union = 0, samples = 0;
  // Include every pixel on small masks. A deterministic grid bounds work on larger masks.
  for (let y = 0; y < mask.height; y += stride) {
    const mmY = (y + 0.5) * board.height / mask.height;
    const outer = rowIntervals(geometry.outer, mmY), holes = geometry.holes.map(ring => rowIntervals(ring, mmY));
    for (let x = 0; x < mask.width; x += stride) {
      const mmX = (x + 0.5) * board.width / mask.width;
      const predicted = rowContains(outer, mmX, true) && !holes.some(row => rowContains(row, mmX, false));
      const expected = context.selected[y * mask.width + x] === 1;
      if (predicted && expected) intersection++;
      if (predicted || expected) union++;
      samples++;
    }
  }
  // An undersampled tiny component is ambiguous, never a perfect match by empty union.
  return { iou: union ? intersection / union : 0, samples, stride };
}

function boundaryDeviation(raw: Geometry, simplified: Geometry): { distance: number; sampled: boolean } {
  let largest = 0, sampled = false;
  const ringsA = [raw.outer, ...raw.holes], ringsB = [simplified.outer, ...simplified.holes];
  for (let r = 0; r < ringsA.length; r++) {
    for (const [source, target] of [[ringsA[r], ringsB[r]], [ringsB[r], ringsA[r]]]) {
      const stride = Math.max(1, Math.ceil(source.length / AUTO_TUNE_LIMITS.boundarySampleLimit));
      if (stride > 1) sampled = true;
      for (let i = 0; i < source.length; i += stride) {
        // Midpoints also detect simplified chords cutting across concavities.
        for (const point of [source[i], { x: (source[i].x + source[(i + 1) % source.length].x) / 2, y: (source[i].y + source[(i + 1) % source.length].y) / 2 }]) {
          let nearest = Infinity;
          for (let j = 0; j < target.length; j++) nearest = Math.min(nearest, pointToSegmentDistance(point, target[j], target[(j + 1) % target.length]));
          largest = Math.max(largest, nearest);
        }
      }
    }
  }
  return { distance: largest, sampled };
}

function evaluate(context: ThresholdContext, mask: MaskResult, board: Board, threshold: number, epsilon: number, id: string): Candidate {
  const { geometry } = simplifyMaskTrace(context.trace, epsilon), raw = context.trace.rawGeometry;
  if (geometry.holes.length !== raw.holes.length) throw Error('hole_topology_changed: simplification removed or added a traced hole.');
  const fit = fidelity(geometry, context, mask, board), boundary = boundaryDeviation(raw, geometry);
  const discarded = 1 - context.selectedPixels / context.foregroundPixels;
  const rawArea = geometryArea(raw), area = geometryArea(geometry);
  const holeAgreement = raw.holes.reduce((minimum, hole, i) => Math.min(minimum, ratioAgreement(polygonArea(hole), polygonArea(geometry.holes[i]))), 1);
  const borderRatio = context.borderPixels / Math.max(1, context.boundaryPixels);
  const edgeClearance = raw.outer.reduce((minimum, point) => Math.min(minimum,
    point.x * mask.width / board.width - 0.5, point.y * mask.height / board.height - 0.5,
    mask.width - 0.5 - point.x * mask.width / board.width, mask.height - 0.5 - point.y * mask.height / board.height), Infinity);
  const resolution = Math.hypot(board.width / mask.width, board.height / mask.height);
  const boundaryAgreement = 1 / (1 + boundary.distance / Math.max(0.5, resolution));
  // Neither foreground size, hole count, nor low vertex count earns any reward.
  const score = clamp(100 * (0.48 * fit.iou + 0.22 * context.stability + 0.15 * (1 - discarded) + 0.10 * boundaryAgreement + 0.05 * holeAgreement) - 12 * borderRatio, 0, 100);
  const warnings = [...context.trace.warnings];
  const nearlyFull = context.foregroundPixels / mask.probabilities.length > 0.95;
  if (nearlyFull) warnings.push('Nearly the entire frame is foreground. This may be valid large material or background inclusion; inspect the photograph before applying.');
  if (discarded > 0) warnings.push(`Discarded ${(discarded * 100).toFixed(2)}% of foreground pixel area in ${context.componentCount - 1} other component(s). Multiple scraps or lost fine pieces may be ambiguous.`);
  if (discarded >= 0.2) warnings.push('A substantial competing foreground component was discarded; do not automatically assume the selected object is the intended scrap.');
  if (context.borderPixels) warnings.push('The selected component touches the image border; the material may be cropped.');
  else if (edgeClearance < 2) warnings.push('The selected component lies within two mask pixels of the image edge. A thin empty border does not rule out background leakage or cropped material.');
  if (context.stability < 0.95) warnings.push('Small threshold changes materially change foreground coverage.');
  if (fit.iou < 0.95) warnings.push('Simplified geometry differs noticeably from the selected binary region. Check thin bridges, notches, and holes.');
  if (holeAgreement < 0.9) warnings.push('Simplification materially changes at least one traced hole; a lower epsilon may retain its shape better.');
  if (boundary.distance > Math.max(1, resolution)) warnings.push('Simplification moves part of the sampled boundary by more than the review tolerance. Check narrow features and notches even when overall region overlap is high.');
  if (fit.stride > 1 || boundary.sampled) warnings.push('細い形状は検証で見落とす場合があります。写真と照合してください。');
  const safe = !nearlyFull && discarded <= 0.05 && !context.borderPixels && edgeClearance >= 2 && context.stability >= 0.95 && fit.iou >= 0.95 && holeAgreement >= 0.9 && boundary.distance <= Math.max(1, resolution);
  return { id, threshold, epsilon, geometry, rawGeometry: raw, score,
    metrics: { foregroundFraction: context.foregroundPixels / mask.probabilities.length, foregroundPixels: context.foregroundPixels,
      selectedComponentPixels: context.selectedPixels, componentCount: context.componentCount, discardedComponentCount: context.componentCount - 1,
      discardedAreaRatio: discarded, borderContactRatio: borderRatio, borderContactPixels: context.borderPixels, edgeClearancePx: edgeClearance, thresholdStability: context.stability,
      regionFidelityIoU: fit.iou, fidelitySampleCount: fit.samples, fidelitySampleStride: fit.stride,
      boundaryDeviationMm: boundary.distance, boundarySamplingUsed: boundary.sampled, rawAreaMm2: rawArea, simplifiedAreaMm2: area,
      areaRetentionRatio: area / rawArea, rawHoleCount: raw.holes.length, simplifiedHoleCount: geometry.holes.length,
      minimumHoleAreaAgreement: holeAgreement, rawVertexCount: countVertices(raw), simplifiedVertexCount: countVertices(geometry),
      observedHoleCountMin: raw.holes.length, observedHoleCountMax: raw.holes.length,
      observedComponentCountMin: context.componentCount, observedComponentCountMax: context.componentCount,
      topologyVariesAcrossThresholds: false, regionVariesAcrossThresholds: false },
    warnings, grade: safe ? 'usable' : 'ambiguous', safeToAutoApply: safe };
}

const TOPOLOGY_WARNING = 'Traced hole/component topology changes across searched thresholds. More holes are not automatically more correct; review the photograph and all relevant candidates.';
const REGION_WARNING = 'Selected foreground area changes by more than 25% across searched thresholds. A stable small hotspot or bloated background can still be wrong.';
function updateCrossThresholdWarnings(candidates: Candidate[], observations: TraceObservation[]): void {
  if (!candidates.length) return;
  const holeMin = Math.min(...observations.map(o => o.holeCount)), holeMax = Math.max(...observations.map(o => o.holeCount));
  const componentMin = Math.min(...observations.map(o => o.componentCount)), componentMax = Math.max(...observations.map(o => o.componentCount));
  const areaMin = Math.min(...observations.map(o => o.selectedPixels)), areaMax = Math.max(...observations.map(o => o.selectedPixels));
  const topology = holeMin !== holeMax || componentMin !== componentMax, region = areaMin / areaMax < 0.75;
  for (const candidate of candidates) {
    Object.assign(candidate.metrics, { observedHoleCountMin: holeMin, observedHoleCountMax: holeMax, observedComponentCountMin: componentMin, observedComponentCountMax: componentMax, topologyVariesAcrossThresholds: topology, regionVariesAcrossThresholds: region });
    if (topology && !candidate.warnings.includes(TOPOLOGY_WARNING)) candidate.warnings.push(TOPOLOGY_WARNING);
    if (region && !candidate.warnings.includes(REGION_WARNING)) candidate.warnings.push(REGION_WARNING);
    if (topology || region) { candidate.grade = 'ambiguous'; candidate.safeToAutoApply = false; }
  }
}

/** No network, pixels from photographs, ground truth, prompts, keys, model or scale changes. */
export async function searchMaskCandidates(mask: MaskResult, board: Board, options: SearchOptions = {}): Promise<SearchResult> {
  const start = now(), candidates: Candidate[] = [], attempts: SearchAttempt[] = [], universalWarnings = [...AUTO_TUNE_WARNINGS];
  const observations: TraceObservation[] = [];
  const result = (stoppedReason: SearchStoppedReason): SearchResult => ({ candidates, attempts, best: candidates[0], elapsedMs: now() - start, stoppedReason, universalWarnings });
  if (options.signal?.aborted) return result('cancelled');
  const invalid = validateInput(mask, board);
  if (invalid) { universalWarnings.push(invalid); return result('invalid_input'); }
  const requestedThreshold = options.currentThreshold ?? 0.5, requestedEpsilon = options.currentEpsilon ?? 1;
  const currentThreshold = round(clamp(Number.isFinite(requestedThreshold) ? requestedThreshold : 0.5, 0.1, 0.9));
  const currentEpsilon = round(clamp(Number.isFinite(requestedEpsilon) ? requestedEpsilon : 1, 0.5, 10));
  if (currentThreshold !== requestedThreshold || currentEpsilon !== requestedEpsilon) universalWarnings.push('Current settings were outside supported bounds or non-finite; bounded search settings were used instead.');
  const maxCandidates = clamp(Number.isFinite(options.maxCandidates) ? Math.floor(options.maxCandidates!) : 80, 1, 80);
  const maxElapsedMs = clamp(Number.isFinite(options.maxElapsedMs) ? options.maxElapsedMs! : AUTO_TUNE_LIMITS.defaultElapsedMs, 0, AUTO_TUNE_LIMITS.maximumElapsedMs);
  const epsilons = [...new Set([currentEpsilon, Math.max(0.5, round(currentEpsilon / 2)), Math.max(0.5, round(currentEpsilon / 4)), 0.5])];
  const coarse = [...new Set([currentThreshold, ...Array.from({ length: 9 }, (_, i) => round((i + 1) / 10))])];
  const guided = [...new Set((options.candidateThresholds ?? []).filter(v => Number.isFinite(v) && v >= 0.1 && v <= 0.9).map(round))].filter(v => !coarse.includes(v)).slice(0, AUTO_TUNE_LIMITS.maximumGuidedThresholds);
  if ((options.candidateThresholds?.length ?? 0) > guided.length) universalWarnings.push('Duplicate, out-of-range, or excess suggested thresholds were ignored; the fixed search bounds and attempt cap still apply.');
  const visitedThresholds = new Set<number>();
  let stopped: SearchStoppedReason | undefined;
  const compare = (a: Candidate, b: Candidate) => b.score - a.score || Math.abs(a.threshold - currentThreshold) - Math.abs(b.threshold - currentThreshold) || a.epsilon - b.epsilon || a.threshold - b.threshold;
  const shouldStop = (): boolean => {
    if (options.signal?.aborted) stopped = 'cancelled';
    else if (attempts.length >= maxCandidates) stopped = 'candidate_limit';
    else if (now() - start >= maxElapsedMs) stopped = 'time_limit';
    return stopped !== undefined;
  };
  const examine = async (thresholds: number[], stage: SearchStage): Promise<void> => {
    for (const threshold of thresholds) {
      if (visitedThresholds.has(threshold)) continue;
      visitedThresholds.add(threshold);
      let context: ThresholdContext | undefined, invalidReason: string | undefined;
      for (const epsilon of epsilons) {
        await yieldToUI();
        if (shouldStop()) return;
        const id = `t${threshold.toFixed(3)}-e${epsilon.toFixed(3)}`;
        let candidate: Candidate | undefined;
        if (!context && !invalidReason) try { context = thresholdContext(mask, board, threshold, observation => { observations.push(observation); updateCrossThresholdWarnings(candidates, observations); }); } catch (error) { invalidReason = diagnosticError(error); }
        const attempt: SearchAttempt = { id, threshold, epsilon, stage, valid: false };
        try {
          if (!context) throw Error(invalidReason);
          candidate = evaluate(context, mask, board, threshold, epsilon, id);
          candidates.push(candidate); candidates.sort(compare); updateCrossThresholdWarnings(candidates, observations);
          attempt.valid = true; attempt.score = candidate.score;
        } catch (error) { attempt.invalidReason = diagnosticError(error); }
        attempts.push(attempt);
        options.onProgress?.({ attempts: attempts.length, validCandidates: candidates.length, maxCandidates, elapsedMs: now() - start, stage, attempt, candidate, best: candidates[0] });
        // A threshold-level error cannot be fixed by epsilon. Record it once and continue recovery.
        if (invalidReason) break;
      }
      if (shouldStop()) return;
    }
  };
  await examine(coarse, 'coarse');
  if (!stopped) await examine(guided, 'guided');
  if (!stopped && candidates[0]) {
    const center = candidates[0].threshold;
    const fine = [-0.02, 0.02, -0.04, 0.04, -0.06, 0.06].map(delta => round(center + delta)).filter(t => t >= 0.1 && t <= 0.9);
    await examine(fine, 'fine');
  } else if (!stopped) {
    // Recover a narrow valid band between coarse full/empty (or differently invalid) masks.
    const failures = attempts.filter(a => a.stage === 'coarse').sort((a, b) => a.threshold - b.threshold);
    const midpoints = failures.slice(1).flatMap((attempt, i) => attempt.invalidReason !== failures[i].invalidReason ? [round((attempt.threshold + failures[i].threshold) / 2)] : []);
    await examine(midpoints, 'fine');
  }
  if (options.signal?.aborted) stopped = 'cancelled';
  if (!candidates.length) universalWarnings.push('No valid candidate was found within threshold 0.1–0.9 and the tested epsilon settings. A useful threshold may lie outside this range, or segmentation/calibration may need review.');
  if (stopped === 'time_limit') universalWarnings.push('Search reached its time budget between candidates. The retained best is only the best of completed attempts.');
  return result(stopped ?? (candidates.length ? 'completed' : 'no_valid_candidate'));
}

/** Explicit image/key-free export for review or an opt-in advisor; never includes mask arrays or geometry. */
export function candidateSearchDiagnostics(result: SearchResult) {
  return { schemaVersion: '1.0', scoring: 'heuristic_not_accuracy', stoppedReason: result.stoppedReason,
    elapsedMs: result.elapsedMs, universalWarnings: [...result.universalWarnings], bestId: result.best?.id ?? null,
    attempts: result.attempts.map(attempt => ({ ...attempt })),
    candidates: result.candidates.map(({ id, threshold, epsilon, score, metrics, warnings, grade, safeToAutoApply }) =>
      ({ id, threshold, epsilon, score, metrics: { ...metrics }, warnings: [...warnings], grade, safeToAutoApply })) };
}
