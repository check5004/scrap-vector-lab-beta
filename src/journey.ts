import './journey.css';
import { cloneGeometry, type Geometry, type Point } from './geometry';
import type { Board, MarkerDetectionReport, MaskResult, homographyDetails } from './vision';
import { clamp01, conditionedPlaneMatrix, CSS_PLANE_EXTENT, dimensionEdges, fitPoints, interpolateQuad, interpolateView, interpolateCamera, orientCropCamera, lerp, matrix3d, projectPoint, rectangleQuad, rectangleToQuad, smoothStep, transformPoint, type DimensionEdge, type Quad, type ViewTransform } from './journey-math';

export type JourneyStage = 'source' | 'markers' | 'crop' | 'rectify' | 'mask' | 'contour' | 'dimensions';
export type JourneyProcessing = 'idle' | 'running' | 'complete' | 'error' | 'cancelled';
export interface JourneyOptions {
  autoplay?: boolean;
  runAll?: () => void | Promise<void>;
  onEdit?: () => void;
  onCancel?: () => void;
}
export type JourneyHomography = ReturnType<typeof homographyDetails>;
const STAGES: JourneyStage[] = ['source', 'markers', 'crop', 'rectify', 'mask', 'contour', 'dimensions'];
const TITLES = ['撮影した写真', '4つの基準を見つける', '基準点の内側を切り出す', '同じ面を、真上から', 'AIが見つけた前景', '画素から輪郭へ', 'かたちを寸法に'];
const SHORT = ['写真', 'マーカー', '切り出し', '平面補正', 'AIマスク', '輪郭', '寸法'];
const DESCRIPTIONS = [
  'この写真の中で、測定する面をたどります。',
  '検出したマーカーの位置を、写真に重ねています。',
  'ID 0〜3の規定の内側角が、測定範囲の4点です。',
  '4点の射影変換で、同じ領域を基準寸法の平面に補正します。',
  '実際のU²-NetP出力を重ねています。穴や細部の見落としを確認してください。',
  'マスクをなぞった輪郭です。外周と検出された穴を保持します。',
  '直線化した輪郭の各辺を、基準スケールからミリに換算しています。',
];
const HOLD = [800, 600, 450, 550, 750, 650, 0];
const DURATION = [0, 1150, 1500, 1950, 1300, 1250, 1600];
const NS = 'http://www.w3.org/2000/svg';
function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}
function copyCanvas(target: HTMLCanvasElement, source: HTMLCanvasElement) {
  target.width = source.width; target.height = source.height;
  const context = target.getContext('2d');
  if (!context) throw Error('Canvas rendering is unavailable.');
  context.drawImage(source, 0, 0);
}
const quadPoints = (points: Point[]) => points.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');
function ringPath(ring: Point[], project: (point: Point) => Point): string {
  return ring.map((point, i) => { const p = project(point); return `${i ? 'L' : 'M'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`; }).join(' ') + ' Z';
}
function geometryPath(geometry: Geometry, project: (point: Point) => Point): string {
  return [geometry.outer, ...geometry.holes].map(ring => ringPath(ring, project)).join(' ');
}
interface MarkerNode { corners: Point[]; polygon: SVGPolygonElement; label: SVGTextElement; index: number }
interface EdgeNode { edge: DimensionEdge; line: SVGLineElement; group: SVGGElement; box: SVGRectElement; text: SVGTextElement; title: SVGTitleElement }
interface Transition { from: number; to: number; start: number; duration: number }

/**
 * Presentation-only consumer of actual pipeline artifacts. Never starts inference,
 * reads ground truth, estimates processing progress, or changes timing metrics.
 * The returned run token lets callers reject async results from an older source.
 */
