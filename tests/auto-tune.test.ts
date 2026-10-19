import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_TUNE_LIMITS, candidateSearchDiagnostics, searchMaskCandidates } from '../src/auto-tune.ts';
import { geometryArea, validateGeometry } from '../src/geometry.ts';
import { traceMask, type Board, type MaskResult } from '../src/vision.ts';

const board: Board = { width: 80, height: 80, pixelWidth: 800, pixelHeight: 800, preset: 'TEST' };
function maskOf(fn: (x: number, y: number) => number, width = 80, height = 80): MaskResult {
  return { width, height, elapsedMs: 123, probabilities: Float32Array.from({ length: width * height }, (_, i) => fn(i % width, Math.floor(i / width))) };
}
const rectangle = (value = 0.92) => maskOf((x, y) => x >= 10 && x < 70 && y >= 10 && y < 70 ? value : 0.03);
const quick = { currentEpsilon: 0.5 };

test('recovers an invalid high threshold using the unchanged real mask and board', async () => {
  const mask = rectangle(0.62), probabilitiesBefore = mask.probabilities.slice(), boardBefore = { ...board };
  const result = await searchMaskCandidates(mask, board, { currentThreshold: 0.9, currentEpsilon: 4 });
  assert.ok(result.best);
  assert.equal(result.stoppedReason, 'completed');
  assert.equal(result.attempts[0].valid, false);
  assert.match(result.attempts[0].invalidReason!, /empty_foreground/);
  assert.ok(result.best.threshold < 0.62);
  assert.equal(validateGeometry(result.best.geometry).valid, true);
  assert.deepEqual(result.best.rawGeometry, traceMask(mask, board, result.best.threshold).rawGeometry);
  assert.deepEqual(mask.probabilities, probabilitiesBefore);
  assert.deepEqual(board, boardBefore);
  assert.equal(mask.elapsedMs, 123);
});

test('low full-mask setting recovers and near-full is ambiguous rather than falsely empty/full', async () => {
  const mask = maskOf((x, y) => x >= 10 && x < 70 && y >= 10 && y < 70 ? 0.95 : 0.28);
  const result = await searchMaskCandidates(mask, board, { ...quick, currentThreshold: 0.1 });
  assert.match(result.attempts[0].invalidReason!, /full_foreground/);
  assert.ok(result.best && result.best.threshold > 0.28);
  const nearlyFull = maskOf((x, y) => x > 0 && y > 0 && x < 79 && y < 79 ? 0.95 : 0.01);
  const nearResult = await searchMaskCandidates(nearlyFull, board, quick);
  assert.ok(nearResult.best);
  assert.equal(nearResult.best.safeToAutoApply, false);
  assert.ok(nearResult.best.warnings.some(w => /Nearly the entire frame/.test(w)));
  const smallBorderMask = maskOf((x, y) => x > 0 && y > 0 && x < 63 && y < 63 ? 0.95 : 0.01, 64, 64);
  const thinBorder = await searchMaskCandidates(smallBorderMask, board, quick);
  assert.ok(thinBorder.best && thinBorder.best.metrics.foregroundFraction < 0.95);
  assert.equal(thinBorder.best.safeToAutoApply, false);
  assert.equal(thinBorder.best.metrics.edgeClearancePx, 1);
});

test('empty/full masks cannot produce fabricated candidates', async () => {
  for (const probability of [0, 1]) {
    const result = await searchMaskCandidates(maskOf(() => probability), board, quick);
    assert.equal(result.stoppedReason, 'no_valid_candidate');
    assert.equal(result.best, undefined);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.attempts.length, 9);
    assert.ok(result.attempts.every(a => !a.valid && a.invalidReason?.includes(probability ? 'full_foreground' : 'empty_foreground')));
  }
});

test('invalid probability, mask dimensions, and calibration fail honestly without mutation', async () => {
  const bad = rectangle(); bad.probabilities[7] = NaN;
  assert.equal((await searchMaskCandidates(bad, board)).stoppedReason, 'invalid_input');
  bad.probabilities[7] = Infinity;
  assert.equal((await searchMaskCandidates(bad, board)).stoppedReason, 'invalid_input');
  bad.probabilities[7] = 1.1;
  assert.equal((await searchMaskCandidates(bad, board)).stoppedReason, 'invalid_input');
  assert.equal((await searchMaskCandidates({ ...rectangle(), width: 79 }, board)).stoppedReason, 'invalid_input');
  assert.equal((await searchMaskCandidates(rectangle(), { ...board, width: 0 })).stoppedReason, 'invalid_input');
});

