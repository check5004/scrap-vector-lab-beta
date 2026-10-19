import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Candidate, SearchAttempt } from '../../src/auto-tune';
import type { CandidateReview, ReviewAttempt } from '../../src/candidate-review';
import { providerStorageKey } from '../../src/key-storage';

// REAL segmentation; TEST-ONLY provider responses. Never substitute a model,
// probability mask, geometry, photograph, worker message, or inference result.
const neuralTimeout = 150_000;
const modelHash = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const syntheticKeys = {
  openrouter: 'sk-or-v1-SYNTHETIC_BETA_BROWSER_TEST_ONLY',
  openai: 'sk-proj-SYNTHETIC_BETA_BROWSER_TEST_ONLY',
};
type Provider = keyof typeof syntheticKeys;
type Build = { version: string; release: string; channel: string; source_commit: string };
type CandidateDiagnostic = Omit<Candidate, 'geometry' | 'rawGeometry'>;
type Tuning = {
  app_build: Build;
  selected_candidate_id: string | null;
  local: { candidates: CandidateDiagnostic[]; attempts: SearchAttempt[]; stoppedReason: string; scoring: string; universalWarnings: string[] };
  llm: { status: string; applied?: boolean; reason?: string; provider?: Provider; chosen_candidate_id?: string | null; evaluation?: { match_score: number }; attempts?: ReviewAttempt[]; unknown_cost_attempts?: number };
};
type Measurement = {
  outer_vertices_mm: { x: number; y: number; id: string }[];
  holes_vertices_mm: { x: number; y: number; id: string }[][];
  total_area_mm2: number;
  board_size_mm: { width_mm: number; height_mm: number };
  provenance: {
    app_build: Build; method: string; source_image: string; model_sha256?: string;
    mask_threshold: number; epsilon_mm: number; automatic_adjustment?: { candidate_id: string; llm: Tuning['llm'] };
  };
};
type Diagnostic = { app_build: Build; stages: { id: string; elapsedMs?: number; details: Record<string, any> }[] };