export class MeasurementJourney {
  private host: HTMLElement;
  private options: JourneyOptions;
  private viewport: HTMLDivElement;
  private sourceCanvas: HTMLCanvasElement;
  private flatCanvas: HTMLCanvasElement;
  private maskCanvas: HTMLCanvasElement;
  private plane: HTMLDivElement;
  private overlay: SVGSVGElement;
  private markerGroup: SVGGElement;
  private shade: SVGPathElement;
  private reference: SVGPolygonElement;
  private rawPath: SVGPathElement;
  private simplifiedPath: SVGPathElement;
  private vertexGroup: SVGGElement;
  private dimensionGroup: SVGGElement;
  private stageTitle: HTMLElement;
  private stageDescription: HTMLElement;
  private detail: HTMLElement;
  private processText: HTMLElement;
  private playbackText: HTMLElement;
  private steps: HTMLElement;
  private playButton: HTMLButtonElement;
  private runButton: HTMLButtonElement;
  private editButton: HTMLButtonElement;
  private cancelButton: HTMLButtonElement;
  private replayButton: HTMLButtonElement;
  private skipButton: HTMLButtonElement;
  private empty: HTMLElement;
  private resize: ResizeObserver;
  private media = window.matchMedia('(prefers-reduced-motion: reduce)');
  private board?: Board;
  private markerReport?: MarkerDetectionReport;
  private homography?: JourneyHomography;
  private mask?: MaskResult;
  private rawGeometry?: Geometry;
  private geometry?: Geometry;
  private threshold = 0.5;
  private markers: MarkerNode[] = [];
  private edges: EdgeNode[] = [];
  private vertices: { point: Point; element: SVGCircleElement }[] = [];
  private token = 0;
  private epoch = 0;
  private frame = 0;
  private position = 0;
  private target = 0;
  private transition?: Transition;
  private holdUntil = 0;
  private playing = false;
  private followingLatest = false;
  private busy = false;
  private processing: JourneyProcessing = 'idle';
  private processingMessage = '写真を選んでください';
  private hasSource = false;
  private hasFlat = false;
  private fallback = false;
  private destroyed = false;
  private editing = false;
  private analysisLocked = false;
  private supportsProjective = typeof CSS !== 'undefined' && CSS.supports('transform', 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)');
  private editMessage = '';
  private reduced = this.media.matches;
  private stageButtons = new Map<number, HTMLButtonElement>();
  private resizeScheduled = false;
  private onMediaChange = () => {
    this.reduced = this.media.matches;
    this.stopAnimation();
    this.playing = false;
    // A changed preference must not silently resume motion.
    this.position = this.target = this.closestAvailable(this.position);
    this.renderSafely(); this.syncUI();
  };

  constructor(host: HTMLElement, options: JourneyOptions = {}) {
    this.host = host; this.options = options;
    host.classList.add('measurement-journey');
    host.innerHTML = `<div class="journey-heading"><div><p class="journey-eyebrow">PHOTO → PLANE → MEASURE</p><h2>写真が、寸法になるまで。</h2></div><div class="journey-actions"><button type="button" id="journeyRun" class="primary">写真から寸法まで <span aria-hidden="true">↗</span></button><button type="button" id="journeyEdit">編集・比較</button></div></div><div class="journey-scene" role="img" aria-label="実際の写真と処理結果を連続して表示する計測ビュー"><canvas id="journeySource" class="journey-source"></canvas><div id="journeyPlane" class="journey-plane"><canvas id="journeyRectified"></canvas><canvas id="journeyMask"></canvas></div><svg id="journeyOverlay" class="journey-overlay" aria-hidden="true"></svg><div class="journey-empty">写真を選ぶと、計測の流れをここで確認できます。</div><div class="journey-scene-meta"><span class="journey-scene-index">01 / PHOTO</span><span class="journey-scene-detail"></span></div></div><div class="journey-caption"><div><h3 class="journey-stage-title"></h3><p class="journey-stage-description"></p></div><span class="journey-playback" aria-live="off"></span></div><nav class="journey-steps" aria-label="取得済みの処理段階"></nav><div class="journey-bottom"><div class="journey-controls" aria-label="表示の操作"><button type="button" id="journeyPlay">再生</button><button type="button" id="journeyReplay">最初から</button><button type="button" id="journeySkip">最新の結果へ <span aria-hidden="true">↗</span></button></div><p class="journey-motion-note">表示の停止・省略中も、画像処理は続きます。</p></div><div class="journey-process" role="status" aria-live="polite"><span class="journey-process-label">処理</span><span class="journey-process-text"></span><button type="button" id="journeyCancel" hidden>処理を中止</button></div>`;
    const get = <T extends Element>(selector: string) => host.querySelector<T>(selector)!;
    this.viewport = get('.journey-scene'); this.sourceCanvas = get('#journeySource'); this.flatCanvas = get('#journeyRectified'); this.maskCanvas = get('#journeyMask'); this.plane = get('#journeyPlane'); this.overlay = get('#journeyOverlay');
    this.stageTitle = get('.journey-stage-title'); this.stageDescription = get('.journey-stage-description'); this.detail = get('.journey-scene-detail'); this.processText = get('.journey-process-text'); this.playbackText = get('.journey-playback'); this.steps = get('.journey-steps'); this.empty = get('.journey-empty');
    this.playButton = get('#journeyPlay'); this.runButton = get('#journeyRun'); this.editButton = get('#journeyEdit'); this.cancelButton = get('#journeyCancel'); this.replayButton = get('#journeyReplay'); this.skipButton = get('#journeySkip');
    this.shade = svgElement('path', { class: 'journey-shade', 'fill-rule': 'evenodd' });
    this.reference = svgElement('polygon', { class: 'journey-reference', 'data-reference-quad': 'true' });
    this.markerGroup = svgElement('g', { class: 'journey-markers' });
    this.rawPath = svgElement('path', { class: 'journey-raw', 'data-contour': 'raw', 'fill-rule': 'evenodd' });
    this.simplifiedPath = svgElement('path', { class: 'journey-simplified', 'data-contour': 'simplified', 'fill-rule': 'evenodd' });
    this.vertexGroup = svgElement('g', { class: 'journey-vertices' }); this.dimensionGroup = svgElement('g', { class: 'journey-dimensions' });
    this.overlay.append(this.shade, this.reference, this.markerGroup, this.rawPath, this.simplifiedPath, this.vertexGroup, this.dimensionGroup);
    this.playButton.onclick = () => this.reduced ? this.nextStatic() : this.playing ? this.pause() : this.play();
    this.replayButton.onclick = () => this.replay(); this.skipButton.onclick = () => this.skip();
    this.runButton.onclick = () => { if (!this.busy && this.hasSource) void Promise.resolve(this.options.runAll?.()).catch(error => this.fail(error instanceof Error ? error.message : '画像処理を開始できませんでした。')); };
    this.editButton.onclick = () => { this.stopForEdit(); this.options.onEdit?.(); };
    this.cancelButton.onclick = () => this.options.onCancel?.();
    this.media.addEventListener('change', this.onMediaChange);
    this.resize = new ResizeObserver(() => {
      if (this.resizeScheduled || this.destroyed) return;
      this.resizeScheduled = true;
      queueMicrotask(() => { this.resizeScheduled = false; if (!this.destroyed) this.renderSafely(); });
    });
    this.resize.observe(this.viewport);
    this.reset();
  }