test('a valid threshold outside the allowed range is not silently searched or claimed optimal', async () => {
  const result = await searchMaskCandidates(rectangle(0.06), board, { ...quick, currentThreshold: 0.05, candidateThresholds: [0.05, 0.99] });
  assert.equal(result.stoppedReason, 'no_valid_candidate');
  assert.ok(result.attempts.every(a => a.threshold >= 0.1 && a.threshold <= 0.9));
  assert.ok(result.universalWarnings.some(w => /outside this range/.test(w)));
});

test('a narrow valid probability band can be recovered between failed coarse thresholds', async () => {
  const mask = maskOf((x, y) => x >= 10 && x < 70 && y >= 10 && y < 70 ? 0.47 : 0.43);
  const result = await searchMaskCandidates(mask, board, quick);
  assert.ok(result.best);
  assert.equal(result.best.threshold, 0.45);
  assert.ok(result.attempts.some(a => a.stage === 'fine' && a.valid));
});

test('real traced holes survive; high epsilon failures do not suppress lower epsilon recovery', async () => {
  const mask = maskOf((x, y) => x >= 10 && x < 70 && y >= 10 && y < 70 && !(x >= 37 && x < 43 && y >= 37 && y < 43) ? 0.95 : 0.01);
  const result = await searchMaskCandidates(mask, board, { currentEpsilon: 10 });
  assert.ok(result.best);
  assert.ok(result.attempts.some(a => a.epsilon === 10 && !a.valid));
  for (const candidate of result.candidates) {
    assert.equal(candidate.geometry.holes.length, 1);
    assert.equal(candidate.metrics.rawHoleCount, 1);
    assert.equal(candidate.metrics.simplifiedHoleCount, 1);
    assert.ok(candidate.metrics.minimumHoleAreaAgreement > 0);
  }
  assert.ok(result.best.epsilon < 10);
});

test('a stable filled hole remains an explicit semantic blind spot even with a high score', async () => {
  const result = await searchMaskCandidates(rectangle(), board, quick);
  assert.ok(result.best && result.best.score > 95);
  assert.equal(result.best.metrics.rawHoleCount, 0);
  assert.ok(result.universalWarnings.some(w => /fill a real hole/.test(w)));
  assert.ok(result.universalWarnings.some(w => /not a calibrated probability/.test(w)));
  assert.ok(result.universalWarnings.some(w => /Holes and fine features are not guaranteed/.test(w)));
});

test('changing hole topology is explicit and never silently auto-applied', async () => {
  const mask = maskOf((x, y) => {
    if (x < 10 || x >= 70 || y < 10 || y >= 70) return 0.01;
    return x >= 30 && x < 50 && y >= 30 && y < 50 ? 0.55 : 0.95;
  });
  const result = await searchMaskCandidates(mask, board, quick);
  assert.ok(result.candidates.some(c => c.metrics.rawHoleCount === 0));
  assert.ok(result.candidates.some(c => c.metrics.rawHoleCount === 1));
  for (const candidate of result.candidates) {
    assert.equal(candidate.metrics.topologyVariesAcrossThresholds, true);
    assert.equal(candidate.safeToAutoApply, false);
    assert.equal(candidate.grade, 'ambiguous');
    assert.ok(candidate.warnings.some(w => /More holes are not automatically more correct/.test(w)));
  }
});

test('two comparably sized components use discarded pixel area and remain ambiguous', async () => {
  const mask = maskOf((x, y) => y >= 20 && y < 50 && ((x >= 5 && x < 30) || (x >= 45 && x < 70)) ? 0.95 : 0.01);
  const result = await searchMaskCandidates(mask, board, quick);
  assert.ok(result.best);
  assert.equal(result.best.metrics.componentCount, 2);
  assert.equal(result.best.metrics.discardedComponentCount, 1);
  assert.equal(result.best.metrics.discardedAreaRatio, 0.5);
  assert.equal(result.best.safeToAutoApply, false);
  assert.ok(result.best.warnings.some(w => /substantial competing/.test(w)));
  assert.ok(result.best.score < (await searchMaskCandidates(rectangle(), board, quick)).best!.score);
});