async function ready(page: Page) {
  await expect(page.locator('#status')).toContainText('平面補正できました', { timeout: 30_000 });
  await expect(page.locator('#autoTune')).toBeEnabled();
}
async function openSample(page: Page, sample = 'l-shape') {
  await page.goto('/'); await ready(page);
  if (sample !== 'l-shape') { await page.locator(`[data-sample="${sample}"]`).click(); await ready(page); }
}
async function infer(page: Page) {
  await page.locator('#runB').click();
  await expect(page.locator('#status')).toContainText('実際のU²-NetP推論が完了', { timeout: neuralTimeout });
  await expect(page.locator('#exportJson')).toBeEnabled();
}
async function downloadText(page: Page, selector: string) {
  const pending = page.waitForEvent('download'); await page.locator(selector).click();
  const download = await pending, path = await download.path();
  if (!path) throw Error('Expected an actual browser download');
  return readFile(path, 'utf8');
}
async function downloadJSON<T>(page: Page, selector: string): Promise<T> {
  return JSON.parse(await downloadText(page, selector)) as T;
}
async function tuning(page: Page): Promise<Tuning> {
  return JSON.parse(await page.locator('#tuneDetails').textContent() ?? 'null');
}
async function search(page: Page) {
  await page.locator('#autoTune').click();
  await expect(page.locator('#autoTune')).toBeEnabled({ timeout: neuralTimeout + 40_000 });
  const result = await tuning(page);
  expect(result.local.attempts.length).toBeGreaterThan(0);
  expect(result.local.attempts.length).toBeLessThanOrEqual(80);
  expect(result.local.candidates.length).toBeGreaterThan(0);
  expect(result.local.scoring).toBe('heuristic_not_accuracy');
  for (const attempt of result.local.attempts) {
    expect(attempt.threshold).toBeGreaterThanOrEqual(0.1); expect(attempt.threshold).toBeLessThanOrEqual(0.9);
    expect(attempt.epsilon).toBeGreaterThanOrEqual(0.5); expect(attempt.epsilon).toBeLessThanOrEqual(10);
  }
  await expect(page.locator('#tuneStop')).toBeDisabled();
  return result;
}
async function ensureMeasurement(page: Page) {
  if (await page.locator('#exportJson').isDisabled()) await page.locator('[data-apply-candidate]').first().click();
  await expect(page.locator('#exportJson')).toBeEnabled();
}
async function assertReviewedApplication(page: Page, before: Measurement) {
  const result = await tuning(page);
  const chosen = result.local.candidates.find(candidate => candidate.id === result.llm.chosen_candidate_id);
  expect(chosen).toBeDefined();
  if (chosen!.safeToAutoApply) {
    expect(result.llm.applied).toBe(true);
    expect(result.selected_candidate_id).toBe(chosen!.id);
  } else {
    expect(result.llm.applied).toBe(false);
    sameGeometry(await downloadJSON<Measurement>(page, '#exportJson'), before);
    await expect(page.locator('#reviewStatus')).toContainText('計測結果は変更していません');
    const card = page.locator(`[data-candidate-id="${chosen!.id}"]`);
    await expect(card).toContainText('未採用');
    await expect(card).toContainText('自動採用しません');
    await card.locator('[data-apply-candidate]').click();
    await expect(page.locator('#warnings')).toContainText('精度・写真との一致を保証しません');
  }
  return result;
}
async function setRange(page: Page, id: 'epsilon' | 'threshold', value: string) {
  await page.locator(`#${id}`).evaluate((node, next) => {
    const input = node as HTMLInputElement; input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function openDetailsFor(page: Page, id: string) {
  const details = page.locator('details').filter({ has: page.locator(`#${id}`) }).last();
  if (!(await details.evaluate(node => node.hasAttribute('open')))) await details.locator('summary').click();
}
async function prepareReview(page: Page, selected: Provider = 'openrouter') {
  await openDetailsFor(page, 'provider');
  await page.locator('#provider').selectOption(selected);
  await page.locator('#apiKey').fill(syntheticKeys[selected]);
  await openDetailsFor(page, 'reviewRun');
  await expect(page.locator('#reviewConsent')).not.toBeChecked();
  await expect(page.locator('#reviewRun')).toBeDisabled();
}
function sameGeometry(actual: Measurement, expected: Measurement) {
  expect(actual.outer_vertices_mm).toEqual(expected.outer_vertices_mm);
  expect(actual.holes_vertices_mm).toEqual(expected.holes_vertices_mm);
  expect(actual.total_area_mm2).toBe(expected.total_area_mm2);
  expect(actual.board_size_mm).toEqual(expected.board_size_mm);
}

// Context routing also covers workers. Unexpected off-origin HTTP is aborted;
// page-level exact provider mocks below fulfill locally and never continue/fetch.
let unexpected: string[];
let errors: string[];
test.beforeEach(async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  unexpected = []; errors = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (new URL(url).origin === origin) await route.continue();
    else { unexpected.push(url); await route.abort('blockedbyclient'); }
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(() => {
  expect(unexpected, 'No unexpected remote requests; all remote traffic must be locally fulfilled test fixtures').toEqual([]);
  expect(errors, 'No uncaught browser exceptions').toEqual([]);
});

const endpoints = {
  openrouter: { auth: 'https://openrouter.ai/api/v1/key', models: 'https://openrouter.ai/api/v1/models', inference: 'https://openrouter.ai/api/v1/chat/completions' },
  openai: { auth: null, models: 'https://api.openai.com/v1/models/gpt-6-luna', inference: 'https://api.openai.com/v1/responses' },
};
type SentCandidate = { id: string; threshold: number; epsilon: number; safe: boolean };
type MockCall = { url: string; method: string; payload: any; authorization: string | undefined };
type MockReply = { review?: CandidateReview; status?: number; malformed?: boolean; cost?: number; release?: Promise<void> };
function testReview(candidates: SentCandidate[], score = 0.95, acceptable = true): CandidateReview {
  return {
    evaluations: candidates.map(candidate => ({ candidate_id: candidate.id, match_score: score, missing_holes: false, extra_holes: false, missing_detail: false, background_leak: false, acceptable })),
    recommended_candidate_id: candidates[0].id,
    adjustment: { threshold_direction: candidates[0].threshold > 0.5 ? 'lower' : 'higher', epsilon_direction: 'none' }, stop: false,
  };
}
async function mockProvider(page: Page, selected: Provider, respond: (candidates: SentCandidate[], round: number) => MockReply) {
  const calls: MockCall[] = [], batches: SentCandidate[][] = [];
  const target = endpoints[selected];
  const fulfill = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  // Only exact intended endpoints are mocked. A typo, other provider, CDN or
  // fallback endpoint reaches the blocking context route and fails the test.
  for (const url of [target.auth, target.models, target.inference].filter((url): url is string => !!url)) {
    await page.route(url, async route => {
      const request = route.request(), payload = request.postDataJSON();
      calls.push({ url, method: request.method(), payload, authorization: request.headers().authorization });
      if (url === target.auth) { await fulfill(route, { data: {} }); return; }
      if (url === target.models) {
        await fulfill(route, selected === 'openai' ? { id: 'gpt-6-luna' } : { data: [{ id: 'openai/gpt-6-luna', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['response_format', 'structured_outputs'] }] });
        return;
      }
      const content = selected === 'openai' ? payload.input[0].content : payload.messages[1].content;
      const candidates = content.filter((item: any) => typeof item.text === 'string' && item.text.includes('Candidate metadata: '))
        .map((item: any) => JSON.parse(item.text.split('Candidate metadata: ')[1]) as SentCandidate);
      expect(candidates.length).toBeGreaterThan(0); expect(candidates.length).toBeLessThanOrEqual(4);
      const images = content.filter((item: any) => ['input_image', 'image_url'].includes(item.type));
      expect(images).toHaveLength(candidates.length + 1);
      for (const item of images) expect(selected === 'openai' ? item.image_url : item.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
      expect(selected === 'openai' ? payload.max_output_tokens : payload.max_completion_tokens).toBe(1200);
      expect(payload.model).toBe(selected === 'openai' ? 'gpt-6-luna' : 'openai/gpt-6-luna');
      if (selected === 'openai') expect(payload.store).toBe(false);
      else expect(payload.provider).toEqual({ require_parameters: true, allow_fallbacks: false });
      expect(payload.tools).toBeUndefined(); expect(payload.models).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('SYNTHETIC_BETA_BROWSER_TEST_ONLY');
      batches.push(candidates);
      const reply = respond(candidates, batches.length);
      if (reply.release) await reply.release;
      const text = reply.malformed ? '{ TEST_ONLY_MALFORMED_RESPONSE' : JSON.stringify(reply.review ?? testReview(candidates));
      const body = (reply.status ?? 200) >= 400 ? { error: { message: 'TEST_ONLY_PRIVATE_PROVIDER_BODY_DO_NOT_RENDER' } } : selected === 'openai'
        ? { model: 'gpt-6-luna', id: 'test-only-response', status: 'completed', output: [{ content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } }
        : { model: 'openai/gpt-6-luna', id: 'test-only-generation', choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...(reply.cost === undefined ? {} : { cost: reply.cost }) } };
      // An intentionally aborted request may already be gone when released.
      if (reply.release) await fulfill(route, body, reply.status).catch(() => {});
      else await fulfill(route, body, reply.status);
    });
  }
  return { calls, batches };
}

// The core real-inference flow also runs under the configured Pixel 7 project.
test('real AI-textured search commits exact epsilon, restores before state, and exports the same beta build', async ({ page }, info) => {
  test.setTimeout(240_000);
  await openSample(page, 'ai-l-shape');
  await expect(page.locator('#autoRecover')).toBeChecked();
  await expect(page.locator('#epsilon')).toHaveAttribute('step', '0.001');
  await setRange(page, 'epsilon', '0.501');
  await infer(page);
  const before = await downloadJSON<Measurement>(page, '#exportJson');
  const beforeDiagnostics = await downloadJSON<Diagnostic>(page, '#debugExport');
  expect(before.provenance.model_sha256).toBe(modelHash);
  expect(beforeDiagnostics.stages.find(stage => stage.id === 'probability')?.details.timings_ms.inference).toBeGreaterThan(0);
  const result = await search(page);
  await expect(page.locator('#tuneBeforeImage')).toBeVisible();
  expect(await page.locator('#tuneBeforeImage').evaluate(async node => { const image = node as HTMLImageElement; await image.decode(); return image.naturalWidth; })).toBeGreaterThan(0);
  // Both .500 and .501 are evaluated from the unchanged real mask; .501 exposes
  // the previous coarse HTML range-step rounding bug, even if scores are tied.
  const visibleIds = await page.locator('[data-apply-candidate]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.applyCandidate));
  const exact = result.local.candidates.find(candidate => candidate.epsilon === 0.501 && visibleIds.includes(candidate.id));
  expect(exact, 'A visible actual .501 mm candidate is required for this regression').toBeDefined();
  await page.locator(`[data-apply-candidate="${exact!.id}"]`).click();
  await expect(page.locator('#epsilon')).toHaveValue('0.501');
  const after = await downloadJSON<Measurement>(page, '#exportJson');
  const diagnostics = await downloadJSON<Diagnostic>(page, '#debugExport');
  expect(after.provenance.epsilon_mm).toBe(exact!.epsilon);
  expect(after.provenance.mask_threshold).toBe(exact!.threshold);
  expect(after.provenance.automatic_adjustment?.candidate_id).toBe(exact!.id);
  expect(after.provenance.automatic_adjustment?.llm.status).toBe('not_executed');
  expect(diagnostics.stages.find(stage => stage.id === 'polygon')?.details.epsilon_mm).toBe(exact!.epsilon);
  expect(diagnostics.stages.find(stage => stage.id === 'probability')).toEqual(beforeDiagnostics.stages.find(stage => stage.id === 'probability'));
  expect(diagnostics.stages.find(stage => stage.id === 'rectified')).toEqual(beforeDiagnostics.stages.find(stage => stage.id === 'rectified'));
  expect(after.board_size_mm).toEqual(before.board_size_mm);
  await expect(page.locator('#warnings')).toContainText('精度・写真との一致を保証しません');
  const version = await page.locator('#appVersion').innerText();
  expect(version).toMatch(/^0\.3\.0-dev\.1\+(?:[a-f0-9]{7}|local)$/);
  expect(after.provenance.app_build).toEqual(diagnostics.app_build);
  expect(result.app_build).toEqual(diagnostics.app_build);
  expect(diagnostics.app_build.version).toBe(version);
  expect(diagnostics.app_build.release).toBe('0.3.0-dev.1'); expect(diagnostics.app_build.channel).toBe('beta');
  const source = diagnostics.app_build.source_commit;
  expect(source).toMatch(/^(?:[a-f0-9]{40}|local)$/);
  expect(version).toBe(`0.3.0-dev.1+${source === 'local' ? source : source.slice(0, 7)}`);
  const dxf = await downloadText(page, '#exportDxf');
  expect(dxf.replaceAll('\r\n', '\n')).toContain(`999\nScrap Vector Lab ${version} source ${source}\n`);
  await page.locator('#tuneRestore').click();
  const restored = await downloadJSON<Measurement>(page, '#exportJson');
  sameGeometry(restored, before); expect(restored.provenance).toEqual(before.provenance);
  await expect(page.locator('#tuneStatus')).toContainText('調整前の結果に戻しました');
  await expect(page.locator('[data-apply-candidate]').first()).toBeEnabled();
  if (info.project.name === 'mobile') {
    await openDetailsFor(page, 'reviewRun');
    await openDetailsFor(page, 'tuneDetails');
    const bounds = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    await page.locator('#tunePanel').screenshot({ path: info.outputPath('beta-mobile-auto-tune.png') });
  }
});

test('cancelled and repeated local runs preserve prior geometry; a new source removes stale candidates', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Full repeated two-inference matrix runs on desktop'); test.setTimeout(330_000);
  await openSample(page); await infer(page);
  const before = await downloadJSON<Measurement>(page, '#exportJson');
  // Same-event-loop clicks deterministically reach the search yield; do not mock
  // its clock, candidate loop, real mask or abort signal.
  await page.evaluate(() => {
    (document.querySelector('#autoTune') as HTMLButtonElement).click();
    (document.querySelector('#autoTune') as HTMLButtonElement).click(); // disabled duplicate
    (document.querySelector('#tuneStop') as HTMLButtonElement).click();
  });
  await expect(page.locator('#autoTune')).toBeEnabled();
  await expect(page.locator('#tuneStatus')).toContainText('前の計測結果は変更せず');
  const cancelled = await tuning(page); expect(cancelled.local.stoppedReason).toBe('cancelled');
  const retained = await downloadJSON<Measurement>(page, '#exportJson'); sameGeometry(retained, before); expect(retained.provenance).toEqual(before.provenance);
  const first = await search(page), second = await search(page);
  expect(new Set(second.local.attempts.map(attempt => attempt.id)).size).toBe(second.local.attempts.length);
  expect(second.local.attempts.length).toBeLessThanOrEqual(80);
  expect(first.llm.status).toBe('not_executed'); expect(second.llm.status).toBe('not_executed');
  await page.locator('[data-sample="notched"]').click(); await ready(page);
  await expect(page.locator('[data-apply-candidate]')).toHaveCount(0);
  await expect(page.locator('#tuneBeforeImage')).not.toBeVisible();
  await expect(page.locator('#tuneRestore')).toBeDisabled(); await expect(page.locator('#reviewRun')).toBeDisabled();
  await expect(page.locator('#tuneDetails')).toHaveText('未実行'); await expect(page.locator('#exportJson')).toBeDisabled();
  // No cached mask exists for the new source: auto-tune must obtain actual ONNX output.
  await search(page); await ensureMeasurement(page);
  const fresh = await downloadJSON<Measurement>(page, '#exportJson');
  expect(fresh.provenance.source_image).toBe('notched'); expect(fresh.provenance.model_sha256).toBe(modelHash);
  expect(fresh.outer_vertices_mm).not.toEqual(before.outer_vertices_mm);
  const report = await downloadJSON<Diagnostic>(page, '#debugExport');
  expect(report.stages.find(stage => stage.id === 'input')?.details.source).toBe('notched');
  expect(report.stages.find(stage => stage.id === 'probability')?.details.timings_ms.inference).toBeGreaterThan(0);
});

test('invalid manual epsilon and empty threshold recover from the unchanged genuine mask', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Fault-injected settings matrix runs once'); test.setTimeout(240_000);
  await openSample(page); await infer(page);
  const baseline = await downloadJSON<Diagnostic>(page, '#debugExport');
  for (const [id, badValue] of [['epsilon', '1000'], ['threshold', '1.1']] as const) {
    const before = await downloadJSON<Measurement>(page, '#exportJson');
    // Deliberately inject an invalid numeric UI setting, not AI data. Native
    // sliders clamp normal user input; this probes recovery after corrupt state.
    await page.locator(`#${id}`).evaluate((node, value) => {
      const input = node as HTMLInputElement; input.max = value; input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, badValue);
    await expect(page.locator('#autoTune')).toBeEnabled({ timeout: 45_000 });
    const result = await tuning(page); expect(result.local.candidates.length).toBeGreaterThan(0);
    if (result.local.candidates.some(candidate => candidate.safeToAutoApply)) {
      await expect(page.locator('#tuneStatus')).toContainText('輪郭を取得'); expect(result.selected_candidate_id).not.toBeNull();
    } else {
      expect(result.selected_candidate_id).toBeNull();
      await expect(page.locator('#tuneStatus')).toContainText('自動採用せず');
      sameGeometry(await downloadJSON<Measurement>(page, '#exportJson'), before);
      await page.locator('[data-apply-candidate]').first().click();
    }
    const output = await downloadJSON<Measurement>(page, '#exportJson');
    expect(output.provenance.epsilon_mm).toBeGreaterThanOrEqual(0.5); expect(output.provenance.epsilon_mm).toBeLessThanOrEqual(10);
    expect(output.provenance.mask_threshold).toBeGreaterThanOrEqual(0.1); expect(output.provenance.mask_threshold).toBeLessThanOrEqual(0.9);
    const report = await downloadJSON<Diagnostic>(page, '#debugExport');
    expect(report.stages.find(stage => stage.id === 'probability')).toEqual(baseline.stages.find(stage => stage.id === 'probability'));
    await page.locator(`#${id}`).evaluate((node, max) => { (node as HTMLInputElement).max = max; }, id === 'epsilon' ? '10' : '0.9');
  }
});

test('the real known missed hole stays visible as a warning after automatic search', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Known model limitation runs once'); test.setTimeout(240_000);
  await openSample(page, 'trapezoid-hole'); await infer(page);
  await expect(page.locator('#holes')).toHaveText('0');
  await expect(page.locator('#benchmark')).toContainText('正解 1');
  await expect(page.locator('#warnings')).toContainText('穴');
  await search(page);
  await expect(page.locator('#benchmark')).toContainText('正解 1');
  await expect(page.locator('#warnings')).toContainText('穴');
  await expect(page.locator('#tunePanel')).toContainText('写真との一致率や計測精度ではありません');
  const result = await tuning(page);
  expect(result.local.universalWarnings.join(' ')).toContain('miss');
  expect(result.llm.status).toBe('not_executed');
});

test('review requires separate consent, honors one-call limit and selected provider, then invalidates stale evaluation', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Mocked external-review integration runs on desktop'); test.setTimeout(240_000);
  const router = await mockProvider(page, 'openrouter', candidates => ({ review: testReview(candidates, 0.7, false) }));
  const openai = await mockProvider(page, 'openai', candidates => ({ review: testReview(candidates) }));
  await openSample(page); await search(page); await ensureMeasurement(page); await prepareReview(page);
  await expect(page.locator('#reviewMaxCalls option')).toHaveText(['1回', '2回', '3回']);
  await page.locator('#consent').check(); // Mode A consent must not authorize visual review.
  await expect(page.locator('#reviewRun')).toBeDisabled(); expect(router.calls).toHaveLength(0); expect(openai.calls).toHaveLength(0);
  const beforeRouter = await downloadJSON<Measurement>(page, '#exportJson');
  await page.locator('#reviewMaxCalls').selectOption('1'); await page.locator('#reviewConsent').check();
  await page.locator('#reviewRun').click(); await expect(page.locator('#autoTune')).toBeEnabled();
  await expect(page.locator('#reviewStatus')).toContainText('呼出し上限');
  await expect(page.locator('#reviewUsage')).toContainText('API評価試行 1回');
  await expect(page.locator('#reviewUsage')).toContainText('料金不明 1回');
  expect(router.batches).toHaveLength(1); expect(openai.calls).toHaveLength(0);
  expect(router.calls.map(call => call.url)).toEqual([endpoints.openrouter.auth, endpoints.openrouter.models, endpoints.openrouter.inference]);
  expect(router.calls[0].authorization).toBe(`Bearer ${syntheticKeys.openrouter}`); expect(router.calls[1].authorization).toBeUndefined();
  expect(router.calls[2].authorization).toBe(`Bearer ${syntheticKeys.openrouter}`);
  const limited = await assertReviewedApplication(page, beforeRouter); expect(limited.llm.reason).toBe('max-calls'); expect(limited.llm.attempts).toHaveLength(1);
  await page.locator('#provider').selectOption('openai');
  await expect(page.locator('#reviewConsent')).not.toBeChecked(); await expect(page.locator('#reviewRun')).toBeDisabled();
  await page.locator('#apiKey').fill(syntheticKeys.openai); await page.locator('#reviewConsent').check();
  const beforeOpenAI = await downloadJSON<Measurement>(page, '#exportJson');
  await page.locator('#reviewRun').click(); await expect(page.locator('#autoTune')).toBeEnabled();
  await expect(page.locator('#reviewStatus')).toContainText('LLMが妥当と評価');
  expect(router.batches).toHaveLength(1); expect(openai.batches).toHaveLength(1);
  expect(openai.calls.map(call => call.url)).toEqual([endpoints.openai.models, endpoints.openai.inference]);
  expect(openai.calls.every(call => call.authorization === `Bearer ${syntheticKeys.openai}`)).toBe(true);
  await assertReviewedApplication(page, beforeOpenAI);
  const reviewed = await downloadJSON<Measurement>(page, '#exportJson'); expect(reviewed.provenance.automatic_adjustment?.llm.provider).toBe('openai');
  await expect(page.locator('#reviewUsage')).toContainText('料金不明 1回');
  await setRange(page, 'epsilon', '0.5');
  const manual = await downloadJSON<Measurement>(page, '#exportJson');
  expect(manual.provenance.automatic_adjustment).toBeUndefined();
  await expect(page.locator('#reviewStatus')).toContainText('未実行'); await expect(page.locator('#reviewConsent')).not.toBeChecked();
  await expect(page.locator('[data-apply-candidate]')).toHaveCount(0);
  const report = await downloadJSON<Diagnostic>(page, '#debugExport'); expect(report.stages.some(stage => stage.id === 'tuning')).toBe(false);
});

test('two-round refinement keeps the prior best candidate and its exact geometry when evaluation worsens', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Real refinement with mocked ratings runs once'); test.setTimeout(240_000);
  const provider = await mockProvider(page, 'openrouter', (candidates, round) => ({ review: testReview(candidates, round === 1 ? 0.7 : 0.4, false), cost: 0.001 }));
  await openSample(page); await search(page); await ensureMeasurement(page); await prepareReview(page);
  const initialBest = (await tuning(page)).local.candidates[0];
  await page.locator(`[data-apply-candidate="${initialBest.id}"]`).click();
  const before = await downloadJSON<Measurement>(page, '#exportJson');
  await page.locator('#reviewMaxCalls').selectOption('2'); await page.locator('#reviewConsent').check();
  await page.locator('#reviewRun').click(); await expect(page.locator('#autoTune')).toBeEnabled({ timeout: 60_000 });
  expect(provider.batches).toHaveLength(2);
  const original = provider.batches[0][0]; expect(provider.batches[1][0].id).toBe(original.id);
  expect(provider.batches[1].some(candidate => !provider.batches[0].some(old => old.id === candidate.id))).toBe(true);
  const result = await assertReviewedApplication(page, before); expect(result.llm.reason).toBe('plateau'); expect(result.llm.evaluation?.match_score).toBe(0.7);
  expect(result.llm.chosen_candidate_id).toBe(original.id); expect((await tuning(page)).selected_candidate_id).toBe(original.id);
  expect(result.llm.attempts).toHaveLength(2); expect(result.llm.attempts?.every(attempt => attempt.status === 'completed')).toBe(true);
  const output = await downloadJSON<Measurement>(page, '#exportJson');
  sameGeometry(output, before);
  expect(output.provenance.mask_threshold).toBe(original.threshold); expect(output.provenance.epsilon_mm).toBe(original.epsilon);
  expect(output.provenance.automatic_adjustment?.candidate_id).toBe(original.id);
  await expect(page.locator('#reviewUsage')).toContainText('API評価試行 2回'); await expect(page.locator('#reviewUsage')).toContainText('$0.002000');
  await expect(page.locator('#reviewStatus')).toContainText('最良評価を保持');
});

test('failed and cancelled test-only API calls retain local geometry, show unknown costs, and cannot commit late results', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Provider failure and cancellation run once'); test.setTimeout(240_000);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const provider = await mockProvider(page, 'openrouter', (candidates, round) => round === 1 ? { status: 503 } : { review: testReview(candidates), release: held });
  await openSample(page); await search(page); await ensureMeasurement(page); await prepareReview(page);
  const before = await downloadJSON<Measurement>(page, '#exportJson');
  await page.locator('#reviewMaxCalls').selectOption('3'); await page.locator('#reviewConsent').check();
  await page.locator('#reviewRun').click(); await expect(page.locator('#autoTune')).toBeEnabled();
  const failed = await tuning(page); expect(failed.llm.status).toBe('not_evaluated'); expect(failed.llm.reason).toBe('failed');
  expect(failed.llm.chosen_candidate_id).toBeNull(); await expect(page.locator('#tuneCandidates')).not.toContainText('LLM評価の選択候補');
  expect(failed.llm.attempts).toHaveLength(1); expect(failed.llm.attempts?.[0].inferenceSent).toBe(true); expect(failed.llm.unknown_cost_attempts).toBe(1);
  expect(provider.batches).toHaveLength(1); sameGeometry(await downloadJSON<Measurement>(page, '#exportJson'), before);
  await expect(page.locator('#reviewUsage')).toContainText('料金不明 1回'); await expect(page.locator('#reviewStatus')).toContainText('未評価を成功扱いしません');
  await expect(page.locator('body')).not.toContainText('TEST_ONLY_PRIVATE_PROVIDER_BODY_DO_NOT_RENDER');
  await page.locator('#reviewRun').click(); await expect.poll(() => provider.batches.length).toBe(2);
  await expect(page.locator('#provider')).toBeDisabled(); await expect(page.locator('#reviewMaxCalls')).toBeDisabled();
  await page.locator('#tuneStop').click();
  await expect(page.locator('#autoTune')).toBeEnabled();
  const cancelled = await tuning(page); expect(cancelled.llm.reason).toBe('cancelled'); expect(cancelled.llm.status).toBe('not_evaluated');
  expect(cancelled.llm.chosen_candidate_id).toBeNull(); await expect(page.locator('#tuneCandidates')).not.toContainText('LLM評価の選択候補');
  sameGeometry(await downloadJSON<Measurement>(page, '#exportJson'), before);
  await page.locator('[data-sample="notched"]').click(); await ready(page); release();
  await expect(page.locator('#tuneDetails')).toHaveText('未実行'); await expect(page.locator('#exportJson')).toBeDisabled();
  await expect(page.locator('[data-apply-candidate]')).toHaveCount(0);
  const report = await downloadJSON<Diagnostic>(page, '#debugExport');
  expect(report.stages.some(stage => stage.id === 'tuning')).toBe(false);
  const serialized = JSON.stringify(report); expect(serialized).not.toContain('SYNTHETIC_BETA_BROWSER_TEST_ONLY'); expect(serialized).not.toContain('TEST_ONLY_PRIVATE_PROVIDER_BODY');
});

test('unfinished C drawings and active vertex drags gate search, review, restoration, and candidate application', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Pointer-down editing gates run once'); test.setTimeout(240_000);
  await openSample(page); await infer(page); await search(page); await prepareReview(page);
  await page.locator('#reviewConsent').check(); await expect(page.locator('#reviewRun')).toBeEnabled();
  await page.locator('#editC').click(); const edited = await downloadJSON<Measurement>(page, '#exportJson');
  await page.locator('#drawHole').click();
  for (const selector of ['#autoTune', '#reviewRun', '#tuneRestore', '#exportJson']) await expect(page.locator(selector)).toBeDisabled();
  for (const button of await page.locator('[data-apply-candidate]').all()) await expect(button).toBeDisabled();
  await page.locator('#cancelDraw').click(); sameGeometry(await downloadJSON<Measurement>(page, '#exportJson'), edited);
  await expect(page.locator('#autoTune')).toBeEnabled(); await expect(page.locator('#reviewRun')).toBeEnabled();
  const pin = page.locator('#editor [data-pin]').first(); await pin.scrollIntoViewIfNeeded(); const box = await pin.boundingBox();
  if (!box) throw Error('Expected a real C vertex');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  for (const selector of ['#autoTune', '#reviewRun', '#tuneRestore', '#exportJson']) await expect(page.locator(selector)).toBeDisabled();
  for (const button of await page.locator('[data-apply-candidate]').all()) await expect(button).toBeDisabled();
  await page.mouse.up(); await expect(page.locator('#autoTune')).toBeEnabled();
});

