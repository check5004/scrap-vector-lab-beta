import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openDetailsFor, sourceReady } from './legacy-ui';
import { providerStorageKey } from '../../src/key-storage';
import { endpoints, mockProvider, syntheticKeys, testShape, testReview, type TestProvider } from './provider-fixture';

type Measurement = { outer_vertices_mm: { x: number; y: number }[]; holes_vertices_mm: { x: number; y: number }[][]; total_area_mm2: number; provenance: Record<string, any> };
type Diagnostic = { stages: { id: string; details: Record<string, any> }[] };
const modelHash = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const analysisTimeout = 200_000;
let unexpected: string[], errors: string[];
test.beforeEach(async ({ page, context, baseURL }) => {
  unexpected = []; errors = [];
  const origin = new URL(baseURL!).origin;
  // The exact TEST-ONLY page handlers override this fail-closed context route.
  // Genuine same-origin ONNX/WASM/photos are never replaced.
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (new URL(url).origin === origin) await route.continue();
    else { unexpected.push(url); await route.abort('blockedbyclient'); }
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(() => {
  expect(unexpected, 'Unexpected external traffic is blocked and fails the test').toEqual([]);
  expect(errors, 'No uncaught browser errors').toEqual([]);
});
async function openSource(page: Page) { await page.goto('/'); await sourceReady(page); }
async function downloadText(page: Page, selector: string): Promise<string> {
  if (selector === '#debugExport') await openDetailsFor(page, selector);
  const pending = page.waitForEvent('download'); await page.locator(selector).click();
  const file = await pending, path = await file.path();
  if (!path) throw Error('Expected an actual browser download');
  return readFile(path, 'utf8');
}
async function download<T>(page: Page, selector = '#exportJson'): Promise<T> {
  return JSON.parse(await downloadText(page, selector)) as T;
}
async function configureKey(page: Page, selected: TestProvider = 'openrouter') {
  await page.locator('#configureKey').click();
  await expect(page.locator('#apiSettings')).toHaveAttribute('open', '');
  await page.locator('#provider').selectOption(selected);
  await page.locator('#apiKey').fill(syntheticKeys[selected]);
}
async function complete(page: Page, method: 'A' | 'B') {
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'complete', { timeout: analysisTimeout });
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-method', method);
  await expect(page.locator('#analyze')).toBeEnabled();
  await expect(page.locator('#area')).not.toHaveText('—');
  await expect(page.locator('#exportJson')).toBeEnabled();
  await expect(page.locator('#journey-root')).toHaveAttribute('data-stage', 'dimensions');
  await expect(page.locator('#journeyOverlay [data-mm]').first()).toBeAttached();
}
async function expectGeometry(page: Page, measurement: Measurement) {
  const raw = await page.locator('#journeyOverlay [data-contour="simplified"]').getAttribute('data-geometry-mm');
  const geometry = JSON.parse(raw!);
  expect(geometry.outer.map(({ x, y }: { x: number; y: number }) => ({ x, y }))).toEqual(measurement.outer_vertices_mm.map(({ x, y }) => ({ x, y })));
  expect(geometry.holes.map((ring: { x: number; y: number }[]) => ring.map(({ x, y }) => ({ x, y })))).toEqual(measurement.holes_vertices_mm.map(ring => ring.map(({ x, y }) => ({ x, y }))));
  expect(Number((await page.locator('#area').innerText()).replaceAll(',', ''))).toBe(Math.round(measurement.total_area_mm2));
}

test('default B is source-only until one Analyze click runs real inference and local search through dimensions', async ({ page }, info) => {
  test.setTimeout(260_000);
  // A restored provider key cannot opt B into image transmission.
  await page.addInitScript(({ slot, key }) => localStorage.setItem(slot, JSON.stringify({ version: 1, provider: 'openrouter', key })), { slot: providerStorageKey('openrouter')!, key: syntheticKeys.openrouter });
  await openSource(page);
  await expect(page.locator('#apiKey')).toHaveValue(syntheticKeys.openrouter);
  await expect(page.locator('#methodB')).toBeChecked();
  await expect(page.locator('#methodA')).not.toBeChecked();
  await expect(page.locator('#autoReview')).not.toBeChecked();
  await expect(page.locator('#advancedDiagnostics')).not.toHaveAttribute('open', '');
  await expect(page.locator('#advancedSettings')).not.toHaveAttribute('open', '');
  await expect(page.locator('#apiSettings')).not.toHaveAttribute('open', '');
  for (const selector of ['#runA', '#runB', '#rectify', '#autoTune', '#reviewRun', '#journeyRun']) await expect(page.locator(selector)).toBeHidden();
  await expect(page.locator('#journey-root')).toHaveAttribute('data-stage', 'source');
  await expect(page.locator('#area')).toHaveText('—');
  await expect(page.locator('#exportJson')).toBeDisabled();
  await expect(page.locator('[data-journey-step="markers"]')).toHaveCount(0);
  await expect(page.locator('[data-journey-step="mask"]')).toHaveCount(0);
  await page.locator('#analyze').click();
  await complete(page, 'B');
  await expect(page.locator('#advancedDiagnostics')).not.toHaveAttribute('open', '');
  await expect(page.locator('[data-journey-step="mask"]')).toHaveCount(1);
  const output = await download<Measurement>(page);
  expect(output.provenance.method).toBe('U2NetP-ONNX-WASM');
  expect(output.provenance.model_sha256).toBe(modelHash);
  await expectGeometry(page, output);
  const tuning = JSON.parse(await page.locator('#tuneDetails').textContent() ?? 'null');
  expect(tuning.local.attempts.length).toBeGreaterThan(0); expect(tuning.local.attempts.length).toBeLessThanOrEqual(80);
  expect(tuning.local.scoring).toBe('heuristic_not_accuracy');
  expect(tuning.llm.status).toBe('not_executed');
  await expect(page.locator('#warnings')).toContainText('穴');
  await page.screenshot({ path: info.outputPath('one-click-real-B-dimensions.png'), fullPage: true });
  const report = await download<Diagnostic>(page, '#debugExport');
  const neural = report.stages.find(stage => stage.id === 'probability')!;
  expect(neural.details.timings_ms.inference).toBeGreaterThan(0);
  expect(neural.details.model_sha256).toBe(modelHash);
  expect(report.stages.some(stage => stage.id === 'tuning')).toBe(true);
});

for (const provider of ['openrouter', 'openai'] as const) {
  test(`one Analyze click uses selected ${provider} test-only A response and direct vertices without a neural mask`, async ({ page }, info) => {
    const api = await mockProvider(page, provider, 'shape');
    await openSource(page); await page.locator('#methodA').check();
    const source = await page.locator('#sourceLabel').textContent();
    await page.locator('#analyze').click();
    await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('#apiSettings')).toHaveAttribute('open', '');
    await expect(page.locator('#sourceLabel')).toHaveText(source!);
    await expect(page.locator('#methodA')).toBeChecked(); expect(api.calls).toHaveLength(0);
    await configureKey(page, provider);
    // Inherited diagnostic stepping cannot split the primary user flow.
    await openDetailsFor(page, '#debugStep'); await page.locator('#debugStep').check();
    await page.locator('#advancedDiagnostics > summary').click();
    await expect(page.locator('#consent')).not.toBeChecked();
    await expect(page.locator('#reviewConsent')).not.toBeChecked();
    await expect(page.locator('#analysisDisclosure')).toContainText(provider === 'openrouter' ? 'OpenRouter' : 'OpenAI');
    await expect(page.locator('#analysisDisclosure')).toContainText('有料');
    expect(api.calls).toHaveLength(0);
    await page.locator('#analyze').click(); await complete(page, 'A');
    await expect(page.locator('#debugStep')).not.toBeChecked();
    await expect(page.locator('#apiSettings')).not.toHaveAttribute('open', '');
    await expect(page.locator('#advancedDiagnostics')).not.toHaveAttribute('open', '');
    for (const id of ['mask', 'tuning']) await expect(page.locator(`[data-journey-step="${id}"]`)).toHaveCount(0);
    const output = await download<Measurement>(page);
    expect(output.outer_vertices_mm.map(({ x, y }) => ({ x, y }))).toEqual(testShape.outer_vertices_mm);
    expect(output.provenance.provider).toBe(provider);
    expect(output.provenance.model_sha256).toBeUndefined();
    await expectGeometry(page, output);
    expect(api.inferenceCalls()).toBe(1);
    expect(api.calls.map(call => call.url)).toEqual([endpoints[provider].auth, endpoints[provider].models, endpoints[provider].inference].filter(Boolean));
    await page.screenshot({ path: info.outputPath(`one-click-A-${provider}-TEST-ONLY.png`), fullPage: true });
    const report = await download<Diagnostic>(page, '#debugExport');
    expect(report.stages.some(stage => stage.id === 'api')).toBe(true);
    expect(report.stages.some(stage => ['probability', 'binary', 'contours', 'tuning'].includes(stage.id))).toBe(false);
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_UNIFIED_BROWSER_TEST_ONLY');
  });
}

