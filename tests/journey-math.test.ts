import test from 'node:test';
import assert from 'node:assert/strict';
import { rectangleToQuad, projectPoint, matrix3d, rectangleQuad, interpolateQuad, fitPoints, transformPoint, dimensionEdges, smoothStep, orientCropCamera, interpolateCamera, conditionedPlaneMatrix, CSS_PLANE_EXTENT } from '../src/journey-math.ts';
import type { Quad } from '../src/journey-math.ts';
const close = (a: number, b: number, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);
const photoQuad: Quad = [{ x: 134, y: 82 }, { x: 904, y: 143 }, { x: 811, y: 624 }, { x: 73, y: 731 }];

test('projective plane aligns all four canonical corners to the real photo quad', () => {
  const input = rectangleQuad(2500, 1700), matrix = rectangleToQuad(2500, 1700, photoQuad);
  assert.ok(Math.abs(matrix[6]) + Math.abs(matrix[7]) > 0);
  input.forEach((point, i) => { const p = projectPoint(matrix, point); close(p.x, photoQuad[i].x); close(p.y, photoQuad[i].y); });
});
test('CSS matrix3d and overlay homography agree at corners and interior pixels', () => {
  const homography = rectangleToQuad(2500, 1700, photoQuad);
  const css = matrix3d(homography).slice(9, -1).split(',').map(Number);
  for (const point of [...rectangleQuad(2500, 1700), { x: 711.5, y: 1120.2 }]) {
    const denominator = css[3] * point.x + css[7] * point.y + css[15];
    const p = projectPoint(homography, point);
    close((css[0] * point.x + css[4] * point.y + css[12]) / denominator, p.x);
    close((css[1] * point.x + css[5] * point.y + css[13]) / denominator, p.y);
  }
});
test('continuous rectification has exact endpoints and a valid shared map on every frame', () => {
  const destination = rectangleQuad(700, 476, 150, 82);
  for (let frame = 0; frame <= 120; frame++) {
    const quad = interpolateQuad(photoQuad, destination, smoothStep(frame / 120));
    const matrix = rectangleToQuad(2500, 1700, quad);
    rectangleQuad(2500, 1700).forEach((p, i) => { const q = projectPoint(matrix, p); close(q.x, quad[i].x); close(q.y, quad[i].y); });
  }
  assert.deepEqual(interpolateQuad(photoQuad, destination, 0), photoQuad);
  assert.deepEqual(interpolateQuad(photoQuad, destination, 1), destination);
});
test('source framing uses one uniform camera transform and preserves all actual marker coordinates', () => {
  const points = rectangleQuad(2000, 1200), fit = fitPoints(points, { width: 1000, height: 600 }, 50);
  close(fit.scale, 5 / 12);
  const a = transformPoint(points[0], fit), b = transformPoint(points[2], fit);
  close((a.x + b.x) / 2, 500); close((a.y + b.y) / 2, 300);
});
test('degenerate, folded and non-finite quads fail honestly instead of faking a transform', () => {
  for (const quad of [rectangleQuad(0, 20), [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }], rectangleQuad(Infinity, 20)]) {
    assert.throws(() => rectangleToQuad(100, 100, quad as Quad));
  }
  assert.throws(() => projectPoint([1, 0, 0, 0, 1, 0, 1, 0, 0], { x: 0, y: 1 }));
});
test('edge dimensions come only from supplied geometry, including diagonal lengths and holes', () => {
  const edges = dimensionEdges([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 0 }], [rectangleQuad(2, 1, .2, .3)]);
  assert.deepEqual(edges.map(e => e.lengthMm), [5, 4, 3, 2, 1, 2, 1]);
  assert.deepEqual(edges.map(e => e.id), ['E1', 'E2', 'E3', 'H1E1', 'H1E2', 'H1E3', 'H1E4']);
});


