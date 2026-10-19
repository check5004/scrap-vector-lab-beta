import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import type { Geometry } from '../src/geometry.ts';
import type { Board, MarkerDetectionReport } from '../src/vision.ts';
import type { JourneyHomography } from '../src/journey.ts';
import { projectPoint, transformPoint } from '../src/journey-math.ts';

// Exercise the real presentation controller without loading CSS into Node. The
// DOM below models state, not pixels; browser tests own native rendering checks.
const sourceURL = new URL('../src/journey.ts', import.meta.url);
const source = (await readFile(sourceURL, 'utf8')).replace("import './journey.css';", '')
  .replaceAll("from './curves'", `from '${new URL('../src/curves.ts', import.meta.url)}'`)
  .replaceAll("from './geometry'", `from '${new URL('../src/geometry.ts', import.meta.url)}'`)
  .replaceAll("from './journey-math'", `from '${new URL('../src/journey-math.ts', import.meta.url)}'`);
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { MeasurementJourney } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as typeof import('../src/journey.ts');

class Element {
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: Element[] = [];
  selectors = new Map<string, Element>();
  classList = { add() {}, toggle() {} };
  textContent = '';
  innerHTML = '';
  hidden = false;
  disabled = false;
  width = 1;
  height = 1;
  clientWidth = 900;
  clientHeight = 510;
  parent?: Element;
  onclick?: () => void;
  querySelector(selector: string) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector)!;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name.startsWith('data-')) this.dataset[this.dataKey(name)] = value;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) delete this.dataset[this.dataKey(name)];
  }
  dataKey(name: string) { return name.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase()); }
  append(...children: Element[]) {
    for (const child of children) { child.remove(); child.parent = this; this.children.push(child); }
  }
  replaceChildren(...children: Element[]) { for (const child of this.children) child.parent = undefined; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; }
  getContext() { return { drawImage() {}, putImageData() {}, createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) }; }
}

function fixture(reduced = false, supportsProjective = true) {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const media = { matches: reduced, addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, {
    window: { matchMedia: () => media },
    document: { createElement: () => new Element(), createElementNS: () => new Element() },
    CSS: { supports: () => supportsProjective },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (frame: number) => frames.delete(frame),
  });
  const host = new Element();
  const journey = new MeasurementJourney(host as unknown as HTMLElement);
  const canvas = new Element(); canvas.width = 1200; canvas.height = 800;
  const flat = new Element(); flat.width = 2500; flat.height = 1700;
  const board = { width: 250, height: 170 } as Board;
  const corners = [{ x: 100, y: 100 }, { x: 1100, y: 100 }, { x: 1100, y: 780 }, { x: 100, y: 780 }];
  const details = { source_points_px: corners, source_to_rectified_h: [2.5, 0, -250, 0, 2.5, -250, 0, 0, 1], rectified_to_source_h: [.4, 0, 100, 0, .4, 100, 0, 0, 1] } as JourneyHomography;
  const report = { markers: [{ id: 0, corners }], missingIds: [], duplicateIds: [] } as unknown as MarkerDetectionReport;
  const polygon: Geometry = { outer: [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 100 }, { x: 20, y: 100 }], holes: [[{ x: 40, y: 40 }, { x: 50, y: 40 }, { x: 50, y: 50 }, { x: 40, y: 50 }]] };
  const mask = { width: 2, height: 2, elapsedMs: 0, probabilities: new Float32Array([0, .4, .6, 1]) };
  const begin = (method?: 'A' | 'B') => journey.begin(canvas as unknown as HTMLCanvasElement, board, method);
  const calibrate = (token = journey.runId) => {
    journey.setMarkers(report, token);
    journey.setRectified(flat as unknown as HTMLCanvasElement, details, token);
  };
  return { host, journey, frames, polygon, mask, begin, calibrate };
}

test('legacy B retains the real mask, contours, dimensions, and native canvas sizes', () => {
  const f = fixture(); f.begin(); f.calibrate();
  f.journey.setMask(f.mask); f.journey.setGeometry(f.polygon, f.polygon); f.journey.skip();
  assert.equal(f.journey.selectedMethod, 'B');
  assert.deepEqual(f.journey.availableStages, ['source', 'markers', 'crop', 'rectify', 'mask', 'contour', 'dimensions']);
  assert.equal(f.host.dataset.stage, 'dimensions');
  assert.equal(f.host.querySelector('#journeyMask').dataset.maskSize, '[2,2]');
  assert.equal(f.host.querySelector('#journeyRectified').width, 2500);
  assert.equal(f.host.querySelector('#journeyRectified').style.width, '2500px');
  assert.equal(f.host.querySelector('#journeyPlane').dataset.cssSize, '[100,100]');
  f.journey.destroy();
});