test('same-image A/B switching restores matching cached metrics and journey; changing the source clears both', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Cache state matrix once; both single-run methods also run on mobile');
  test.setTimeout(260_000);
  const api = await mockProvider(page, 'openrouter', 'shape');
  await openSource(page); await page.locator('#analyze').click(); await complete(page, 'B');
  const b = await download<Measurement>(page);
  await page.locator('#methodA').check(); await expect(page.locator('#area')).toHaveText('—');
  await configureKey(page); await page.locator('#analyze').click(); await complete(page, 'A');
  const a = await download<Measurement>(page); expect(a.outer_vertices_mm).not.toEqual(b.outer_vertices_mm);
  const requests: string[] = []; page.on('request', request => requests.push(request.url()));
  for (const [method, measurement] of [['B', b], ['A', a], ['B', b]] as const) {
    await page.locator(`#method${method}`).check();
    const cached = await download<Measurement>(page);
    expect(cached.outer_vertices_mm).toEqual(measurement.outer_vertices_mm);
    expect(cached.provenance).toEqual(measurement.provenance);
    await expectGeometry(page, cached);
    await expect(page.locator('[data-journey-step="mask"]')).toHaveCount(method === 'B' ? 1 : 0);
  }
  expect(api.inferenceCalls()).toBe(1); expect(requests).toEqual([]);
  // Expert B-only actions must also keep method radios, scene and metrics in sync.
  const assertB = async () => {
    await expect(page.locator('#methodB')).toBeChecked(); await expect(page.locator('#methodA')).not.toBeChecked();
    await expect(page.locator('[data-mode="B"]')).toHaveClass(/active/);
    await expect(page.locator('#analysisSummary')).toHaveAttribute('data-method', 'B');
    await expect(page.locator('#journey-root')).toHaveAttribute('data-method', 'B');
    await expect(page.locator('#journeyOverlay [data-contour="simplified"]')).toHaveAttribute('data-geometry-source', 'simplified-mask-contour');
    const output = await download<Measurement>(page); expect(output.provenance.method).toBe('U2NetP-ONNX-WASM');
    await expectGeometry(page, output);
  };
  for (const id of ['epsilon', 'threshold']) {
    await page.locator('#methodA').check(); await openDetailsFor(page, `#${id}`);
    await page.locator(`#${id}`).evaluate(node => {
      const input = node as HTMLInputElement;
      const value = Number(input.value), maximum = Number(input.max);
      input.value = String(value + 0.001 <= maximum ? value + 0.001 : value - 0.001);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#autoTune')).toBeEnabled(); await assertB();
  }
  await page.locator('#methodA').check(); await page.locator('#autoTune').click();
  await expect(page.locator('#autoTune')).toBeEnabled({ timeout: 45_000 }); await assertB();
  await expect(page.locator('[data-apply-candidate]').first()).toBeEnabled();
  await page.locator('#methodA').check(); await page.locator('[data-apply-candidate]').first().click(); await assertB();
  expect(api.inferenceCalls()).toBe(1); expect(requests).toEqual([]);
  await openDetailsFor(page, '[data-sample="notched"]'); await page.locator('[data-sample="notched"]').click(); await sourceReady(page);
  for (const method of ['A', 'B']) {
    await page.locator(`#method${method}`).check();
    await expect(page.locator('#area')).toHaveText('—'); await expect(page.locator('#exportJson')).toBeDisabled();
    for (const stage of ['mask', 'contour', 'dimensions']) await expect(page.locator(`[data-journey-step="${stage}"]`)).toHaveCount(0);
  }
});

test('saved key alone leaves B review off; opt-in Analyze includes the bounded test-only review loop', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Real inference plus review accounting matrix once'); test.setTimeout(600_000);
  let release!: () => void; const heldReview = new Promise<void>(resolve => { release = resolve; });
  let releaseRepeat!: () => void; const heldRepeat = new Promise<void>(resolve => { releaseRepeat = resolve; });
  const api = await mockProvider(page, 'openrouter', 'review', (round, candidates) => ({ review: testReview(candidates, round === 1 ? 0.7 : 0.4), ...(round === 3 ? { release: heldReview } : round === 4 ? { release: heldRepeat } : {}) }));
  await openSource(page); await page.locator('#methodA').check(); await configureKey(page);
  await page.reload(); await sourceReady(page);
  await expect(page.locator('#apiKey')).toHaveValue(syntheticKeys.openrouter);
  await expect(page.locator('#methodB')).toBeChecked(); await expect(page.locator('#autoReview')).not.toBeChecked();
  expect(api.calls).toHaveLength(0);
  await page.locator('#autoReview').check(); await page.locator('#reviewMaxCalls').selectOption('2');
  await expect(page.locator('#reviewMaxCalls option')).toHaveText(['1回', '2回', '3回']);
  await expect(page.locator('#analysisDisclosure')).toContainText('最大2回');
  await expect(page.locator('#reviewConsent')).not.toBeChecked(); await expect(page.locator('#consent')).not.toBeChecked();
  await page.locator('#analyze').click(); await complete(page, 'B');
  expect(api.batches).toHaveLength(2); expect(api.inferenceCalls()).toBe(2);
  const tuning = JSON.parse(await page.locator('#tuneDetails').textContent() ?? 'null');
  expect(tuning.llm.attempts).toHaveLength(2); expect(tuning.llm.reason).toBe('plateau');
  expect(tuning.llm.evaluation.match_score).toBe(0.7);
  await expect(page.locator('#reviewUsage')).toContainText('API評価試行 2回');
  await expect(page.locator('#reviewUsage')).toContainText('料金不明 2回');
  const measured = await download<Measurement>(page); await expectGeometry(page, measured);
  const report = await download<Diagnostic>(page, '#debugExport');
  expect(report.stages.find(stage => stage.id === 'probability')?.details.timings_ms.inference).toBeGreaterThan(0);
  // A fresh source has no previous snapshot. Cancel only after its genuine
  // local B geometry exists and the optional remote review is held in the stub.
  await openDetailsFor(page, '[data-sample="notched"]'); await page.locator('[data-sample="notched"]').click(); await sourceReady(page);
  await page.locator('#autoReview').check(); await page.locator('#analyze').click();
  await expect.poll(api.inferenceCalls, { timeout: analysisTimeout }).toBe(3);
  await page.locator('#analysisCancel').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'cancelled');
  await expect(page.locator('#analysisFailureMessage')).toContainText('ここまでに取得した輪郭');
  await expect(page.locator('#analysisFailureMessage')).toContainText('未完了の工程');
  await expect(page.locator('#journey-root')).toHaveAttribute('data-stage', 'dimensions');
  await expect(page.locator('#journey-root')).toHaveAttribute('data-processing', 'cancelled');
  await expect(page.locator('#exportJson')).toBeEnabled();
  const partial = await download<Measurement>(page);
  expect(partial.provenance.method).toBe('U2NetP-ONNX-WASM'); expect(partial.provenance.source_image).toBe('notched');
  expect(partial.provenance.pipeline_completion).toBe('partial_cancelled');
  await expectGeometry(page, partial);
  const cancelled = JSON.parse(await page.locator('#tuneDetails').textContent() ?? 'null');
  expect(cancelled.llm.reason).toBe('cancelled'); expect(cancelled.llm.status).toBe('not_evaluated');
  expect(cancelled.llm.attempts).toHaveLength(1); expect(cancelled.llm.attempts[0].inferenceSent).toBe(true);
  expect(cancelled.llm.unknown_cost_attempts).toBe(1);
  await expect(page.locator('#reviewUsage')).toContainText('API評価試行 1回');
  await expect(page.locator('#reviewUsage')).toContainText('料金不明 1回');
  release(); await expect.poll(api.settledResponses).toBe(3);
  expect(api.inferenceCalls()).toBe(3); await expectGeometry(page, partial);
  expect((await download<Measurement>(page)).provenance.pipeline_completion).toBe('partial_cancelled');
  // A repeat now has a prior B snapshot. Its new billable attempt must survive
  // rollback in diagnostics without being attached to the old measurement.
  await page.locator('#analyze').click();
  await expect.poll(api.inferenceCalls, { timeout: analysisTimeout }).toBe(4);
  await page.locator('#analysisCancel').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'cancelled');
  await expect(page.locator('#analysisFailureMessage')).toContainText('前回の解析結果を保持');
  await expect(page.locator('#journey-root')).toHaveAttribute('data-stage', 'dimensions');
  await expectGeometry(page, partial);
  const restored = await download<Measurement>(page);
  expect(restored.outer_vertices_mm).toEqual(partial.outer_vertices_mm); expect(restored.provenance).toEqual(partial.provenance);
  const accounting = JSON.parse(await page.locator('#tuneDetails').textContent() ?? 'null');
  expect(accounting.llm.applied).toBe(false); expect(accounting.llm.restored_previous_result).toBe(true);
  expect(accounting.llm.reason).toBe('cancelled'); expect(accounting.llm.attempts).toHaveLength(1);
  expect(accounting.llm.attempts[0].inferenceSent).toBe(true); expect(accounting.llm.unknown_cost_attempts).toBe(1);
  await expect(page.locator('#reviewUsage')).toContainText('API評価試行 1回');
  await expect(page.locator('#reviewUsage')).toContainText('料金不明 1回');
  releaseRepeat(); await expect.poll(api.settledResponses).toBe(4);
  expect(api.inferenceCalls()).toBe(4); await expectGeometry(page, partial);
});