  get runId(): number { return this.token; }
  get availableStages(): JourneyStage[] { return this.available().map(index => STAGES[index]); }

  begin(source: HTMLCanvasElement, board: Board): number {
    this.reset();
    this.board = { ...board };
    try {
      copyCanvas(this.sourceCanvas, source);
      this.hasSource = source.width > 0 && source.height > 0;
      this.sourceCanvas.dataset.sourceSize = JSON.stringify([source.width, source.height]);
      this.processingMessage = '写真を読み込みました';
      this.playing = this.options.autoplay !== false && !this.reduced;
      this.followingLatest = this.reduced;
      this.holdUntil = performance.now() + HOLD[0];
      this.changed();
    } catch { this.fail('写真の表示を準備できませんでした。'); }
    return this.token;
  }

  reset(): void {
    this.stopAnimation(); this.token++;
    this.hasSource = this.hasFlat = false; this.board = undefined; this.markerReport = undefined; this.homography = undefined;
    this.mask = undefined; this.rawGeometry = undefined; this.geometry = undefined;
    this.position = this.target = 0; this.playing = false; this.followingLatest = false; this.fallback = !this.supportsProjective; this.editing = false; this.analysisLocked = false; this.editMessage = '';
    this.processing = 'idle'; this.processingMessage = '写真を選んでください';
    this.markers = []; this.edges = []; this.vertices = [];
    this.markerGroup.replaceChildren(); this.dimensionGroup.replaceChildren(); this.vertexGroup.replaceChildren();
    this.rawPath.removeAttribute('data-geometry-mm'); this.simplifiedPath.removeAttribute('data-geometry-mm');
    this.reference.removeAttribute('data-source-corners'); this.reference.setAttribute('points', '');
    this.rawPath.setAttribute('d', ''); this.simplifiedPath.setAttribute('d', '');
    for (const key of ['data-homography', 'data-transform', 'data-corners', 'data-css-transform', 'data-css-size']) this.plane.removeAttribute(key);
    this.sourceCanvas.removeAttribute('data-source-size'); this.sourceCanvas.removeAttribute('data-camera');
    this.flatCanvas.removeAttribute('data-output-size');
    this.maskCanvas.removeAttribute('data-mask-size'); this.maskCanvas.removeAttribute('data-threshold');
    for (const canvas of [this.sourceCanvas, this.flatCanvas, this.maskCanvas]) { canvas.width = 1; canvas.height = 1; }
    this.changed();
  }

  setMarkers(report: MarkerDetectionReport, token = this.token): void {
    if (!this.accept(token)) return;
    this.markerReport = report;
    this.markerGroup.replaceChildren();
    this.markers = report.markers.map((marker, index) => {
      const corners = marker.corners.map(p => ({ ...p }));
      const polygon = svgElement('polygon', { 'data-marker-id': String(marker.id), 'data-source-corners': JSON.stringify(corners) });
      const label = svgElement('text', { 'data-marker-label': String(marker.id) }); label.textContent = `ID ${marker.id}`;
      this.markerGroup.append(polygon, label); return { corners, polygon, label, index };
    });
    this.changed();
  }