test('beta storage never imports, mutates, or deletes production provider records', async ({ page }) => {
  const productionSlots = ['scrap-vector-lab:provider-key:v1:openrouter', 'scrap-vector-lab:provider-key:v1:openai'];
  const records = productionSlots.map((slot, index) => ({ slot, value: JSON.stringify({ version: 1, provider: index ? 'openai' : 'openrouter', key: syntheticKeys[index ? 'openai' : 'openrouter'] + '_PRODUCTION' }) }));
  await page.addInitScript(items => {
    for (const { slot, value } of items) localStorage.setItem(slot, value);
    const accesses: string[] = []; (window as any).__testOnlyProductionAccesses = accesses;
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      const original = Storage.prototype[method];
      Object.defineProperty(Storage.prototype, method, { configurable: true, value: function (key: string, ...args: string[]) {
        if (items.some(item => item.slot === key)) accesses.push(`${method}:${key}`);
        return Reflect.apply(original, this, [key, ...args]);
      } });
    }
  }, records);
  await openSample(page); await openDetailsFor(page, 'provider');
  for (const selected of ['openrouter', 'openai'] as const) {
    expect(providerStorageKey(selected)).toMatch(/^scrap-vector-lab-beta:/);
    await page.locator('#provider').selectOption(selected); await expect(page.locator('#apiKey')).toHaveValue('');
    await page.locator('#apiKey').fill(syntheticKeys[selected]);
    expect(await page.evaluate(slot => JSON.parse(localStorage.getItem(slot)!).key, providerStorageKey(selected))).toBe(syntheticKeys[selected]);
    await page.locator('#clearKey').click(); expect(await page.evaluate(slot => localStorage.getItem(slot), providerStorageKey(selected))).toBeNull();
  }
  expect(await page.evaluate(() => (window as any).__testOnlyProductionAccesses)).toEqual([]);
  // Inspect via property lookup so the test's own verification does not count as
  // an application read in the instrumented storage methods.
  expect(await page.evaluate(slots => slots.map(slot => localStorage[slot]), productionSlots)).toEqual(records.map(record => record.value));
  await expect(page.locator('#keyStorageHelp')).toContainText('完全なセキュリティ隔離ではありません');
  await expect(page.locator('#reviewRun')).toBeDisabled();
});