test('primary cancel rejects a late test-only response, source replacement clears state, and retry succeeds', async ({ page }, info) => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let releaseRetry!: () => void; const heldRetry = new Promise<void>(resolve => { releaseRetry = resolve; });
  const api = await mockProvider(page, 'openrouter', 'shape', round => round === 1 ? { release: held } : round === 3 ? { release: heldRetry } : {});
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 393, height: 740 });
  await openSource(page); await page.locator('#methodA').check(); await configureKey(page);
  await page.locator('#analyze').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('primary-start-viewport-TEST-ONLY.png'), fullPage: false });
  await page.locator('#analyze').click(); await expect.poll(api.inferenceCalls).toBe(1);
  // The application scrolls once on explicit start. Do not scroll either target:
  // the actual progress and primary cancel must be simultaneously reachable.
  await expect(page.locator('#analysisCancel')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#analysisProgress')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#analysisProgress')).toContainText('推論');
  const viewport = page.viewportSize()!;
  for (const selector of ['#analysisCancel', '#analysisProgress']) {
    const box = await page.locator(selector).boundingBox(); expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    if (selector === '#analysisCancel') expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath('primary-running-viewport-TEST-ONLY.png'), fullPage: false });
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'running');
  for (const selector of ['#analyze', '#methodA', '#methodB', '#upload', '#camera']) await expect(page.locator(selector)).toBeDisabled();
  await expect(page.locator('#analysisCancel')).toBeVisible(); await page.locator('#analysisCancel').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'cancelled');
  await expect(page.locator('#analysisFailure')).toBeVisible(); await expect(page.locator('#retryAnalysis')).toBeEnabled();
  await expect(page.locator('#exportJson')).toBeDisabled();
  await openDetailsFor(page, '[data-sample="notched"]'); await page.locator('[data-sample="notched"]').click(); await sourceReady(page);
  release();
  await expect.poll(api.settledResponses).toBe(1);
  await expect(page.locator('#area')).toHaveText('—'); await expect(page.locator('#exportJson')).toBeDisabled();
  await expect(page.locator('[data-journey-step="dimensions"]')).toHaveCount(0);
  await page.locator('#analyze').click(); await complete(page, 'A');
  await page.screenshot({ path: info.outputPath('primary-result-viewport-TEST-ONLY.png'), fullPage: false });
  const output = await download<Measurement>(page); expect(output.provenance.source_image).toBe('notched');
  expect(api.inferenceCalls()).toBe(2); await expectGeometry(page, output);
  // A cancelled repeat must restore the completed polygon in the scene too.
  await page.locator('#analyze').click(); await expect.poll(api.inferenceCalls).toBe(3);
  await page.locator('#analysisCancel').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'cancelled');
  await expect(page.locator('#journey-root')).toHaveAttribute('data-stage', 'dimensions');
  await expect(page.locator('#analysisFailureMessage')).toContainText('前回の解析結果を保持');
  await expectGeometry(page, output); await expect(page.locator('#exportJson')).toBeEnabled();
  const restored = await download<Measurement>(page);
  expect(restored.outer_vertices_mm).toEqual(output.outer_vertices_mm); expect(restored.provenance).toEqual(output.provenance);
  releaseRetry(); await expect.poll(api.settledResponses).toBe(3);
  await expectGeometry(page, output);
});