test('failed hole-bearing simplifications still warn against silently choosing a hole-free threshold', async () => {
  const mask = maskOf((x, y) => {
    if (x < 10 || x >= 70 || y < 10 || y >= 70) return 0.01;
    return x === 40 && y === 40 ? 0.55 : 0.95;
  });
  const result = await searchMaskCandidates(mask, { ...board, width: 10, height: 10 }, quick);
  assert.ok(result.best);
  assert.ok(result.attempts.some(a => a.threshold >= 0.6 && !a.valid));
  assert.ok(result.candidates.every(c => c.metrics.rawHoleCount === 0));
  assert.ok(result.candidates.every(c => c.metrics.observedHoleCountMax === 1 && c.metrics.topologyVariesAcrossThresholds && !c.safeToAutoApply));
});

test('legitimate small and thin regions are not classified as empty or full', async () => {
  for (const mask of [
    maskOf((x, y) => x >= 30 && x < 36 && y >= 30 && y < 35 ? 0.95 : 0.01),
    maskOf((x, y) => x >= 10 && x < 70 && y >= 35 && y < 37 ? 0.95 : 0.01),
  ]) {
    const result = await searchMaskCandidates(mask, board, quick);
    assert.ok(result.best);
    assert.ok(result.best.metrics.foregroundFraction < 0.02);
    assert.ok(result.best.metrics.regionFidelityIoU > 0.95);
    assert.ok(result.attempts.every(a => !a.invalidReason?.includes('full_foreground') && !a.invalidReason?.includes('empty_foreground')));
  }
});

test('thin bridge and large weak object changes cannot silently promote a tiny strong hotspot', async () => {
  const bridge = maskOf((x, y) => {
    if (y >= 20 && y < 60 && ((x >= 5 && x < 30) || (x >= 50 && x < 75))) return 0.95;
    if (y >= 39 && y < 42 && x >= 30 && x < 50) return 0.52;
    return 0.01;
  });
  const bridgeResult = await searchMaskCandidates(bridge, board, quick);
  assert.ok(bridgeResult.best);
  assert.ok(bridgeResult.candidates.some(c => c.metrics.componentCount === 2));
  assert.ok(bridgeResult.candidates.every(c => !c.safeToAutoApply));
  const hotspot = maskOf((x, y) => {
    if (x >= 30 && x < 36 && y >= 30 && y < 36) return 0.95;
    if (x >= 10 && x < 70 && y >= 10 && y < 70) return 0.45;
    return 0.01;
  });
  const spotResult = await searchMaskCandidates(hotspot, board, quick);
  assert.ok(spotResult.best);
  assert.ok(spotResult.candidates.every(c => c.metrics.regionVariesAcrossThresholds && !c.safeToAutoApply));
});

test('fidelity penalizes erasing a notch without rewarding fewer vertices', async () => {
  const notch = maskOf((x, y) => x >= 10 && x < 70 && y >= 10 && y < 70 && !(x >= 35 && x < 40 && y < 35) ? 0.95 : 0.01);
  const result = await searchMaskCandidates(notch, board, { currentEpsilon: 10 });
  assert.ok(result.best);
  const sameThreshold = result.candidates.filter(c => c.threshold === result.best!.threshold);
  const fine = sameThreshold.find(c => c.epsilon === 0.5)!;
  const coarse = sameThreshold.find(c => c.epsilon === 10);
  assert.ok(fine);
  if (coarse) {
    assert.ok(fine.metrics.regionFidelityIoU >= coarse.metrics.regionFidelityIoU);
    assert.ok(fine.score >= coarse.score);
  }
  assert.equal(result.best.epsilon, 0.5);
});

test('anisotropic board dimensions remain calibrated and epsilon is measured in millimetres', async () => {
  const wideBoard = { ...board, width: 240, height: 40 };
  const result = await searchMaskCandidates(rectangle(), wideBoard, quick);
  assert.ok(result.best);
  const raw = result.best.rawGeometry;
  assert.equal(Math.max(...raw.outer.map(p => p.x)) - Math.min(...raw.outer.map(p => p.x)), 177);
  assert.equal(Math.max(...raw.outer.map(p => p.y)) - Math.min(...raw.outer.map(p => p.y)), 29.5);
  assert.equal(geometryArea(result.best.geometry), 177 * 29.5);
});