test('0/90/180/270° whole-photo rotations remain convex throughout camera rotation and non-square rectification', () => {
  const viewport = { width: 980, height: 620 };
  const target = rectangleQuad(700, 476, 140, 72);
  for (const degrees of [0, 90, 180, 270]) {
    const angle = degrees / 180 * Math.PI;
    const original = photoQuad.map(point => transformPoint(point, { scale: 1, rotation: angle, x: 1200, y: 1200 })) as Quad;
    const cropCamera = orientCropCamera(original, viewport, 60);
    const sourceCamera = fitPoints(original, viewport, 40);
    for (let frame = 0; frame <= 100; frame++) {
      const camera = interpolateCamera(sourceCamera, cropCamera, frame / 100, viewport);
      const cameraQuad = original.map(point => transformPoint(point, camera)) as Quad;
      assert.doesNotThrow(() => rectangleToQuad(2500, 1700, cameraQuad));
      const normalized = original.map(point => transformPoint(point, cropCamera)) as Quad;
      const quad = interpolateQuad(normalized, target, frame / 100);
      const matrix = rectangleToQuad(2500, 1700, quad);
      rectangleQuad(2500, 1700).forEach((point, i) => {
        const mapped = projectPoint(matrix, point); close(mapped.x, quad[i].x); close(mapped.y, quad[i].y);
      });
    }
    const cameraEnd = interpolateCamera(sourceCamera, cropCamera, 1, viewport);
    original.forEach(point => {
      const expected = transformPoint(point, cropCamera), actual = transformPoint(point, cameraEnd);
      close(actual.x, expected.x); close(actual.y, expected.y);
    });
  }
});


test('conditioned CSS plane retains native-pixel projective mapping at every corner and interior pixel', () => {
  for (const [width, height] of [[2500, 1700], [2000, 2000], [2000, 100], [100, 2000]]) {
    const native = rectangleToQuad(width, height, photoQuad);
    const css = conditionedPlaneMatrix(native, width, height);
    for (const point of [...rectangleQuad(width, height), { x: width * .37, y: height * .63 }]) {
      const expected = projectPoint(native, point);
      const actual = projectPoint(css, { x: point.x / width * CSS_PLANE_EXTENT, y: point.y / height * CSS_PLANE_EXTENT });
      close(actual.x, expected.x); close(actual.y, expected.y);
    }
    assert.throws(() => conditionedPlaneMatrix(native, 0, height));
  }
});

test('conditioned plane stays below .05px error under CSS perspective coefficient quantization', () => {
  const viewport = { width: 980, height: 620 }, target = rectangleQuad(700, 476, 140, 72);
  let worstNative = 0, worstConditioned = 0;
  // Reproduce the observed absolute precision loss without relying on a browser's
  // matrix serialization string. Browser tests additionally measure actual paint.
  const quantize = (matrix: readonly number[]) => matrix.map((value, index) => index === 6 || index === 7 ? Math.trunc(value * 1e7) / 1e7 : value);
  for (const degrees of [0, 90, 180, 270]) {
    const original = photoQuad.map(point => transformPoint(point, { scale: 1, rotation: degrees * Math.PI / 180, x: 1200, y: 1200 })) as Quad;
    const view = orientCropCamera(original, viewport, 60);
    const normalized = original.map(point => transformPoint(point, view)) as Quad;
    for (let frame = 0; frame <= 100; frame++) {
      const quad = interpolateQuad(normalized, target, frame / 100);
      const native = rectangleToQuad(2500, 1700, quad);
      const css = conditionedPlaneMatrix(native, 2500, 1700);
      rectangleQuad(2500, 1700).forEach((point, i) => {
        const nativePoint = projectPoint(quantize(native), point);
        const cssPoint = projectPoint(quantize(css), { x: point.x / 2500 * CSS_PLANE_EXTENT, y: point.y / 1700 * CSS_PLANE_EXTENT });
        worstNative = Math.max(worstNative, Math.hypot(nativePoint.x - quad[i].x, nativePoint.y - quad[i].y));
        worstConditioned = Math.max(worstConditioned, Math.hypot(cssPoint.x - quad[i].x, cssPoint.y - quad[i].y));
      });
    }
  }
  assert.ok(worstNative > .05, `Regression fixture must exercise the original loss: ${worstNative}`);
  assert.ok(worstConditioned < .05, `Conditioned plane paint error ${worstConditioned}px`);
});