test('failed primary A shows a safe actionable error and the retry button repeats only that selected method', async ({ page }) => {
  const api = await mockProvider(page, 'openai', 'shape', round => round === 1 || round === 3 ? { status: 503 } : {});
  await openSource(page); await page.locator('#methodA').check(); await configureKey(page, 'openai');
  await page.locator('#analyze').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#analysisFailure')).toBeVisible(); await expect(page.locator('#analysisFailureMessage')).toContainText('503');
  await expect(page.locator('body')).not.toContainText('TEST_ONLY_PRIVATE_PROVIDER_BODY');
  await expect(page.locator('#exportJson')).toBeDisabled();
  expect(api.inferenceCalls()).toBe(1);
  await page.locator('#retryAnalysis').click(); await complete(page, 'A');
  expect(api.inferenceCalls()).toBe(2); await expect(page.locator('#analysisFailure')).toBeHidden();
  await expect(page.locator('[data-journey-step="mask"]')).toHaveCount(0);
  const completed = await download<Measurement>(page);
  await page.locator('#analyze').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#analysisFailureMessage')).toContainText('前回の解析結果を保持');
  await expect(page.locator('#journey-root')).toHaveAttribute('data-stage', 'dimensions');
  await expectGeometry(page, completed); await expect(page.locator('#exportJson')).toBeEnabled();
  const retained = await download<Measurement>(page);
  expect(retained.outer_vertices_mm).toEqual(completed.outer_vertices_mm); expect(retained.provenance).toEqual(completed.provenance);
  expect(api.inferenceCalls()).toBe(3);
});