test('A presents the exact returned polygon and dimensions without accepting or inventing a mask', () => {
  const f = fixture(); const token = f.begin('A'); f.calibrate();
  f.journey.setMask(f.mask); f.journey.setGeometry(f.polygon, token);
  assert.deepEqual(f.journey.availableStages, ['source', 'markers', 'crop', 'rectify', 'contour', 'dimensions']);
  assert.equal(f.host.dataset.method, 'A');
  f.journey.inspect('contour');
  assert.equal(f.host.dataset.stage, 'contour');
  assert.match(f.host.querySelector('.journey-stage-description').textContent, /GPT-6 Lunaが実際に返した/);
  assert.doesNotMatch(f.host.querySelector('.journey-stage-description').textContent, /マスク|U²/);
  const overlay = f.host.querySelector('#journeyOverlay');
  const raw = overlay.children.find(node => node.attributes.get('data-contour') === 'raw')!;
  assert.deepEqual(JSON.parse(raw.dataset.geometryMm), f.polygon);
  assert.equal(raw.dataset.geometrySource, 'gpt-6-luna-polygon');
  assert.equal(raw.style.opacity, '1');
  assert.match(raw.attributes.get('d')!, /^M/);
  assert.equal(f.host.querySelector('#journeyMask').hidden, true);
  assert.equal(f.host.querySelector('#journeyMask').style.opacity, '0');
  assert.equal(f.host.querySelector('#journeyMask').dataset.maskSize, undefined);
  f.polygon.outer[0].x = -999;
  assert.equal(JSON.parse(raw.dataset.geometryMm).outer[0].x, 20);
  f.journey.inspect('dimensions');
  assert.equal(f.host.dataset.stage, 'dimensions');
  const dimensions = overlay.children.find(node => node.attributes.get('class') === 'journey-dimensions')!;
  assert.equal(dimensions.children.length, 8);
  assert.deepEqual(dimensions.children.map(node => Number(node.children[2].dataset.mm)), [100, 80, 100, 80, 10, 10, 10, 10]);
  assert.equal(f.host.querySelector('.journey-scene-index').textContent, '06 / DIMENSIONS');
  f.journey.destroy();
});

test('method change preserves calibration, clears old geometry, and rejects stale result tokens', () => {
  const f = fixture(); const old = f.begin(); f.calibrate();
  f.journey.setMask(f.mask); f.journey.setGeometry(f.polygon); f.journey.skip();
  const fresh = f.journey.setMethod('A');
  assert.ok(fresh > old);
  assert.equal(f.journey.setMethod('A'), fresh);
  assert.deepEqual(f.journey.availableStages, ['source', 'markers', 'crop', 'rectify']);
  assert.equal(f.host.querySelector('#journeyMask').dataset.maskSize, undefined);
  assert.equal(f.host.dataset.processing, 'idle');
  f.journey.setGeometry(f.polygon, old); f.journey.setProcessing('stale', 'complete', old);
  assert.deepEqual(f.journey.availableStages, ['source', 'markers', 'crop', 'rectify']);
  assert.notEqual(f.host.querySelector('.journey-process-text').textContent, 'stale');
  f.journey.setGeometry(f.polygon, fresh); f.journey.skip();
  assert.equal(f.host.dataset.stage, 'dimensions');
  f.journey.setMethod('B');
  assert.deepEqual(f.journey.availableStages, ['source', 'markers', 'crop', 'rectify']);
  assert.equal(f.host.querySelector('#journeyMask').hidden, false);
  f.journey.destroy();
});