test('cancel yields between candidates and retains the best completed result', async () => {
  const controller = new AbortController();
  let progress = 0, lastBestId: string | undefined;
  const result = await searchMaskCandidates(rectangle(), board, {
    currentEpsilon: 4, signal: controller.signal,
    onProgress: p => { progress++; lastBestId = p.best?.id; if (progress === 3) controller.abort(); },
  });
  assert.equal(result.stoppedReason, 'cancelled');
  assert.equal(result.attempts.length, 3);
  assert.equal(result.best?.id, lastBestId);
  assert.ok(result.best);
  const already = await searchMaskCandidates(rectangle(), board, { signal: controller.signal });
  assert.equal(already.attempts.length, 0);
  assert.equal(already.stoppedReason, 'cancelled');
  let ticked = false;
  setTimeout(() => { ticked = true; }, 0);
  await searchMaskCandidates(rectangle(), board, { maxCandidates: 1, onProgress: () => assert.equal(ticked, true) });
});

test('candidate, time, epsilon and suggestion bounds cannot be expanded by caller or advisor', async () => {
  const bounded = await searchMaskCandidates(rectangle(), board, { currentThreshold: NaN, currentEpsilon: Infinity, maxCandidates: 3, candidateThresholds: [-1, 0.123, 0.234, 0.345, 0.456, 0.567, 2] });
  assert.equal(bounded.stoppedReason, 'candidate_limit');
  assert.equal(bounded.attempts.length, 3);
  const hard = await searchMaskCandidates(rectangle(), board, { currentEpsilon: 999, maxCandidates: 999, candidateThresholds: Array.from({ length: 100 }, (_, i) => 0.101 + i * 0.007) });
  assert.ok(hard.attempts.length <= AUTO_TUNE_LIMITS.maximumCandidates);
  assert.ok(hard.attempts.every(a => a.threshold >= 0.1 && a.threshold <= 0.9 && a.epsilon >= 0.5 && a.epsilon <= 10));
  assert.ok(new Set(hard.attempts.filter(a => a.stage === 'guided').map(a => a.threshold)).size <= 4);
  const timed = await searchMaskCandidates(rectangle(), board, { maxElapsedMs: 0 });
  assert.equal(timed.stoppedReason, 'time_limit');
  assert.equal(timed.attempts.length, 0);
});

test('quantized masks rank deterministically, stable IDs deduplicate settings, diagnostics contain no image or key data', async () => {
  const mask = rectangle(), options = { currentThreshold: 0.5, currentEpsilon: 1, candidateThresholds: [0.5, 0.5, 0.333, 0.333] };
  const a = await searchMaskCandidates(mask, board, options), b = await searchMaskCandidates(mask, board, options);
  assert.deepEqual(a.candidates.map(c => [c.id, c.score]), b.candidates.map(c => [c.id, c.score]));
  assert.equal(new Set(a.attempts.map(attempt => attempt.id)).size, a.attempts.length);
  assert.equal(a.best?.threshold, 0.5);
  const diagnostics = candidateSearchDiagnostics(a), json = JSON.stringify(diagnostics);
  for (const forbidden of ['"probabilities":', 'rawGeometry', '"geometry"', 'apiKey', 'data:image', 'base64', 'pixels":[' ]) assert.equal(json.includes(forbidden), false);
  assert.equal(diagnostics.scoring, 'heuristic_not_accuracy');
  diagnostics.candidates[0].metrics.rawHoleCount = 1234;
  assert.notEqual(a.candidates[0].metrics.rawHoleCount, 1234);
});

test('excessive hole complexity is reported without dropping holes or unbounded diagnostics', async () => {
  const perforated = maskOf((x, y) => x >= 3 && x < 77 && y >= 3 && y < 77 && !(x % 4 === 0 && y % 4 === 0) ? 0.95 : 0.01);
  const result = await searchMaskCandidates(perforated, board, { ...quick, maxCandidates: 1 });
  assert.equal(result.candidates.length, 0);
  assert.match(result.attempts[0].invalidReason!, /contour_complexity_limit/);
  assert.match(result.attempts[0].invalidReason!, /No holes or fine features were removed/);
  assert.ok(result.attempts[0].invalidReason!.length < 900);
});