  setRectified(flat: HTMLCanvasElement, details: JourneyHomography, token = this.token): void {
    if (!this.accept(token)) return;
    try {
      copyCanvas(this.flatCanvas, flat); this.hasFlat = true;
      this.homography = { ...details, source_points_px: details.source_points_px.map(p => ({ ...p })), source_to_rectified_h: [...details.source_to_rectified_h], rectified_to_source_h: [...details.rectified_to_source_h] };
      rectangleToQuad(flat.width, flat.height, this.homography.source_points_px as Quad);
      this.reference.dataset.sourceCorners = JSON.stringify(this.homography.source_points_px);
      this.plane.dataset.homography = JSON.stringify(this.homography.source_to_rectified_h);
      this.plane.style.width = `${CSS_PLANE_EXTENT}px`; this.plane.style.height = `${CSS_PLANE_EXTENT}px`;
      this.plane.dataset.cssSize = JSON.stringify([CSS_PLANE_EXTENT, CSS_PLANE_EXTENT]);
      // Keep native-sized canvas layers during the perspective animation. Painting
      // the pixels into a 100px CSS bitmap would blur fine texture before the
      // browser re-rasterizes at the settled scale. The inner affine transform
      // only changes coordinates; the outer map still owns the projective warp.
      for (const canvas of [this.flatCanvas, this.maskCanvas]) {
        canvas.style.width = `${flat.width}px`; canvas.style.height = `${flat.height}px`;
        canvas.style.transform = `scale(${CSS_PLANE_EXTENT / flat.width},${CSS_PLANE_EXTENT / flat.height})`;
      }
      this.flatCanvas.dataset.outputSize = JSON.stringify([flat.width, flat.height]);
      this.changed();
    } catch { this.fallback = true; this.changed(); }
  }