test('A cancellation and error lock out late polygons; a new run accepts only its own results', () => {
  const f = fixture(); const old = f.begin('A'); f.calibrate();
  f.journey.cancel(); f.journey.setGeometry(f.polygon, old);
  assert.equal(f.host.dataset.processing, 'cancelled');
  assert.deepEqual(f.journey.availableStages, ['source', 'markers', 'crop', 'rectify']);
  const current = f.begin('A'); f.calibrate();
  f.journey.fail('provider failed', current); f.journey.setGeometry(f.polygon, current);
  assert.equal(f.host.dataset.processing, 'error');
  assert.ok(!f.journey.availableStages.includes('contour'));
  f.journey.clearAnalysis(current); f.journey.setGeometry(f.polygon, current);
  assert.ok(f.journey.availableStages.includes('dimensions'));
  f.journey.destroy();
});

test('A reduced motion uses static real stages and jumps straight from rectification to contour', () => {
  const f = fixture(true); f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon);
  assert.equal(f.frames.size, 0);
  assert.equal(f.host.dataset.stage, 'dimensions');
  assert.equal(f.host.dataset.playback, 'reduced-motion');
  f.journey.inspect('rectify'); f.journey.play();
  assert.equal(f.host.dataset.stage, 'contour');
  f.journey.play(); assert.equal(f.host.dataset.stage, 'dimensions');
  f.journey.replay(); assert.equal(f.host.dataset.stage, 'source');
  assert.equal(f.frames.size, 0);
  f.journey.destroy();
});

test('A animation targets only genuine stages and its cancelled animation epoch cannot resume', () => {
  const f = fixture(); f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon);
  const stages = new Set<string>();
  for (let now = 100_000; now < 130_000 && f.frames.size; now += 100) {
    const callbacks = [...f.frames.values()]; f.frames.clear();
    for (const callback of callbacks) callback(now);
    stages.add(f.host.dataset.stage);
  }
  assert.deepEqual([...stages], ['markers', 'crop', 'rectify', 'contour', 'dimensions']);
  assert.equal(f.host.dataset.playback, 'complete');
  f.journey.replay();
  const pending = [...f.frames.values()];
  f.journey.cancel();
  const position = f.host.dataset.position;
  for (const callback of pending) callback(200_000);
  assert.equal(f.host.dataset.position, position);
  assert.equal(f.frames.size, 0);
  assert.equal(f.host.dataset.processing, 'cancelled');
  f.journey.destroy();
});

test('source-only state asks for Analyze, and the redundant start button stays hidden', () => {
  const f = fixture(); f.begin('A');
  assert.equal(f.host.dataset.processing, 'idle');
  assert.match(f.host.querySelector('.journey-process-text').textContent, /解析する/);
  assert.match(f.host.innerHTML, /id="journeyRun" hidden/);
  assert.equal(f.host.querySelector('#journeyEdit').hidden, true);
  assert.match(f.host.querySelector('.journey-method').textContent, /A.*GPT-6 Luna/);
  f.journey.destroy();
});


function dimensions(host: Element) {
  return host.querySelector('#journeyOverlay').children.find(node => node.attributes.get('class') === 'journey-dimensions')!;
}
function geometryPresentation(host: Element) {
  const overlay = host.querySelector('#journeyOverlay');
  return {
    paths: overlay.children.filter(node => node.dataset.contour).map(node => ({ d: node.attributes.get('d'), geometry: node.dataset.geometryMm })),
    vertices: overlay.children.find(node => node.attributes.get('class') === 'journey-vertices')!.children.map(node => [...node.attributes]),
    reference: [...overlay.children.find(node => node.attributes.get('data-reference-quad'))!.attributes],
    photo: { ...host.querySelector('#journeySource').style },
    flat: { ...host.querySelector('#journeyRectified').style },
    plane: { style: { ...host.querySelector('#journeyPlane').style }, data: { ...host.querySelector('#journeyPlane').dataset } },
    sourceSize: [host.querySelector('#journeySource').width, host.querySelector('#journeySource').height],
    flatSize: [host.querySelector('#journeyRectified').width, host.querySelector('#journeyRectified').height],
  };
}
function drainAnimation(f: ReturnType<typeof fixture>, start = performance.now() + 2_000) {
  for (let now = start; now < start + 30_000 && f.frames.size; now += 100) {
    const callbacks = [...f.frames.values()]; f.frames.clear();
    for (const callback of callbacks) callback(now);
  }
}