test('320px and 393px mobile layouts keep primary controls reachable with advanced stages collapsed', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Touch viewport layout');
  await openSource(page);
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 740 });
    for (const selector of ['#upload', '#camera', 'label[for="methodA"]', 'label[for="methodB"]', '#analyze']) {
      const control = page.locator(selector); await control.scrollIntoViewIfNeeded(); await expect(control).toBeVisible();
      const box = await control.boundingBox(); expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('#advancedDiagnostics')).not.toHaveAttribute('open', '');
    const bounds = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    await page.screenshot({ path: info.outputPath(`one-click-mobile-${width}.png`), fullPage: true });
  }
});


test('known top-edge correction changes measurements and export extent while preserving the photograph overlay', async ({ page }, info) => {
  const api = await mockProvider(page, 'openrouter', 'shape');
  await openSource(page); await page.locator('#methodA').check(); await configureKey(page);
  await page.locator('#analyze').click(); await complete(page, 'A');
  const original = await download<Measurement>(page);
  const overlay = await page.locator('#journeyOverlay [data-contour="simplified"]').getAttribute('data-geometry-mm');
  const rectified = await page.locator('#journeyRectified').evaluate(node => ({ width: (node as HTMLCanvasElement).width, height: (node as HTMLCanvasElement).height }));
  await openDetailsFor(page, '#calibrationEdge');
  await page.locator('#calibrationEdge').selectOption('0');
  await expect(page.locator('[data-reference-edge-highlight]')).toHaveAttribute('data-reference-edge-index', '0');
  await expect(page.locator('[data-reference-edge-label]')).toHaveText('E1');
  await expect(page.locator('[data-reference-edge-highlight]')).toBeVisible();
  await expect(page.locator('[data-reference-edge-highlight]')).toHaveAttribute('data-edge-points-mm', JSON.stringify(testShape.outer_vertices_mm.slice(0, 2)));
  await page.locator('#calibrationLength').fill('300');
  await expect(page.locator('#calibrationAssumptions')).not.toBeChecked();
  await expect(page.locator('#applyCalibration')).toBeDisabled();
  await page.locator('#calibrationAssumptions').check();
  await page.locator('#applyCalibration').click();
  await expect(page.locator('#clearCalibration')).toBeEnabled();
  const corrected = await download<Measurement>(page);
  const calibration = corrected.provenance.measurement_calibration;
  expect(calibration.method).toBe('known_top_edge_uniform_scale');
  expect(calibration.observed_length_mm).toBe(150); expect(calibration.known_length_mm).toBe(300);
  expect(calibration.scale_factor).toBe(2); expect(calibration.mode).toBe('A'); expect(calibration.selected_outer_edge_index).toBe(0);
  expect(calibration.anchor_mm).toEqual({ x: 45, y: 35 });
  expect(corrected.provenance.scale_mm_per_px).toBe(original.provenance.scale_mm_per_px * 2);
  expect(corrected.provenance.marker_plane_mm_per_px).toEqual(original.provenance.marker_plane_mm_per_px);
  expect(corrected.provenance.export_translation_mm).toEqual({ x: 0, y: 0 });
  expect(corrected.total_area_mm2).toBeCloseTo(original.total_area_mm2 * 4, 7);
  const length = Math.hypot(corrected.outer_vertices_mm[1].x - corrected.outer_vertices_mm[0].x, corrected.outer_vertices_mm[1].y - corrected.outer_vertices_mm[0].y);
  expect(length).toBe(300);
  expect(corrected.provenance.original_geometry_mm.outer).toEqual(original.outer_vertices_mm.map(({ x, y }) => ({ x, y })));
  await expect(page.locator('#journeyOverlay [data-contour="simplified"]')).toHaveAttribute('data-geometry-mm', overlay!);
  await expect(page.locator('#journeyOverlay [data-edge-id="E1"][data-mm]')).toHaveAttribute('data-mm', '300');
  expect(await page.locator('#journeyRectified').evaluate(node => ({ width: (node as HTMLCanvasElement).width, height: (node as HTMLCanvasElement).height }))).toEqual(rectified);
  expect(Number((await page.locator('#area').innerText()).replaceAll(',', ''))).toBe(Math.round(corrected.total_area_mm2));
  const svg = await downloadText(page, '#exportSvg');
  const extent = await page.evaluate(text => {
    const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
    return { viewBox: root.getAttribute('viewBox')!.split(/\s+/).map(Number), width: root.getAttribute('width'), height: root.getAttribute('height'), parserErrors: root.querySelectorAll('parsererror').length };
  }, svg);
  expect(extent.parserErrors).toBe(0);
  expect(extent.width).toBe(`${extent.viewBox[2]}mm`); expect(extent.height).toBe(`${extent.viewBox[3]}mm`);
  expect(extent.viewBox[2]).toBeGreaterThan(250); expect(extent.viewBox[3]).toBeGreaterThan(170);
  const bounds = corrected.provenance.svg_export_bounds_mm;
  expect(extent.viewBox).toEqual([bounds.minX, bounds.minY, bounds.width, bounds.height]);
  for (const point of corrected.outer_vertices_mm) {
    expect(point.x).toBeGreaterThanOrEqual(extent.viewBox[0]); expect(point.y).toBeGreaterThanOrEqual(extent.viewBox[1]);
    expect(point.x).toBeLessThanOrEqual(extent.viewBox[0] + extent.viewBox[2]); expect(point.y).toBeLessThanOrEqual(extent.viewBox[1] + extent.viewBox[3]);
  }
  await page.screenshot({ path: info.outputPath('known-edge-calibrated-TEST-ONLY.png'), fullPage: true });
  // Reapplying uses the immutable original, not an already scaled export.
  await page.locator('#applyCalibration').click();
  const repeated = await download<Measurement>(page);
  expect(repeated.outer_vertices_mm).toEqual(corrected.outer_vertices_mm); expect(repeated.total_area_mm2).toBe(corrected.total_area_mm2);
  await page.locator('#calibrationLength').fill('750'); await page.locator('#applyCalibration').click();
  await expect(page.locator('#calibrationStatus')).toContainText('0.25〜4倍');
  expect((await download<Measurement>(page)).outer_vertices_mm).toEqual(corrected.outer_vertices_mm);
  await page.locator('#clearCalibration').click();
  const cleared = await download<Measurement>(page);
  expect(cleared.provenance.measurement_calibration).toBeNull();
  expect(cleared.outer_vertices_mm).toEqual(original.outer_vertices_mm); expect(cleared.total_area_mm2).toBe(original.total_area_mm2);
  await expect(page.locator('#journeyOverlay [data-edge-id="E1"][data-mm]')).toHaveAttribute('data-mm', '150');
  // E4 is intentionally not the default dropdown edge. Visiting an uncomputed
  // method must not silently retarget its saved known-length correction to E1.
  await page.locator('#calibrationEdge').selectOption('3');
  await page.locator('#calibrationLength').fill('110'); await page.locator('#calibrationAssumptions').check();
  await page.locator('#applyCalibration').click();
  const e4 = await download<Measurement>(page);
  expect(e4.provenance.measurement_calibration.selected_outer_edge_index).toBe(3);
  expect(e4.provenance.measurement_calibration.observed_length_mm).toBe(55);
  expect(e4.provenance.measurement_calibration.scale_factor).toBe(2);
  await page.locator('#methodB').check(); await expect(page.locator('#calibrationEdge')).toBeDisabled();
  await expect(page.locator('#exportJson')).toBeDisabled();
  await page.locator('#methodA').check();
  await expect(page.locator('#calibrationEdge')).toHaveValue('3');
  await expect(page.locator('#calibrationLength')).toHaveValue('110');
  await expect(page.locator('#calibrationAssumptions')).toBeChecked();
  await expect(page.locator('[data-reference-edge-highlight]')).toHaveAttribute('data-reference-edge-index', '3');
  await expect(page.locator('[data-reference-edge-label]')).toHaveText('E4');
  await expect(page.locator('[data-reference-edge-highlight]')).toBeVisible();
  await expect(page.locator('[data-reference-edge-highlight]')).toHaveAttribute('data-edge-points-mm', JSON.stringify(testShape.outer_vertices_mm.slice(3, 5)));
  await expect(page.locator('#journey-root')).toHaveAttribute('data-measurement-scale', '2');
  await expect(page.locator('#journeyOverlay [data-contour="simplified"]')).toHaveAttribute('data-geometry-mm', overlay!);
  await page.locator('#applyCalibration').click();
  const reappliedE4 = await download<Measurement>(page);
  expect(reappliedE4.outer_vertices_mm).toEqual(e4.outer_vertices_mm);
  expect(reappliedE4.provenance.measurement_calibration).toEqual(e4.provenance.measurement_calibration);
  await expect(page.locator('#journeyOverlay [data-edge-id="E4"][data-mm]')).toHaveAttribute('data-mm', '110');
  await page.locator('#analyze').click(); await complete(page, 'A');
  expect((await download<Measurement>(page)).provenance.measurement_calibration).toBeNull();
  await expect(page.locator('#clearCalibration')).toBeDisabled(); expect(api.inferenceCalls()).toBe(2);
  await page.locator('#calibrationEdge').selectOption('0');
  await page.locator('#calibrationLength').fill('300'); await page.locator('#calibrationAssumptions').check();
  await page.locator('#applyCalibration').click();
  await openDetailsFor(page, '[data-sample="notched"]'); await page.locator('[data-sample="notched"]').click(); await sourceReady(page);
  await expect(page.locator('#calibrationEdge')).toBeDisabled(); await expect(page.locator('#clearCalibration')).toBeDisabled();
  await expect(page.locator('#exportJson')).toBeDisabled(); await expect(page.locator('#calibrationStatus')).toContainText('未適用');
  await page.screenshot({ path: info.outputPath('known-edge-source-reset-TEST-ONLY.png'), fullPage: true });
});


