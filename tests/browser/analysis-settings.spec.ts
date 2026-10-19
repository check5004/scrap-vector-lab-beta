import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { providerStorageKey } from '../../src/key-storage';
import { openDetailsFor, sourceReady } from './legacy-ui';
import { syntheticKeys } from './provider-fixture';

// Layout regressions use the actual app. The manual flow keeps the genuine
// same-origin photograph, markers, ONNX/WASM, probability mask and local search.
// No provider response is needed: every off-origin request fails closed.
const modelHash = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
type Measurement = {
  outer_vertices_mm: { x: number; y: number; id: string }[];
  holes_vertices_mm: { x: number; y: number; id: string }[][];
  total_area_mm2: number;
  board_size_mm: { width_mm: number; height_mm: number };
  provenance: {
    method: string; model_sha256: string; epsilon_mm: number; mask_threshold: number;
    automatic_adjustment?: { candidate_id: string; llm: { status: string } };
  };
};
type Diagnostic = { stages: { id: string; details: Record<string, any> }[] };
type Tuning = {
  selected_candidate_id: string | null;
  local: { attempts: unknown[]; candidates: { id: string; epsilon: number; threshold: number }[]; scoring: string };
  llm: { status: string };
};
let unexpected: string[], errors: string[];
test.beforeEach(async ({ page, context, baseURL }) => {
  unexpected = []; errors = [];
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (new URL(url).origin === origin) await route.continue();
    else { unexpected.push(url); await route.abort('blockedbyclient'); }
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(() => {
  expect(unexpected, 'No external request, including authentication or image-bearing API calls').toEqual([]);
  expect(errors, 'No uncaught browser exceptions').toEqual([]);
});

async function openSource(page: Page) { await page.goto('/'); await sourceReady(page); }
async function download<T>(page: Page, selector = '#exportJson'): Promise<T> {
  if (selector === '#debugExport') await openDetailsFor(page, selector);
  const pending = page.waitForEvent('download'); await page.locator(selector).click();
  const file = await pending, path = await file.path();
  if (!path) throw Error('Expected an actual browser download');
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
async function assertNoHorizontalOverflow(page: Page) {
  const bounds = await page.evaluate(() => {
    const client = document.documentElement.clientWidth;
    const outside = Array.from(document.querySelectorAll<HTMLElement>('.analysis-card button, .analysis-card input, .analysis-card select, .analysis-card summary'))
      .filter(node => node.getClientRects().length > 0)
      .map(node => ({ id: node.id || node.className || node.tagName, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left < -1 || rect.right > client + 1)
      .map(({ id, rect }) => ({ id, left: rect.left, right: rect.right }));
    return { scroll: document.documentElement.scrollWidth, client, outside };
  });
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
  expect(bounds.outside, 'All visible analysis controls remain horizontally reachable').toEqual([]);
}
async function manualValue(page: Page, id: 'epsilon' | 'threshold', value: string) {
  await expect(page.locator(`#analysisSettings #${id}`)).toBeVisible();
  await page.locator(`#${id}`).evaluate((node, next) => {
    const input = node as HTMLInputElement;
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expect(page.locator(`#${id}`)).toHaveValue(value);
  await expect(page.locator('#exportJson')).toBeEnabled();
  await expect(page.locator('#tuneCandidates [data-apply-candidate]')).toHaveCount(0);
  await expect(page.locator('#tuneDetails')).toHaveText('未実行');
  await expect(page.locator('#tuneBefore')).toBeHidden();
  await expect(page.locator('#tuneRestore')).toBeDisabled();
  await expect(page.locator('#reviewRun')).toBeDisabled();
  await expect(page.locator('#reviewConsent')).not.toBeChecked();
  const output = await download<Measurement>(page);
  expect(output.provenance.automatic_adjustment).toBeUndefined();
  expect(output.provenance.epsilon_mm).toBe(Number(await page.locator('#epsilon').inputValue()));
  expect(output.provenance.mask_threshold).toBe(Number(await page.locator('#threshold').inputValue()));
  return output;
}

test('02 owns one collapsed analysis-settings panel; toggles and provider settings never start analysis or send data', async ({ page }, info) => {
  // Synthetic keys in this fresh browser context make "saved key" behavior
  // observable without consulting a real user's storage or credentials.
  await page.addInitScript(entries => {
    for (const { slot, provider, key } of entries) localStorage.setItem(slot, JSON.stringify({ version: 1, provider, key }));
  }, (['openrouter', 'openai'] as const).map(provider => ({ slot: providerStorageKey(provider)!, provider, key: syntheticKeys[provider] })));
  await openSource(page);
  const settings = page.locator('#analysisSettings'), card = page.locator('section.analysis-card');
  const movedIds = ['epsilon', 'epsilonValue', 'threshold', 'thresholdValue', 'gridstep', 'tunePanel', 'autoTune', 'autoRecover', 'tuneStop', 'tuneRestore', 'tuneCandidates', 'tuneDetails', 'reviewConsent', 'reviewRun', 'reviewKeys', 'reviewStatus', 'reviewUsage'];
  const nearbyIds = ['analysisMethod', 'autoReviewSettings', 'autoReview', 'reviewMaxCalls', 'analyze', 'configureKey', 'apiSettings', 'provider', 'apiKey'];
  const resultIds = ['measurementCalibration', 'calibrationEdge', 'calibrationLength', 'applyCalibration', 'clearCalibration', 'exportSvg', 'exportDxf', 'exportJson'];
  await expect(card.locator('.step-number')).toHaveText('02');
  await expect(page.locator('.result-card .step-number')).toHaveText('03');
  await expect(page.locator('details#analysisSettings')).toHaveCount(1);
  await expect(card.locator('#analysisSettings')).toHaveCount(1);
  for (const id of [...movedIds, ...nearbyIds, ...resultIds]) await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
  for (const id of movedIds) {
    await expect(settings.locator(`#${id}`)).toHaveCount(1);
    await expect(page.locator(`#advancedDiagnostics #${id}`)).toHaveCount(0);
    await expect(page.locator(`.result-card #${id}`)).toHaveCount(0);
  }
  for (const id of nearbyIds) {
    await expect(card.locator(`#${id}`)).toHaveCount(1);
    await expect(settings.locator(`#${id}`)).toHaveCount(0);
  }
  for (const id of resultIds) {
    await expect(page.locator(`.result-card #${id}`)).toHaveCount(1);
    await expect(card.locator(`#${id}`)).toHaveCount(0);
  }
  expect(await settings.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('#analyze')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(settings).not.toHaveAttribute('open', '');
  await expect(page.locator('#advancedDiagnostics')).not.toHaveAttribute('open', '');
  await expect(page.locator('#autoRecover')).toBeChecked();
  await expect(page.locator('#autoReview')).not.toBeChecked();
  await expect(page.locator('#reviewMaxCalls')).toHaveValue('2');
  await expect(page.locator('#reviewMaxCalls option')).toHaveText(['1回', '2回', '3回']);
  for (const id of ['epsilon', 'threshold', 'autoTune', 'autoRecover', 'reviewRun']) await expect(page.locator(`#${id}`)).toBeHidden();
  for (const id of ['autoReview', 'reviewMaxCalls', 'analyze']) await expect(page.locator(`#${id}`)).toBeVisible();
  for (const [id, minimum, maximum, initial] of [['epsilon', '0.5', '10', '1'], ['threshold', '0.1', '0.9', '0.5']]) {
    await expect(page.locator(`#${id}`)).toHaveAttribute('type', 'range');
    await expect(page.locator(`#${id}`)).toHaveAttribute('min', minimum);
    await expect(page.locator(`#${id}`)).toHaveAttribute('max', maximum);
    await expect(page.locator(`#${id}`)).toHaveAttribute('step', '0.001');
    await expect(page.locator(`#${id}`)).toHaveValue(initial);
  }
  const widths = info.project.name === 'mobile' ? [320, 393] : [1280];
  for (const width of widths) {
    await page.setViewportSize({ width, height: info.project.name === 'mobile' ? 740 : 900 });
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`analysis-settings-${width}-collapsed.png`), fullPage: true });
    await settings.locator(':scope > summary').click();
    await expect(settings).toHaveAttribute('open', '');
    for (const id of ['epsilon', 'threshold', 'autoTune', 'autoRecover']) await expect(page.locator(`#${id}`)).toBeVisible();
    await openDetailsFor(page, '#gridstep');
    await openDetailsFor(page, '#reviewRun');
    await openDetailsFor(page, '#tuneDetails');
    await assertNoHorizontalOverflow(page);
    await card.screenshot({ path: info.outputPath(`analysis-settings-${width}-expanded-02.png`) });
    await settings.locator(':scope > summary').click();
    await expect(settings).not.toHaveAttribute('open', '');
  }
  await page.locator('#autoReview').check();
  await page.locator('#reviewMaxCalls').selectOption('3');
  await expect(page.locator('#analysisDisclosure')).toContainText('最大3回');
  await page.locator('#configureKey').click();
  await expect(page.locator('#apiKey')).toHaveValue(syntheticKeys.openrouter);
  await page.locator('#provider').selectOption('openai');
  await expect(page.locator('#apiKey')).toHaveValue(syntheticKeys.openai);
  await expect(page.locator('#analysisDisclosure')).toContainText('OpenAI');
  await page.locator('#closeKeySettings').click();
  await openDetailsFor(page, '#reviewRun');
  await page.locator('#reviewConsent').check();
  await page.locator('#autoRecover').uncheck(); await page.locator('#autoRecover').check();
  await page.locator('#gridstep').selectOption('25');
  await expect(page.locator('#reviewRun')).toBeDisabled();
  await page.locator('#reviewConsent').uncheck();
  await page.locator('#autoReview').uncheck();
  await settings.locator(':scope > summary').click();
  await expect(page.locator('#journey-root')).toHaveAttribute('data-stage', 'source');
  await expect(page.locator('#area')).toHaveText('—');
  await expect(page.locator('#exportJson')).toBeDisabled();
  await expect(page.locator('#advancedDiagnostics')).not.toHaveAttribute('open', '');
  await expect(page.locator('#apiSettings')).not.toHaveAttribute('open', '');
  await assertNoHorizontalOverflow(page);
});

test('02 manual controls revectorize the genuine mask, clear stale search provenance, and preserve candidate restore', async ({ page }, info) => {
  test.setTimeout(320_000);
  await openSource(page);
  await page.locator('#analyze').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'complete', { timeout: 200_000 });
  await expect(page.locator('#exportJson')).toBeEnabled();
  await expect(page.locator('#analysisSettings')).not.toHaveAttribute('open', '');
  const initial = await download<Measurement>(page);
  const before = await download<Diagnostic>(page, '#debugExport');
  const probability = before.stages.find(stage => stage.id === 'probability');
  expect(initial.provenance.method).toBe('U2NetP-ONNX-WASM');
  expect(initial.provenance.model_sha256).toBe(modelHash);
  expect(probability?.details.model_sha256).toBe(modelHash);
  expect(probability?.details.timings_ms.inference).toBeGreaterThan(0);
  await page.locator('#advancedDiagnostics > summary').click();
  await openDetailsFor(page, '#epsilon');
  await expect(page.locator('#tuneCandidates [data-apply-candidate]').first()).toBeVisible();
  // A real input event follows the moved control's original handler. No mask,
  // contour, search result or provider evaluation is injected.
  const manual = await manualValue(page, 'epsilon', '0.501');
  expect(manual.board_size_mm).toEqual(initial.board_size_mm);
  expect(manual.provenance.model_sha256).toBe(modelHash);
  await expect(page.locator('#methodB')).toBeChecked();
  await expect(page.locator('#journey-root')).toHaveAttribute('data-method', 'B');
  await page.locator('#autoTune').click();
  await expect(page.locator('#autoTune')).toBeEnabled({ timeout: 60_000 });
  const tuning = JSON.parse(await page.locator('#tuneDetails').textContent() ?? 'null') as Tuning;
  expect(tuning.local.attempts.length).toBeGreaterThan(0); expect(tuning.local.attempts.length).toBeLessThanOrEqual(80);
  expect(tuning.local.scoring).toBe('heuristic_not_accuracy');
  expect(tuning.llm.status).toBe('not_executed');
  const candidateId = await page.locator('#analysisSettings [data-apply-candidate]').first().getAttribute('data-apply-candidate');
  const candidate = tuning.local.candidates.find(item => item.id === candidateId);
  expect(candidate).toBeDefined();
  await page.locator(`#analysisSettings [data-apply-candidate="${candidateId}"]`).click();
  const applied = await download<Measurement>(page);
  expect(applied.provenance.automatic_adjustment?.candidate_id).toBe(candidateId);
  expect(applied.provenance.epsilon_mm).toBe(candidate!.epsilon);
  expect(applied.provenance.mask_threshold).toBe(candidate!.threshold);
  await expect(page.locator('#analysisSettings #tuneBefore')).toBeVisible();
  await openDetailsFor(page, '#reviewRun');
  await openDetailsFor(page, '#tuneDetails');
  await page.locator('#journeySkip').click();
  for (const width of info.project.name === 'mobile' ? [320, 393] : [1280]) {
    await page.setViewportSize({ width, height: info.project.name === 'mobile' ? 740 : 900 });
    await assertNoHorizontalOverflow(page);
    await page.locator('section.analysis-card').screenshot({ path: info.outputPath(`analysis-settings-${width}-real-candidates-expanded-02.png`) });
  }
  await page.locator('#tuneRestore').click();
  const restored = await download<Measurement>(page);
  expect(restored.outer_vertices_mm).toEqual(manual.outer_vertices_mm);
  expect(restored.holes_vertices_mm).toEqual(manual.holes_vertices_mm);
  expect(restored.total_area_mm2).toBe(manual.total_area_mm2);
  expect(restored.provenance).toEqual(manual.provenance);
  await expect(page.locator('#tuneCandidates [data-apply-candidate]').first()).toBeEnabled();
  // Seed actual candidate provenance again so the second moved range must
  // clear it too, rather than merely asserting an already-empty record.
  await page.locator('#tuneCandidates [data-apply-candidate]').first().click();
  const threshold = await manualValue(page, 'threshold', '0.501');
  expect(threshold.board_size_mm).toEqual(initial.board_size_mm);
  const after = await download<Diagnostic>(page, '#debugExport');
  expect(after.stages.find(stage => stage.id === 'probability')).toEqual(probability);
  expect(after.stages.find(stage => stage.id === 'rectified')).toEqual(before.stages.find(stage => stage.id === 'rectified'));
  expect(after.stages.some(stage => stage.id === 'tuning')).toBe(false);
  expect(after.stages.find(stage => stage.id === 'polygon')?.details.epsilon_mm).toBe(threshold.provenance.epsilon_mm);
  expect(after.stages.find(stage => stage.id === 'binary')?.details.threshold).toBe(0.501);
  await page.locator('#advancedDiagnostics > summary').click();
  await page.locator('#analysisSettings > summary').click();
  await expect(page.locator('#analysisSettings')).not.toHaveAttribute('open', '');
  await expect(page.locator('#exportJson')).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('analysis-settings-real-result-collapsed.png'), fullPage: true });
});

test('failure Settings opens 02 analysis settings while a missing key still opens its own nearby panel', async ({ page }) => {
  await openSource(page);
  await page.locator('#methodA').check();
  await page.locator('#analyze').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'error');
  await page.locator('#closeKeySettings').click();
  await page.locator('#failureSettings').click();
  await expect(page.locator('#apiSettings')).toHaveAttribute('open', '');
  await expect(page.locator('#analysisSettings')).not.toHaveAttribute('open', '');
  await page.locator('#closeKeySettings').click();
  await page.locator('#methodB').check();
  // A deliberately markerless input reaches a genuine calibration failure.
  // It is a failure fixture, never evidence of neural/model accuracy.
  await page.locator('#file').setInputFiles({
    name: 'settings-recovery-no-markers.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="white"/></svg>'),
  });
  await sourceReady(page);
  await page.locator('#analyze').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#analysisFailure')).toBeVisible();
  await page.locator('#failureSettings').click();
  await expect(page.locator('#analysisSettings')).toHaveAttribute('open', '');
  await expect(page.locator('#analysisSettings #epsilon')).toBeVisible();
  await expect(page.locator('#advancedDiagnostics')).not.toHaveAttribute('open', '');
  await expect(page.locator('#apiSettings')).not.toHaveAttribute('open', '');
  await expect(page.locator('#exportJson')).toBeDisabled();
  await assertNoHorizontalOverflow(page);
});