test('known-edge correction scales A and B dimension labels only, retaining all raw geometry and image mappings', () => {
  for (const method of ['A', 'B'] as const) {
    const f = fixture(); const token = f.begin(method); f.calibrate();
    f.journey.setGeometry(f.polygon, token); f.journey.inspect('dimensions');
    const before = geometryPresentation(f.host), raw = structuredClone(f.polygon);
    const originalLengths = dimensions(f.host).children.map(node => Number(node.children[2].dataset.mm));
    assert.equal(f.journey.setMeasurementScale(1.25, token), true);
    dimensions(f.host).children.forEach((node, index) => {
      const expected = originalLengths[index] * 1.25;
      assert.equal(Number(node.children[2].dataset.mm), expected);
      assert.equal(node.children[2].textContent, `${expected.toFixed(1)} mm`);
      assert.equal(node.children[3].textContent, `${node.dataset.edgeId}: ${expected} mm`);
    });
    assert.deepEqual(geometryPresentation(f.host), before);
    assert.deepEqual(f.polygon, raw);
    assert.equal(f.host.dataset.measurementScale, '1.25');
    assert.match(f.host.querySelector('.journey-scene-detail').textContent, /既知辺補正 ×1.25/);
    f.journey.destroy();
  }
});

test('corrected dimension captions distinguish corrected lengths from the unchanged photo and grid', () => {
  for (const method of ['A', 'B'] as const) {
    const f = fixture(); f.begin(method); f.calibrate(); f.journey.setGeometry(f.polygon); f.journey.inspect('dimensions');
    const caption = f.host.querySelector('.journey-stage-description'), original = caption.textContent;
    f.journey.setMeasurementScale(2);
    assert.match(caption.textContent, /既知の上面寸法を基準に、各辺の表示寸法を補正/);
    assert.match(caption.textContent, /写真・輪郭・グリッドはマーカーの基準スケールのまま/);
    assert.match(caption.textContent, /誤差は残ります/);
    assert.doesNotMatch(caption.textContent, /各辺を、マーカーの基準スケールでミリ表示|各辺を、基準スケールからミリに換算/);
    assert.match(f.host.querySelector('.journey-scene').attributes.get('aria-label')!, /各辺の表示寸法を補正/);
    f.journey.setMeasurementScale(1);
    assert.equal(caption.textContent, original);
    f.journey.setMeasurementScale(2); f.journey.setGeometry(f.polygon);
    assert.equal(caption.textContent, original);
    f.journey.destroy();
  }
});

test('measurement correction is absolute, accepts inclusive bounds, and resets exactly without accumulating scale', () => {
  const f = fixture(); f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon); f.journey.inspect('dimensions');
  const original = dimensions(f.host).children.map(node => Number(node.children[2].dataset.mm));
  for (const scale of [0.25, 4, 1.1, 1.333333333, 1]) {
    assert.equal(f.journey.setMeasurementScale(scale), true);
    assert.deepEqual(dimensions(f.host).children.map(node => Number(node.children[2].dataset.mm)), original.map(value => value * scale));
  }
  assert.equal(f.host.dataset.measurementScale, '1');
  assert.doesNotMatch(f.host.querySelector('.journey-scene-detail').textContent, /既知辺補正/);
  f.journey.setMeasurementScale(2); f.journey.setGeometry(f.polygon);
  assert.equal(f.host.dataset.measurementScale, '1');
  assert.deepEqual(dimensions(f.host).children.map(node => Number(node.children[2].dataset.mm)), original);
  f.journey.setMeasurementScale(2); f.journey.clearAnalysis();
  assert.equal(f.host.dataset.measurementScale, '1');
  assert.equal(dimensions(f.host).children.length, 0);
  f.journey.setGeometry(f.polygon);
  assert.deepEqual(dimensions(f.host).children.map(node => Number(node.children[2].dataset.mm)), original);
  f.journey.setMeasurementScale(2); f.journey.reset();
  assert.equal(f.host.dataset.measurementScale, '1');
  assert.equal(dimensions(f.host).children.length, 0);
  f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon); f.journey.inspect('dimensions');
  assert.deepEqual(dimensions(f.host).children.map(node => Number(node.children[2].dataset.mm)), original);
  f.journey.destroy();
});