test('A top-face uncertainty remains visible, and an unidentifiable top face fails without invented dimensions', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Structured surface-assessment UI matrix once');
  const assessment = { boundary: 'top-face', uncertain: true, occluded_edges: true, sidewall_risk: true };
  const api = await mockProvider(page, 'openrouter', 'shape', round => ({ shape: round === 1
    ? { ...testShape, surface_assessment: assessment }
    : { ...testShape, outer_vertices_mm: [], surface_assessment: assessment } }));
  await openSource(page); await page.locator('#methodA').check(); await configureKey(page);
  await page.locator('#analyze').click(); await complete(page, 'A');
  await expect(page.locator('#warnings')).toContainText('上面の境界に不確実');
  await expect(page.locator('#warnings')).toContainText('見えない上面の縁');
  await expect(page.locator('#warnings')).toContainText('側面が境界に混ざる');
  const output = await download<Measurement>(page);
  expect(output.provenance.surface_assessment).toEqual(assessment);
  await openDetailsFor(page, '[data-sample="notched"]'); await page.locator('[data-sample="notched"]').click(); await sourceReady(page);
  await page.locator('#analyze').click();
  await expect(page.locator('#analysisSummary')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#analysisFailureMessage')).toContainText('上面の境界を特定できませんでした');
  await expect(page.locator('#area')).toHaveText('—'); await expect(page.locator('#exportJson')).toBeDisabled();
  await expect(page.locator('[data-journey-step="dimensions"]')).toHaveCount(0);
  expect(api.inferenceCalls()).toBe(2);
});
