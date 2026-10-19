import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bbox, buildMeasurement, cloneGeometry, compareGeometry, createDxf, createJson, createSvg,
  distance, douglasPeucker, edgeAngle, edgeMeasurements, geometryArea, nearAxisSnap, pointInRing,
  pointToSegmentDistance, polygonArea, segmentsIntersect, signedArea, simplifyGeometry, validateGeometry,
  type Geometry, type Point,
} from '../src/geometry.ts';

const points = (pairs: number[][]): Point[] => pairs.map(([x, y]) => ({ x, y }));
const rectangle = (x: number, y: number, width: number, height: number): Point[] => points([[x, y], [x + width, y], [x + width, y + height], [x, y + height]]);
const geometry = (outer: Point[], holes: Point[][] = []): Geometry => ({ outer, holes });
const L = geometry(points([[35, 25], [185, 25], [185, 80], [105, 80], [105, 145], [35, 145]]));
const board = { width: 220, height: 180 };
const close = (actual: number, expected: number, tolerance = 1e-9): void => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

// User-supplied reference: this is a concave L, not its bounding rectangle.
test('L reference area is exactly 12,800 mm² with exact lengths and directed angles', () => {
  assert.equal(validateGeometry(L).valid, true);
  assert.equal(geometryArea(L), 12800);
  assert.deepEqual(edgeMeasurements(L.outer).map(e => e.length_mm), [150, 55, 80, 65, 70, 120]);
  assert.deepEqual(edgeMeasurements(L.outer).map(e => e.angle_deg), [0, 90, 180, 90, 180, 270]);
  assert.deepEqual(bbox(L), { minX: 35, minY: 25, maxX: 185, maxY: 145, width: 150, height: 120 });
});
test('Euclidean diagonal lengths retain precision, angles cover all quadrants', () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(distance({ x: 0, y: 0 }, { x: 1, y: 1 }), Math.sqrt(2));
  for (const [x, y, angle] of [[1, 1, 45], [-1, 1, 135], [-1, -1, 225], [1, -1, 315]]) close(edgeAngle({ x: 0, y: 0 }, { x, y }), angle);
});
test('shoelace subtracts holes regardless of ring winding', () => {
  const outer = rectangle(0, 0, 100, 100), hole = rectangle(10, 10, 20, 30);
  assert.equal(geometryArea(geometry(outer, [hole])), 9400);
  assert.equal(geometryArea(geometry([...outer].reverse(), [[...hole].reverse()])), 9400);
  assert.equal(signedArea(outer), 10000);
  assert.equal(signedArea([...outer].reverse()), -10000);
});
test('shoelace remains accurate for small shapes at large absolute coordinates', () => {
  assert.equal(polygonArea(rectangle(1e10, 1e10, 3, 4)), 12);
});
test('multiple strictly-contained, separate holes are valid', () => {
  assert.equal(validateGeometry(geometry(rectangle(0, 0, 100, 100), [rectangle(10, 10, 10, 10), rectangle(70, 70, 10, 10)])).valid, true);
});
test('reject non-finite coordinates', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const result = validateGeometry(geometry(points([[0, 0], [value, 0], [10, 10]])));
    assert.equal(result.valid, false); assert.match(result.errors.join(' '), /non-finite/);
  }
});
test('reject duplicate points, implicit closing repeat, and too few vertices', () => {
  for (const ring of [points([[0, 0], [10, 0]]), points([[0, 0], [10, 0], [10, 10], [0, 0]]), points([[0, 0], [10, 0], [10, 0], [0, 10]])]) assert.equal(validateGeometry(geometry(ring)).valid, false);
});
test('reject bow ties, nonzero-area self-crossings, and self-touches', () => {
  for (const ring of [points([[0, 0], [10, 10], [0, 10], [10, 0]]), points([[0, 0], [20, 10], [0, 20], [10, 0]]), points([[0, 0], [20, 0], [20, 20], [10, 0], [0, 20]])]) {
    const result = validateGeometry(geometry(ring)); assert.equal(result.valid, false); assert.match(result.errors.join(' '), /self-intersects/);
  }
});
test('reject zero-area and adjacent overlapping edges; allow straight continuation', () => {
  assert.equal(validateGeometry(geometry(points([[0, 0], [10, 0], [20, 0]]))).valid, false);
  assert.equal(validateGeometry(geometry(points([[0, 0], [20, 0], [10, 0], [10, 10], [0, 10]]))).valid, false);
  assert.equal(validateGeometry(geometry(points([[0, 0], [10, 0], [20, 0], [20, 10], [0, 10]]))).valid, true);
});
test('reject holes outside, touching at a vertex or along an edge, and crossing outer', () => {
  const outer = rectangle(0, 0, 100, 100);
  for (const hole of [rectangle(110, 10, 5, 5), rectangle(0, 0, 5, 5), rectangle(0, 10, 5, 5), rectangle(95, 10, 10, 10)]) {
    const result = validateGeometry(geometry(outer, [hole])); assert.equal(result.valid, false); assert.match(result.errors.join(' '), /strictly inside/);
  }
});
test('reject hole that exits concave outer although every vertex is inside', () => {
  const outer = points([[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]]);
  const hole = points([[1, 5], [9, 5], [9, 6], [1, 6]]);
  assert.ok(hole.every(p => pointInRing(p, outer) === 'inside'));
  assert.equal(validateGeometry(geometry(outer, [hole])).valid, false);
});
test('reject touching, intersecting, overlapping, nested and identical holes', () => {
  const outer = rectangle(0, 0, 100, 100), first = rectangle(10, 10, 30, 30);
  for (const second of [rectangle(40, 40, 10, 10), rectangle(40, 20, 10, 10), rectangle(30, 30, 20, 20), rectangle(20, 20, 5, 5), first]) {
    const result = validateGeometry(geometry(outer, [first, second])); assert.equal(result.valid, false); assert.match(result.errors.join(' '), /Holes 1 and 2/);
  }
});
test('point/ring and segment predicates distinguish boundary and containment', () => {
  const ring = rectangle(0, 0, 10, 10);
  assert.equal(pointInRing({ x: 5, y: 5 }, ring), 'inside');
  assert.equal(pointInRing({ x: 0, y: 5 }, ring), 'boundary');
  assert.equal(pointInRing({ x: 15, y: 5 }, ring), 'outside');
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 20, y: 0 }), true);
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 11, y: 0 }, { x: 20, y: 0 }), false);
  assert.equal(pointToSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(pointToSegmentDistance({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
});
test('buildMeasurement produces all schema fields, closing edges, IDs, and scale', () => {
  const model = geometry(rectangle(0, 0, 100, 100), [rectangle(10, 10, 20, 20)]);
  const result = buildMeasurement(model, board, 'a4', { scale_mm_per_px: 0.2, source: 'fixture' });
  assert.equal(result.preset_mode, 'a4'); assert.deepEqual(result.board_size_mm, { width_mm: 220, height_mm: 180 }); assert.equal(result.scale_mm_per_px, 0.2);
  assert.equal(result.outer_vertices_mm[0].id, 'V1'); assert.equal(result.holes_vertices_mm[0][0].id, 'H1V1');
  assert.equal(result.edges_mm.at(-1)?.to, 'V1'); assert.equal(result.hole_edges_mm[0].at(-1)?.to, 'H1V1');
  assert.equal(result.total_area_mm2, 9600); assert.equal(result.coordinate_system, 'image_x_right_y_down');
  assert.equal(buildMeasurement(L, board).scale_mm_per_px, null);
  assert.equal(buildMeasurement(L, board, 'test', { scaleMmPerPx: 0.5 }).scale_mm_per_px, 0.5);
  assert.deepEqual(JSON.parse(createJson(model, board, 'a4', { scale_mm_per_px: 0.2, source: 'fixture' })), result);
});
test('export refuses invalid topology, invalid board, and invalid scale', () => {
  const invalid = geometry(points([[0, 0], [10, 10], [0, 10], [10, 0]]));
  for (const exporter of [createJson, createSvg, createDxf]) assert.throws(() => exporter(invalid, board), /self-intersects/);
  assert.throws(() => buildMeasurement(L, { width: 0, height: 100 }), /Board/);
  assert.throws(() => buildMeasurement(L, board, 'test', { scale_mm_per_px: 0 }), /scale/);
});
test('SVG exports mm units, board viewBox, evenodd holes, and dimensions layer', () => {
  const svg = createSvg(geometry(rectangle(10, 10, 100, 100), [rectangle(20, 20, 20, 20)]), board, '<unsafe & title>');
  assert.match(svg, /width="220mm" height="180mm" viewBox="0 0 220 180"/);
  assert.match(svg, /fill-rule="evenodd"/); assert.match(svg, /id="dimensions"/); assert.match(svg, /100\.00 mm/);
  assert.match(svg, /&lt;unsafe &amp; title&gt;/); assert.doesNotMatch(svg, /<unsafe/);
  assert.equal((svg.match(/ Z/g) ?? []).length, 2);
});
function dxfPairs(dxf: string): [string, string][] { const lines = dxf.trim().split('\n'); return Array.from({ length: lines.length / 2 }, (_, i) => [lines[i * 2], lines[i * 2 + 1]]); }
function dxfPolylines(dxf: string): [string, string][][] {
  const pairs = dxfPairs(dxf), entities: [string, string][][] = [];
  for (let i = 0; i < pairs.length; i++) if (pairs[i][0] === '0' && pairs[i][1] === 'LWPOLYLINE') { const entity: [string, string][] = []; for (let j = i + 1; j < pairs.length && pairs[j][0] !== '0'; j++) entity.push(pairs[j]); entities.push(entity); }
  return entities;
}
test('DXF rectangle has true closed LWPOLYLINE, exact mm size, and y-up frame', () => {
  const dxf = createDxf(geometry(rectangle(10, 20, 30, 40)), { width: 100, height: 100 });
  assert.match(dxf, /\$INSUNITS\n70\n4\n/); assert.match(dxf, /\$ACADVER\n1\nAC1015/);
  const [entity] = dxfPolylines(dxf);
  assert.ok(entity.some(([code, value]) => code === '90' && value === '4')); assert.ok(entity.some(([code, value]) => code === '70' && value === '1'));
  assert.deepEqual(entity.filter(([code]) => code === '10').map(([, value]) => +value), [10, 40, 40, 10]);
  assert.deepEqual(entity.filter(([code]) => code === '20').map(([, value]) => +value), [80, 80, 40, 40]);
});
test('DXF holes are independently closed LWPOLYLINE entities on HOLES layer', () => {
  const entities = dxfPolylines(createDxf(geometry(rectangle(0, 0, 100, 100), [rectangle(10, 10, 10, 10), rectangle(50, 50, 20, 10)]), board));
  assert.equal(entities.length, 3);
  assert.deepEqual(entities.map(e => e.find(([code]) => code === '8')?.[1]), ['OUTER', 'HOLES', 'HOLES']);
  assert.ok(entities.every(e => e.some(([code, value]) => code === '70' && value === '1')));
});
test('clone and exports never mutate input geometry', () => {
  const source = cloneGeometry(L), saved = JSON.stringify(source), clone = cloneGeometry(source);
  clone.outer[0].x++;
  createSvg(source, board); createDxf(source, board); createJson(source, board); nearAxisSnap(source); simplifyGeometry(source, 1);
  assert.equal(JSON.stringify(source), saved);
});
test('near-axis snap corrects within five degrees, keeps diagonal geometry', () => {
  const tilted = geometry(points([[10, 10], [110, 12], [108, 110], [12, 108]]));
  const snapped = nearAxisSnap(tilted);
  assert.equal(validateGeometry(snapped).valid, true);
  assert.deepEqual(edgeMeasurements(snapped.outer).map(e => e.angle_deg), [0, 90, 180, 270]);
  const diamond = geometry(points([[0, 10], [10, 0], [20, 10], [10, 20]]));
  assert.deepEqual(nearAxisSnap(diamond), diamond);
  assert.throws(() => nearAxisSnap(tilted, 45), /threshold/);
});
test('near-axis snap rolls back if a hole would touch or cross boundary', () => {
  const source = geometry(points([[0, 0], [100, 4], [100, 100], [0, 100]]), [rectangle(5, 0.5, 2, 0.2)]);
  assert.equal(validateGeometry(source).valid, true);
  const snapped = nearAxisSnap(source);
  assert.deepEqual(snapped, source); assert.notEqual(snapped, source);
});
test('closed Douglas–Peucker simplifies collinear/noisy contours in millimetres', () => {
  const noisy = points([[0, 0], [50, 0.2], [100, 0], [100.1, 50], [100, 100], [50, 99.9], [0, 100], [-0.1, 50]]);
  assert.equal(douglasPeucker(noisy, 0.25).length, 4);
  assert.equal(douglasPeucker(noisy, 0.05).length, 8);
  assert.equal(douglasPeucker(noisy, 0).length, 8);
  assert.equal(validateGeometry(geometry(douglasPeucker(noisy, 1e6))).valid, true);
  assert.throws(() => douglasPeucker(noisy, -1), /tolerance/);
});
test('simplification preserves valid hole topology and never removes a ring', () => {
  const source = geometry(points([[0, 0], [10, 0], [10, 10], [6, 10], [6, 5], [4, 5], [4, 10], [0, 10]]), [rectangle(1, 1, 1, 1)]);
  const result = simplifyGeometry(source, 3);
  assert.equal(validateGeometry(result).valid, true); assert.equal(result.holes.length, 1); assert.ok(result.holes[0].length >= 3);
});
test('identical benchmark yields exact zero errors, including holes', () => {
  const source = geometry(rectangle(0, 0, 100, 100), [rectangle(10, 10, 10, 20)]);
  const result = compareGeometry(source, source);
  assert.equal(result.boundary_mean_mm, 0); assert.equal(result.boundary_max_mm, 0); assert.equal(result.area_error_mm2, 0); assert.equal(result.area_error_percent, 0);
  assert.equal(result.edge_length_mae_mm, 0); assert.equal(result.hole_count_mismatch, 0); assert.equal(result.topology_matches, true);
  assert.equal(result.predicted_to_reference.sample_count, 460);
});
test('benchmark is bidirectional and detects missing hole boundary', () => {
  const source = geometry(rectangle(0, 0, 100, 100), [rectangle(40, 40, 20, 20)]), noHole = geometry(rectangle(0, 0, 100, 100));
  const result = compareGeometry(noHole, source);
  assert.equal(result.predicted_to_reference.mean_mm, 0); assert.ok(result.reference_to_predicted.mean_mm > 0);
  assert.ok(result.boundary_mean_mm > 0); assert.equal(result.boundary_max_mm, 40);
  assert.equal(result.hole_count_mismatch, 1); assert.equal(result.topology_matches, false);
  assert.equal(result.edge_length_mae_mm, null); assert.equal(result.area_error_mm2, 400);
  close(result.area_error_percent, 400 / 9600 * 100);
});
test('boundary metric compares exact segments rather than nearest vertices', () => {
  const sparse = geometry(rectangle(0, 0, 100, 100));
  const dense = geometry(points([[0, 0], [50, 0], [100, 0], [100, 50], [100, 100], [50, 100], [0, 100], [0, 50]]));
  const result = compareGeometry(dense, sparse, 0.7);
  close(result.boundary_mean_mm, 0); close(result.boundary_max_mm, 0);
  assert.equal(result.topology_matches, false); assert.equal(result.edge_length_mae_mm, null);
});
test('benchmark handles cyclic shifts, reversed rings, and reordered holes', () => {
  const a = rectangle(10, 10, 10, 20), b = points([[60, 60], [80, 60], [75, 80]]), c = rectangle(30, 30, 5, 10);
  const source = geometry(rectangle(0, 0, 100, 100), [a, b, c]);
  const rotate = (ring: Point[]): Point[] => [...ring.slice(2), ...ring.slice(0, 2)].reverse();
  const result = compareGeometry(geometry(rotate(source.outer), [rotate(c), rotate(a), rotate(b)]), source);
  close(result.boundary_mean_mm, 0); assert.equal(result.edge_length_mae_mm, 0); assert.equal(result.topology_matches, true);
});
test('matching topology reports actual edge errors after cyclic/reverse alignment', () => {
  const ref = geometry(rectangle(0, 0, 10, 20)), pred = geometry(rectangle(0, 0, 12, 20).reverse());
  const result = compareGeometry(pred, ref, 0.5);
  assert.equal(result.edge_length_mae_mm, 1); assert.equal(result.edge_length_max_error_mm, 2);
  assert.equal(result.area_error_mm2, 40); assert.equal(result.area_error_percent, 20);
});
test('benchmark suppresses edge error when per-hole vertex topology differs', () => {
  const outer = rectangle(0, 0, 100, 100);
  const reference = geometry(outer, [rectangle(10, 10, 20, 20)]);
  const predicted = geometry(outer, [points([[10, 10], [30, 10], [30, 30], [20, 30], [10, 30]])]);
  const result = compareGeometry(predicted, reference);
  assert.equal(result.hole_count_mismatch, 0); assert.equal(result.topology_matches, false); assert.equal(result.edge_length_mae_mm, null);
});
test('benchmark invalid input and spacing fail explicitly', () => {
  assert.throws(() => compareGeometry(L, L, 0), /spacing/);
  assert.throws(() => compareGeometry(geometry([]), L), /three vertices/);
});

// Application calibration metadata must never leak into the exact board schema.
test('measurement board_size_mm contains only width_mm and height_mm', () => {
  const appBoard = { ...board, pixelWidth: 1320, pixelHeight: 1080, preset: 'a4', scale: 1 / 6 };
  const result = buildMeasurement(L, appBoard, 'a4');
  assert.deepEqual(result.board_size_mm, { width_mm: 220, height_mm: 180 });
  assert.deepEqual(Object.keys(result.board_size_mm).sort(), ['height_mm', 'width_mm']);
  assert.equal(result.angle_convention, 'clockwise_from_positive_x_0_to_360_degrees');
});
test('hole assignment stays one-to-one for several reordered same-topology holes', () => {
  const outer = rectangle(0, 0, 200, 200);
  const holes = [rectangle(10, 10, 10, 15), rectangle(40, 40, 15, 20), rectangle(100, 100, 20, 25), rectangle(150, 150, 10, 30)];
  const altered = holes.map((ring, i) => ring.map(p => ({ x: p.x + (i === 2 ? 1 : 0), y: p.y })));
  const result = compareGeometry(geometry(outer, [altered[2], altered[0], altered[3], altered[1]]), geometry(outer, holes));
  assert.equal(result.topology_matches, true);
  assert.equal(result.edge_length_mae_mm, 0);
  assert.equal(result.edge_length_max_error_mm, 0);
  assert.equal(result.area_error_mm2, 0);
  assert.ok(result.boundary_mean_mm > 0);
});
test('bidirectional mean and max are symmetric under input swap', () => {
  const a = geometry(rectangle(0, 0, 100, 100), [rectangle(10, 10, 15, 25)]);
  const b = geometry(rectangle(3, 4, 110, 90), [rectangle(20, 20, 15, 25)]);
  const forward = compareGeometry(a, b, 0.7), backward = compareGeometry(b, a, 0.7);
  assert.equal(forward.boundary_mean_mm, backward.boundary_mean_mm);
  assert.equal(forward.boundary_max_mm, backward.boundary_max_mm);
  assert.equal(forward.predicted_to_reference.mean_mm, backward.reference_to_predicted.mean_mm);
});

test('DXF table head and records carry valid unique R2000 handles', () => {
  const dxf = createDxf(geometry(rectangle(0, 0, 100, 100), [rectangle(10, 10, 10, 10)]), board);
  const pairs = dxfPairs(dxf);
  assert.match(dxf, /0\nTABLE\n2\nLAYER\n5\n1\n330\n0\n100\nAcDbSymbolTable\n70\n2\n/);
  assert.match(dxf, /0\nLAYER\n5\n2\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord/);
  const handles = pairs.filter(([code]) => code === '5').map(([, value]) => value);
  assert.ok(handles.every(value => /^[1-9A-F][0-9A-F]*$/.test(value)));
  assert.equal(new Set(handles).size, handles.length);
  assert.deepEqual(dxfPolylines(dxf).map(entity => entity.find(([code]) => code === '5')?.[1]), ['4', '5']);
  assert.match(dxf, /\$HANDSEED\n5\n6\n/);
});