test('invalid, stale, absent-geometry and editing-locked correction requests make no change', () => {
  const f = fixture(); const old = f.begin('A');
  assert.equal(f.journey.setMeasurementScale(2), false);
  f.calibrate(); f.journey.setGeometry(f.polygon); f.journey.inspect('dimensions'); f.journey.setMeasurementScale(1.5);
  const before = geometryPresentation(f.host), labels = dimensions(f.host).children.map(node => node.children[2].dataset.mm);
  for (const scale of [NaN, Infinity, -Infinity, -1, 0, .24999, 4.00001, '2' as unknown as number]) {
    assert.equal(f.journey.setMeasurementScale(scale), false);
    assert.equal(f.host.dataset.measurementScale, '1.5');
    assert.deepEqual(dimensions(f.host).children.map(node => node.children[2].dataset.mm), labels);
    assert.deepEqual(geometryPresentation(f.host), before);
  }
  const current = f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon, current);
  assert.equal(f.journey.setMeasurementScale(2, old), false);
  assert.equal(f.host.dataset.measurementScale, '1');
  f.journey.stopForEdit(); assert.equal(f.journey.setMeasurementScale(2, current), false);
  assert.equal(f.host.dataset.measurementScale, '1');
  f.journey.destroy(); assert.equal(f.journey.setMeasurementScale(2, current), false);
});

test('A one-click playback continues through an async analysis clear and result arrival without play()', () => {
  const f = fixture(); const token = f.begin('A'); f.calibrate();
  drainAnimation(f);
  assert.equal(f.host.dataset.stage, 'rectify');
  assert.equal(f.host.dataset.playback, 'waiting');
  f.journey.clearAnalysis(token); f.journey.setProcessing('Actual provider request running', 'running', token);
  assert.equal(f.host.dataset.playback, 'waiting');
  f.journey.setGeometry(f.polygon, token); f.journey.setMeasurementScale(1.2, token);
  assert.ok(f.frames.size > 0);
  drainAnimation(f);
  assert.equal(f.host.dataset.stage, 'dimensions');
  assert.equal(f.host.dataset.playback, 'complete');
  assert.equal(f.host.dataset.measurementScale, '1.2');
  f.journey.destroy();
});

test('analysis results and measurement correction respect a user pause instead of resuming animation', () => {
  const f = fixture(); const token = f.begin('A'); f.calibrate(); f.journey.inspect('rectify');
  f.journey.clearAnalysis(token); f.journey.setGeometry(f.polygon, token);
  const position = f.host.dataset.position;
  assert.equal(f.journey.setMeasurementScale(1.2, token), true);
  assert.equal(f.host.dataset.position, position);
  assert.equal(f.host.dataset.stage, 'rectify');
  assert.equal(f.host.dataset.playback, 'paused');
  assert.equal(f.frames.size, 0);
  f.journey.inspect('dimensions');
  assert.deepEqual(dimensions(f.host).children.map(node => Number(node.children[2].dataset.mm)), [120, 96, 120, 96, 12, 12, 12, 12]);
  f.journey.destroy();
});


function referenceHighlight(host: Element) {
  return host.querySelector('#journeyOverlay').children.find(node => node.attributes.get('data-reference-edge-highlight') === 'true')!;
}