  setMask(mask: MaskResult, threshold = 0.5, token = this.token): void {
    if (!this.accept(token) || this.analysisLocked) return;
    // Thresholded pixels are exactly the real model probabilities, not an illustrative silhouette.
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1 || mask.width * mask.height !== mask.probabilities.length) { this.fail('AIマスクの表示データが不正です。', token); return; }
    try {
      this.mask = mask; this.threshold = threshold;
      this.maskCanvas.width = mask.width; this.maskCanvas.height = mask.height;
      const context = this.maskCanvas.getContext('2d'); if (!context) throw Error();
      const pixels = context.createImageData(mask.width, mask.height);
      for (let i = 0; i < mask.probabilities.length; i++) {
        const p = mask.probabilities[i];
        if (Number.isFinite(p) && p >= threshold) { pixels.data[i * 4] = 132; pixels.data[i * 4 + 1] = 235; pixels.data[i * 4 + 2] = 159; pixels.data[i * 4 + 3] = 190; }
      }
      context.putImageData(pixels, 0, 0);
      this.maskCanvas.dataset.threshold = String(threshold); this.maskCanvas.dataset.maskSize = JSON.stringify([mask.width, mask.height]);
      this.changed();
    } catch { this.mask = undefined; this.fallback = true; this.changed(); }
  }

  setGeometry(rawGeometry: Geometry, geometry: Geometry, token = this.token): void {
    if (!this.accept(token) || this.analysisLocked) return;
    const replacement = !!this.geometry;
    const finite = (g: Geometry) => g.outer.length >= 3 && [g.outer, ...g.holes].every(ring => ring.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    if (!finite(rawGeometry) || !finite(geometry)) { this.clearAnalysis(token); this.fail('輪郭の表示データが不正です。', token); return; }
    if (replacement) this.stopAnimation();
    this.rawGeometry = cloneGeometry(rawGeometry); this.geometry = cloneGeometry(geometry);
    this.rawPath.dataset.geometryMm = JSON.stringify(this.rawGeometry); this.simplifiedPath.dataset.geometryMm = JSON.stringify(this.geometry);
    this.buildGeometryNodes();
    if (replacement) { this.playing = false; this.followingLatest = false; this.position = this.target = 6; }
    this.changed();
  }

  clearAnalysis(token = this.token): void {
    if (!this.accept(token)) return;
    const showRevision = !this.playing && (this.position >= 4 || !!this.geometry);
    this.stopAnimation(); this.mask = undefined; this.rawGeometry = undefined; this.geometry = undefined;
    this.followingLatest = showRevision;
    if (this.processing === 'error' || this.processing === 'cancelled') { this.processing = 'idle'; this.processingMessage = '取得済みの平面補正から再開できます'; }
    this.maskCanvas.width = this.maskCanvas.height = 1;
    this.maskCanvas.removeAttribute('data-mask-size'); this.maskCanvas.removeAttribute('data-threshold');
    this.rawPath.removeAttribute('data-geometry-mm'); this.simplifiedPath.removeAttribute('data-geometry-mm');
    this.dimensionGroup.replaceChildren(); this.vertexGroup.replaceChildren(); this.edges = []; this.vertices = [];
    this.position = Math.min(this.position, this.hasFlat ? 3 : this.markerReport ? 1 : 0);
    this.target = this.available().find(index => index >= this.position) ?? this.available().at(-1) ?? 0;
    this.editing = false; this.analysisLocked = false; this.changed();
  }

  setProcessing(message: string, state: JourneyProcessing = 'running', token = this.token): void {
    if (this.destroyed || token !== this.token) return;
    this.processingMessage = message; this.processing = state;
    if (state === 'error' || state === 'cancelled') { this.stopAnimation(); this.playing = false; }
    this.syncUI(); this.schedule();
  }
  setBusy(busy: boolean): void { this.busy = busy; this.syncUI(); }
  fail(message: string, token = this.token): void {
    if (this.destroyed || token !== this.token) return;
    this.clearAnalysis(token); this.stopAnimation(); this.playing = false; this.followingLatest = false; this.analysisLocked = true;
    this.position = this.target = this.available().at(-1) ?? 0;
    this.setProcessing(message, 'error', token); this.renderSafely();
  }
  cancel(message = '画像処理を中止しました。取得済みの平面補正までを確認できます。'): void {
    this.clearAnalysis();
    this.stopAnimation(); this.token++; this.analysisLocked = true; this.playing = false; this.followingLatest = false; this.busy = false;
    this.position = this.target = this.available().at(-1) ?? 0;
    this.processing = 'cancelled'; this.processingMessage = message; this.changed();
  }
  stopForEdit(message = '編集・比較を表示中'): void {
    const processing = this.processing, processingMessage = this.processingMessage;
    this.clearAnalysis();
    this.processing = processing; this.processingMessage = processingMessage;
    this.stopAnimation(); this.playing = false; this.followingLatest = false; this.editing = true; this.analysisLocked = true; this.editMessage = message;
    this.position = this.target = this.available().at(-1) ?? 0; this.changed();
  }
  pause(): void { this.stopAnimation(); this.playing = false; this.followingLatest = false; this.editing = false; this.syncUI(); }
  play(): void {
    if (!this.hasSource || this.destroyed) return;
    if (this.reduced) { this.nextStatic(); return; }
    this.editing = false; this.followingLatest = false;
    if (this.fallback) { this.skip(); return; }
    this.playing = true; this.holdUntil = performance.now(); this.syncUI(); this.schedule();
  }
  replay(): void {
    if (!this.hasSource) return;
    this.stopAnimation(); this.position = this.target = 0; this.editing = false; this.followingLatest = false;
    this.playing = !this.reduced && !this.fallback; this.holdUntil = performance.now() + HOLD[0]; this.changed();
  }
  skip(): void {
    this.stopAnimation(); this.playing = false; this.followingLatest = true; this.editing = false;
    this.position = this.target = this.available().at(-1) ?? 0; this.changed();
  }
  inspect(stage: JourneyStage): void {
    const index = STAGES.indexOf(stage); if (!this.available().includes(index)) return;
    this.stopAnimation(); this.playing = false; this.followingLatest = false; this.editing = false;
    this.position = this.target = index; this.changed();
  }
  destroy(): void {
    this.stopAnimation(); this.destroyed = true; this.resize.disconnect(); this.media.removeEventListener('change', this.onMediaChange);
    this.host.replaceChildren();
  }

  private accept(token: number) { return !this.destroyed && this.hasSource && token === this.token; }
  private available(): number[] {
    if (!this.hasSource) return [];
    const stages = [0];
    if (this.markerReport) stages.push(1);
    if (this.hasFlat && this.homography) stages.push(2, 3);
    if (this.hasFlat && this.mask) stages.push(4);
    if (this.hasFlat && this.rawGeometry) stages.push(5);
    if (this.hasFlat && this.geometry) stages.push(6);
    return stages;
  }
  private closestAvailable(value: number): number { return this.available().filter(i => i <= value).at(-1) ?? 0; }
  private nextStatic(): void {
    const next = this.available().find(i => i > this.position);
    if (next !== undefined) this.inspect(STAGES[next]);
  }
  private stopAnimation(): void {
    this.epoch++; if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.transition = undefined;
  }
  private changed(): void {
    if (this.destroyed) return;
    if (this.followingLatest) this.position = this.target = this.available().at(-1) ?? 0;
    this.renderSafely(); this.syncUI(); this.schedule();
  }
  private schedule(): void {
    if (!this.playing || this.reduced || this.fallback || this.destroyed || this.frame || !this.hasSource) return;
    if (!this.transition && !this.available().some(i => i > this.position + 1e-5)) { this.syncUI(); return; }
    const epoch = this.epoch;
    this.frame = requestAnimationFrame(now => { this.frame = 0; if (epoch === this.epoch && !this.destroyed) this.tick(now); });
  }
  private tick(now: number): void {
    if (!this.playing) return;
    if (!this.transition && now >= this.holdUntil) {
      const next = this.available().find(i => i > this.position + 1e-5);
      if (next !== undefined) {
        this.target = next;
        this.transition = { from: this.position, to: next, start: now, duration: DURATION[next] * Math.min(1, next - this.position) };
        this.syncUI();
      }
    }
    if (this.transition) {
      const t = clamp01((now - this.transition.start) / this.transition.duration);
      this.position = lerp(this.transition.from, this.transition.to, smoothStep(t));
      if (t === 1) {
        this.position = this.transition.to; this.transition = undefined; this.holdUntil = now + HOLD[this.target];
        // A completed explanation is no longer playing: later parameter revisions
        // must show the new geometry statically instead of replaying old transitions.
        if (this.position === 6 && this.geometry) this.playing = false;
        this.syncUI();
      }
      this.renderSafely();
    }
    this.schedule();
  }

  private syncUI(): void {
    const available = this.available(), stage = this.hasSource ? this.target : 0;
    const complete = this.position >= 6 && !!this.geometry;
    const waiting = this.playing && !this.transition && !available.some(index => index > this.position + 1e-5);
    const playback = !this.hasSource ? 'empty' : this.fallback ? 'fallback' : this.editing ? 'editing' : this.reduced ? 'reduced-motion' : complete ? 'complete' : this.playing ? waiting ? 'waiting' : 'playing' : 'paused';
    Object.assign(this.host.dataset, { stage: STAGES[stage], playback, processing: this.processing, runId: String(this.token), position: String(this.position), reducedMotion: String(this.reduced), availableStages: available.map(i => STAGES[i]).join(','), followingLatest: String(this.followingLatest) });
    this.stageTitle.textContent = TITLES[stage]; this.stageDescription.textContent = DESCRIPTIONS[stage];
    if (stage === 1 && this.markerReport) {
      const report = this.markerReport;
      this.stageDescription.textContent = report.missingIds.length || report.duplicateIds.length ? `実際の検出結果を表示しています。${report.missingIds.length ? `未検出: ID ${report.missingIds.join('・')}。` : ''}${report.duplicateIds.length ? `重複: ID ${report.duplicateIds.join('・')}。` : ''}` : DESCRIPTIONS[1];
    }
    this.viewport.setAttribute('aria-label', `${TITLES[stage]}。${this.stageDescription.textContent}`);
    this.host.querySelector('.journey-scene-index')!.textContent = `${String(stage + 1).padStart(2, '0')} / ${STAGES[stage].toUpperCase()}`;
    this.playbackText.textContent = this.fallback ? '静止表示 · 変形表示を利用できません' : this.editing ? this.editMessage : this.reduced ? '動きを抑えて表示 · 段階を選んで確認' : complete ? '表示完了' : this.playing ? waiting ? '次の処理結果を待っています' : '表示を再生中' : this.followingLatest ? '最新の結果を静止表示' : '表示を一時停止';
    this.processText.textContent = this.processingMessage;
    this.playButton.textContent = this.reduced ? '次の段階' : this.playing && !complete ? '一時停止' : '再生';
    this.playButton.setAttribute('aria-label', this.reduced ? '次の取得済みの段階を表示' : this.playing && !complete ? '表示を一時停止' : '表示を再生');
    this.playButton.disabled = !this.hasSource || this.fallback || (this.reduced || complete) && !available.some(i => i > this.position);
    this.replayButton.disabled = !this.hasSource;
    this.skipButton.disabled = !this.hasSource;
    this.runButton.disabled = !this.hasSource || this.busy || !this.options.runAll;
    this.editButton.disabled = !this.hasSource || !this.options.onEdit;
    this.cancelButton.hidden = !this.busy || !this.options.onCancel;
    this.host.querySelector('.journey-motion-note')!.textContent = this.reduced ? '自動のズーム・変形は行いません。段階を選ぶと静止表示します。' : '表示の停止・省略中も、画像処理は続きます。';
    for (const [index, button] of this.stageButtons) if (!available.includes(index)) { button.remove(); this.stageButtons.delete(index); }
    for (const index of available) {
      let button = this.stageButtons.get(index);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.dataset.journeyStep = STAGES[index]; button.textContent = SHORT[index];
        button.onclick = () => this.inspect(STAGES[index]); this.stageButtons.set(index, button);
      }
      button.setAttribute('aria-current', index === stage ? 'step' : 'false');
      button.classList.toggle('is-past', index < stage); this.steps.append(button);
    }
  }

  private buildGeometryNodes(): void {
    this.dimensionGroup.replaceChildren(); this.vertexGroup.replaceChildren();
    if (!this.geometry) return;
    this.edges = dimensionEdges(this.geometry.outer, this.geometry.holes).map(edge => {
      const group = svgElement('g', { 'data-edge-id': edge.id });
      const line = svgElement('line'); const box = svgElement('rect', { rx: '5', height: '23' });
      const text = svgElement('text', { 'data-mm': String(edge.lengthMm), 'data-edge-id': edge.id }); text.textContent = `${edge.lengthMm.toFixed(1)} mm`;
      const title = svgElement('title'); title.textContent = `${edge.id}: ${edge.lengthMm} mm`;
      group.append(line, box, text, title); this.dimensionGroup.append(group); return { edge, group, line, box, text, title };
    });
    this.vertices = [this.geometry.outer, ...this.geometry.holes].flatMap(ring => ring.map(point => {
      const element = svgElement('circle', { r: '3.4', 'data-vertex-mm': JSON.stringify(point) }); this.vertexGroup.append(element); return { point, element };
    }));
  }

  private renderSafely(): void {
    if (this.destroyed) return;
    try { this.render(this.fallback); }
    catch {
      this.fallback = true; this.stopAnimation(); this.playing = false;
      try { this.render(true); } catch { this.plane.style.display = 'none'; this.sourceCanvas.style.opacity = '1'; }
      this.syncUI();
    }
  }

  private render(staticFallback: boolean): void {
    const width = this.viewport.clientWidth || 900, height = this.viewport.clientHeight || 510;
    const viewport = { width, height }, padding = Math.min(width < 500 ? 30 : 52, width * 0.1);
    this.host.dataset.position = this.position.toFixed(5);
    this.overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.empty.hidden = this.hasSource; this.sourceCanvas.style.display = this.hasSource ? 'block' : 'none'; this.overlay.style.display = this.hasSource ? 'block' : 'none';
    this.plane.style.display = this.hasFlat && this.position >= 1.999 ? 'block' : 'none';
    if (!this.hasSource || !this.board) return;
    const p = this.position;
    const sourceFit = fitPoints(rectangleQuad(this.sourceCanvas.width, this.sourceCanvas.height), viewport, padding);
    const quad = this.homography?.source_points_px as Quad | undefined;
    const cropFit = quad && !staticFallback ? orientCropCamera(quad, viewport, padding + 10) : sourceFit;
    const view = interpolateCamera(sourceFit, cropFit, clamp01(p - 1), viewport);
    const angle = view.rotation ?? 0, cosine = Math.cos(angle) * view.scale, sine = Math.sin(angle) * view.scale;
    this.sourceCanvas.style.transform = `matrix(${cosine},${sine},${-sine},${cosine},${view.x},${view.y})`;
    this.sourceCanvas.dataset.camera = JSON.stringify(view);
    this.sourceCanvas.style.opacity = String(1 - clamp01(p - 2));
    this.shade.style.opacity = String(clamp01(p - 1) * 0.67 * (1 - clamp01(p - 2)));
    this.shade.setAttribute('d', quad ? `M0 0H${width}V${height}H0Z ${ringPath(quad, point => transformPoint(point, view))}` : '');
    let planeQuad: Quad | undefined, planeMap: ReturnType<typeof rectangleToQuad> | undefined;
    if (quad && this.hasFlat) {
      const fitted = fitPoints(rectangleQuad(this.flatCanvas.width, this.flatCanvas.height), viewport, padding + 15);
      let rectView: ViewTransform = fitted;
      if (this.geometry && p > 5) {
        const pixels = this.geometry.outer.map(point => ({ x: point.x / this.board!.width * this.flatCanvas.width, y: point.y / this.board!.height * this.flatCanvas.height }));
        const focus = fitPoints(pixels, viewport, width < 500 ? 56 : 76);
        const scale = Math.min(focus.scale, fitted.scale * 1.8);
        const centerX = (Math.min(...pixels.map(point => point.x)) + Math.max(...pixels.map(point => point.x))) / 2;
        const centerY = (Math.min(...pixels.map(point => point.y)) + Math.max(...pixels.map(point => point.y))) / 2;
        rectView = interpolateView(fitted, { scale, x: width / 2 - centerX * scale, y: height / 2 - centerY * scale }, clamp01(p - 5));
      }
      const rectQuad = rectangleQuad(this.flatCanvas.width, this.flatCanvas.height).map(point => transformPoint(point, rectView)) as Quad;
      planeQuad = staticFallback ? rectQuad : interpolateQuad(quad.map(point => transformPoint(point, view)) as Quad, rectQuad, clamp01(p - 2));
      planeMap = rectangleToQuad(this.flatCanvas.width, this.flatCanvas.height, planeQuad);
      const cssMap = conditionedPlaneMatrix(planeMap, this.flatCanvas.width, this.flatCanvas.height);
      this.plane.style.transform = staticFallback ? `matrix(${cssMap[0]},${cssMap[3]},${cssMap[1]},${cssMap[4]},${cssMap[2]},${cssMap[5]})` : matrix3d(cssMap);
      this.plane.dataset.cssTransform = JSON.stringify(cssMap);
      this.plane.dataset.transform = JSON.stringify(planeMap); this.plane.dataset.corners = JSON.stringify(planeQuad);
      if (staticFallback && p >= 2) { this.sourceCanvas.style.opacity = '0'; this.shade.style.opacity = '0'; }
      this.reference.setAttribute('points', quadPoints(planeQuad));
      this.reference.style.opacity = String(p < 1 ? 0 : p < 2 ? clamp01(p - 1) : lerp(1, 0.24, clamp01(p - 2)));
    } else { this.reference.style.opacity = '0'; this.plane.removeAttribute('data-transform'); this.plane.removeAttribute('data-corners'); this.plane.removeAttribute('data-css-transform'); }
    const markerOpacity = clamp01(p) * (1 - clamp01(p - 2));
    for (const marker of this.markers) {
      const reveal = clamp01(p * 1.55 - marker.index * 0.14);
      const map = (point: Point) => planeMap && this.homography && p >= 2 && !staticFallback ? projectPoint(planeMap, projectPoint(this.homography.source_to_rectified_h, point)) : transformPoint(point, view);
      const corners = marker.corners.map(map);
      marker.polygon.setAttribute('points', quadPoints(corners));
      marker.polygon.style.opacity = marker.label.style.opacity = String(markerOpacity * reveal);
      const centerX = corners.reduce((sum, point) => sum + point.x, 0) / corners.length;
      const top = Math.min(...corners.map(point => point.y));
      marker.label.setAttribute('x', String(centerX)); marker.label.setAttribute('y', String(Math.max(19, top - 9)));
    }
    this.maskCanvas.style.opacity = String(this.mask ? clamp01(p - 3) * lerp(0.72, 0.18, clamp01(p - 4)) * (1 - clamp01(p - 5)) : 0);
    const geometryMap = (point: Point) => projectPoint(planeMap!, { x: point.x / this.board!.width * this.flatCanvas.width, y: point.y / this.board!.height * this.flatCanvas.height });
    this.rawPath.style.opacity = String(this.rawGeometry && planeMap ? clamp01(p - 4) * lerp(1, 0.15, clamp01(p - 5)) : 0);
    this.simplifiedPath.style.opacity = this.vertexGroup.style.opacity = this.dimensionGroup.style.opacity = String(this.geometry && planeMap ? clamp01(p - 5) : 0);
    if (this.rawGeometry && planeMap && p > 4) this.rawPath.setAttribute('d', geometryPath(this.rawGeometry, geometryMap)); else this.rawPath.setAttribute('d', '');
    if (this.geometry && planeMap && p > 5) {
      this.simplifiedPath.setAttribute('d', geometryPath(this.geometry, geometryMap));
      for (const vertex of this.vertices) { const point = geometryMap(vertex.point); vertex.element.setAttribute('cx', String(point.x)); vertex.element.setAttribute('cy', String(point.y)); }
      this.positionDimensions(geometryMap, viewport);
    } else this.simplifiedPath.setAttribute('d', '');
    this.detail.textContent = p >= 5.999 && this.geometry ? this.detail.dataset.dimensions || '' : p >= 3.999 && this.mask ? `${this.mask.width} × ${this.mask.height} · 閾値 ${this.threshold.toFixed(2)}` : p >= 2.999 ? `${this.board.width} × ${this.board.height} mm 基準` : this.markerReport && p >= 0.999 ? `${this.markerReport.markers.length} マーカー検出` : `${this.sourceCanvas.width} × ${this.sourceCanvas.height} px`;
  }

  private positionDimensions(map: (point: Point) => Point, viewport: { width: number; height: number }): void {
    const occupied: { x: number; y: number; width: number; height: number }[] = [];
    const maximum = viewport.width < 500 ? 7 : 12;
    let shown = 0;
    const center = this.geometry!.outer.reduce((sum, point) => ({ x: sum.x + point.x / this.geometry!.outer.length, y: sum.y + point.y / this.geometry!.outer.length }), { x: 0, y: 0 });
    const screenCenter = map(center);
    for (const node of [...this.edges].sort((a, b) => b.edge.lengthMm - a.edge.lengthMm)) {
      const a = map(node.edge.from), b = map(node.edge.to), middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const length = Math.hypot(b.x - a.x, b.y - a.y), labelWidth = Math.max(62, node.text.textContent!.length * 6.3 + 14);
      let nx = -(b.y - a.y) / (length || 1), ny = (b.x - a.x) / (length || 1);
      if ((middle.x - screenCenter.x) * nx + (middle.y - screenCenter.y) * ny < 0) { nx *= -1; ny *= -1; }
      if (node.edge.hole) { nx *= -1; ny *= -1; }
      const x = Math.max(labelWidth / 2 + 8, Math.min(viewport.width - labelWidth / 2 - 8, middle.x + nx * 29));
      const y = Math.max(19, Math.min(viewport.height - 42, middle.y + ny * 29));
      const box = { x: x - labelWidth / 2, y: y - 12, width: labelWidth, height: 24 };
      const collision = occupied.some(other => box.x < other.x + other.width + 5 && box.x + box.width + 5 > other.x && box.y < other.y + other.height + 4 && box.y + box.height + 4 > other.y);
      const show = shown < maximum && length > 14 && !collision;
      node.group.style.display = show ? '' : 'none';
      if (!show) continue;
      occupied.push(box); shown++;
      for (const [key, value] of Object.entries({ x1: middle.x, y1: middle.y, x2: x, y2: y })) node.line.setAttribute(key, String(value));
      for (const [key, value] of Object.entries({ x: box.x, y: box.y, width: labelWidth })) node.box.setAttribute(key, String(value));
      node.text.setAttribute('x', String(x)); node.text.setAttribute('y', String(y + 4));
    }
    this.detail.dataset.dimensions = shown < this.edges.length ? `${shown} / ${this.edges.length} 辺を表示 · 全辺は計測結果へ` : `${shown} 辺 · mm`;
    this.dimensionGroup.dataset.shownEdges = String(shown); this.dimensionGroup.dataset.totalEdges = String(this.edges.length);
  }
}