test('reference badges avoid all visible dimension labels on desktop and mobile without hiding or moving measurements', () => {
  const rect = (element: Element) => ({
    x: Number(element.attributes.get('x')), y: Number(element.attributes.get('y')),
    width: Number(element.attributes.get('width')), height: Number(element.attributes.get('height')),
  });
  // This 150 mm top edge becomes 300 mm after correction, matching the reviewed
  // screenshot. Its top badge also tests viewport clamping on narrow screens.
  const polygon: Geometry = { outer: [{ x: 20, y: 20 }, { x: 170, y: 20 }, { x: 170, y: 65 }, { x: 90, y: 65 }, { x: 90, y: 120 }, { x: 20, y: 120 }], holes: [] };
  for (const [width, height] of [[900, 510], [360, 280], [320, 280]]) {
    const f = fixture();
    Object.assign(f.host.querySelector('.journey-scene'), { clientWidth: width, clientHeight: height });
    f.begin('A'); f.calibrate(); f.journey.setGeometry(polygon); f.journey.inspect('dimensions');
    for (const scale of [1, 2, 4]) {
      f.journey.setMeasurementScale(scale);
      const before = geometryPresentation(f.host);
      const labels = () => dimensions(f.host).children.map(node => ({ display: node.style.display, box: rect(node.children[1]), text: node.children[2].textContent, length: node.children[2].dataset.mm }));
      const originalLabels = labels();
      for (let edge = 0; edge < polygon.outer.length; edge++) {
        f.journey.setReferenceEdge(edge);
        const badge = rect(referenceHighlight(f.host).children[2]);
        assert.equal(referenceHighlight(f.host).children[3].textContent, `E${edge + 1}`);
        assert.ok(badge.x >= 8 && badge.x + badge.width <= width - 8);
        assert.ok(badge.y >= 8 && badge.y + badge.height <= height - 30);
        for (const node of dimensions(f.host).children.filter(node => node.style.display !== 'none')) {
          const label = rect(node.children[1]);
          assert.ok(badge.x + badge.width + 6 <= label.x || badge.x >= label.x + label.width + 6 || badge.y + badge.height + 6 <= label.y || badge.y >= label.y + label.height + 6,
            `${width}px E${edge + 1} at scale ${scale} overlaps ${node.dataset.edgeId}`);
        }
        assert.deepEqual(labels(), originalLabels);
        assert.deepEqual(geometryPresentation(f.host), before);
      }
    }
    f.journey.destroy();
  }
});

test('reference edge follows the same unscaled photo mapping in every real stage, even after dimension correction', () => {
  const f = fixture(); const token = f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon, token);
  for (const stage of ['source', 'crop', 'rectify', 'contour', 'dimensions'] as const) {
    f.journey.inspect(stage);
    const before = geometryPresentation(f.host), position = f.host.dataset.position;
    assert.equal(f.journey.setReferenceEdge(1, token), true);
    assert.equal(f.journey.setMeasurementScale(1.5, token), true);
    const highlight = referenceHighlight(f.host), line = highlight.children[1];
    assert.equal(highlight.style.display, '');
    assert.equal(highlight.children[3].textContent, 'E2');
    assert.deepEqual(JSON.parse(highlight.dataset.edgePointsMm), [f.polygon.outer[1], f.polygon.outer[2]]);
    const h = JSON.parse(f.host.querySelector('#journeyPlane').dataset.transform);
    const a = projectPoint(h, { x: 1200, y: 200 }), b = projectPoint(h, { x: 1200, y: 1000 });
    assert.equal(Number(line.attributes.get('x1')), a.x); assert.equal(Number(line.attributes.get('y1')), a.y);
    assert.equal(Number(line.attributes.get('x2')), b.x); assert.equal(Number(line.attributes.get('y2')), b.y);
    assert.deepEqual(geometryPresentation(f.host), before);
    assert.equal(f.host.dataset.position, position);
    assert.equal(f.frames.size, 0);
  }
  f.journey.destroy();
});

test('a short outer edge retains its independent E1 highlight when its dimension label is hidden', () => {
  const f = fixture(); f.begin('B'); f.calibrate();
  const polygon = { outer: [{ x: 20, y: 20 }, { x: 20.1, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 100 }, { x: 20, y: 100 }], holes: [] };
  f.journey.setGeometry(polygon); f.journey.inspect('dimensions');
  assert.equal(dimensions(f.host).children[0].style.display, 'none');
  assert.equal(f.journey.setReferenceEdge(0), true);
  assert.equal(dimensions(f.host).children[0].style.display, 'none');
  assert.equal(referenceHighlight(f.host).style.display, '');
  assert.equal(referenceHighlight(f.host).children[3].textContent, 'E1');
  assert.match(f.host.querySelector('.journey-scene').attributes.get('aria-label')!, /基準辺 E1/);
  f.journey.destroy();
});

test('reference edge validates outer-only integer indexes and stale tokens without changing valid selection', () => {
  const f = fixture(); const old = f.begin('A');
  assert.equal(f.journey.setReferenceEdge(0), false);
  f.calibrate(); f.journey.setGeometry(f.polygon); f.journey.inspect('dimensions');
  assert.equal(f.journey.setReferenceEdge(3, old), true);
  assert.deepEqual(JSON.parse(referenceHighlight(f.host).dataset.edgePointsMm), [f.polygon.outer[3], f.polygon.outer[0]]);
  for (const index of [-1, 0.5, 4, 7, NaN, Infinity, '0' as unknown as number]) {
    assert.equal(f.journey.setReferenceEdge(index), false);
    assert.equal(referenceHighlight(f.host).children[3].textContent, 'E4');
  }
  const token = f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon, token); f.journey.setReferenceEdge(1, token);
  assert.equal(f.journey.setReferenceEdge(2, old), false);
  assert.equal(f.journey.setReferenceEdge(null, old), false);
  assert.equal(referenceHighlight(f.host).children[3].textContent, 'E2');
  assert.equal(f.journey.setReferenceEdge(null, token), true);
  assert.equal(referenceHighlight(f.host).style.display, 'none');
  assert.equal(f.host.dataset.referenceEdge, '');
  f.journey.destroy(); assert.equal(f.journey.setReferenceEdge(0, token), false);
});

test('reference selection clears on geometry replacement, analysis clear and source reset', () => {
  const f = fixture(); f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon); f.journey.inspect('dimensions');
  const assertCleared = () => {
    assert.equal(f.host.dataset.referenceEdge, '');
    assert.equal(referenceHighlight(f.host).style.display, 'none');
    assert.equal(referenceHighlight(f.host).dataset.edgePointsMm, undefined);
    assert.equal(referenceHighlight(f.host).children[3].textContent, '');
  };
  f.journey.setReferenceEdge(0); f.journey.setGeometry(f.polygon); assertCleared();
  f.journey.setReferenceEdge(0); f.journey.clearAnalysis(); assertCleared();
  f.journey.setGeometry(f.polygon); f.journey.setReferenceEdge(0); f.journey.reset(); assertCleared();
  f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon); f.journey.setReferenceEdge(0); f.begin('B'); assertCleared();
  f.journey.destroy();
});


test('reference edge stays on source pixels when projective CSS is unavailable', () => {
  const f = fixture(false, false); f.begin('A'); f.calibrate(); f.journey.setGeometry(f.polygon);
  f.journey.inspect('source'); f.journey.setReferenceEdge(1);
  assert.equal(f.host.dataset.playback, 'fallback');
  const line = referenceHighlight(f.host).children[1], camera = JSON.parse(f.host.querySelector('#journeySource').dataset.camera);
  const a = transformPoint({ x: 580, y: 180 }, camera), b = transformPoint({ x: 580, y: 500 }, camera);
  assert.equal(Number(line.attributes.get('x1')), a.x); assert.equal(Number(line.attributes.get('y1')), a.y);
  assert.equal(Number(line.attributes.get('x2')), b.x); assert.equal(Number(line.attributes.get('y2')), b.y);
  assert.equal(referenceHighlight(f.host).style.display, '');
  f.journey.destroy();
});

test('automatic curve final scene uses arc length, preserves calibration reference and clears stale controls',()=>{
 const f=fixture(true),token=f.begin('B');f.calibrate();f.journey.setGeometry(f.polygon,token);
 const curve=structuredClone(f.polygon) as import('../src/curves.ts').CurveGeometry;
 curve.outer[0].outgoing={x:45,y:5};curve.outer[1].incoming={x:95,y:5};
 assert.equal(f.journey.setCurveGeometry(curve,token),true);f.journey.skip();
 const path=f.host.querySelector('#journeyOverlay').children.find(n=>n.attributes.get('data-contour')==='simplified')!;
 assert.deepEqual(JSON.parse(path.dataset.curveGeometryMm),curve);
 const first=dimensions(f.host).children[0].children[2];assert.match(first.textContent,/弧 /);const length=Number(first.dataset.mm);assert.ok(length>100);
 f.journey.setMeasurementScale(2,token);assert.equal(Number(first.dataset.mm),length*2);
 assert.equal(f.journey.setReferenceEdge(0,token),true);
 const reference=referenceHighlight(f.host);assert.deepEqual(JSON.parse(reference.dataset.edgePointsMm),f.polygon.outer.slice(0,2));
 assert.equal(f.journey.setCurveGeometry(undefined,token),true);assert.equal(dimensions(f.host).children[0].children[2].textContent,'200.0 mm');
 f.journey.setCurveGeometry(curve,token);f.journey.setGeometry(f.polygon,token);assert.equal(path.dataset.curveGeometryMm,undefined);
 assert.equal(f.journey.setCurveGeometry(curve,token-1),false);f.journey.destroy();
});
