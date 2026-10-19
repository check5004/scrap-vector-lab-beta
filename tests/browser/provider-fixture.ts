import { expect, type Page, type Route } from '@playwright/test';
import type { CandidateReview } from '../../src/candidate-review';

/** TEST-ONLY remote responses. These fixtures never continue or fetch a request.
 * Local model/image/mask/geometry computation is not intercepted.
 */
export type TestProvider = 'openrouter' | 'openai';
export const syntheticKeys = {
  openrouter: 'sk-or-v1-SYNTHETIC_UNIFIED_BROWSER_TEST_ONLY',
  openai: 'sk-proj-SYNTHETIC_UNIFIED_BROWSER_TEST_ONLY',
};
export const endpoints = {
  openrouter: { auth: 'https://openrouter.ai/api/v1/key', models: 'https://openrouter.ai/api/v1/models', inference: 'https://openrouter.ai/api/v1/chat/completions' },
  openai: { auth: null, models: 'https://api.openai.com/v1/models/gpt-6-luna', inference: 'https://api.openai.com/v1/responses' },
};
export const testShape = {
  shape_type: 'TEST_ONLY_top_face_fixture',
  outer_vertices_mm: [{ x: 45, y: 35 }, { x: 195, y: 35 }, { x: 195, y: 80 }, { x: 115, y: 80 }, { x: 115, y: 135 }, { x: 45, y: 135 }],
  holes_vertices_mm: [],
  surface_assessment: { boundary: 'top-face', uncertain: false, occluded_edges: false, sidewall_risk: false },
};
export type SentCandidate = { id: string; threshold: number; epsilon: number; safe: boolean };
export type ProviderCall = { url: string; payload: any; authorization?: string };
export type TestReply = { status?: number; release?: Promise<void>; review?: CandidateReview; shape?: typeof testShape };
export function testReview(candidates: SentCandidate[], score = 0.7): CandidateReview {
  return {
    evaluations: candidates.map(candidate => ({ candidate_id: candidate.id, match_score: score, missing_holes: false, extra_holes: false, missing_detail: false, background_leak: false, acceptable: false })),
    recommended_candidate_id: candidates[0].id,
    adjustment: { threshold_direction: candidates[0].threshold > 0.5 ? 'lower' : 'higher', epsilon_direction: 'none' },
    stop: false,
  };
}
export async function mockProvider(page: Page, selected: TestProvider, kind: 'shape' | 'review', respond: (round: number, candidates: SentCandidate[]) => TestReply = () => ({})) {
  const calls: ProviderCall[] = [], batches: SentCandidate[][] = [];
  let inferenceCount = 0, settledResponses = 0;
  const target = endpoints[selected];
  const fulfill = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  for (const url of [target.auth, target.models, target.inference].filter((url): url is string => !!url)) {
    await page.route(url, async route => {
      const request = route.request(), payload = request.postDataJSON();
      calls.push({ url, payload, authorization: request.headers().authorization });
      if (url === target.auth) { await fulfill(route, { data: {} }); return; }
      if (url === target.models) {
        await fulfill(route, selected === 'openai' ? { id: 'gpt-6-luna' } : { data: [{ id: 'openai/gpt-6-luna', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['response_format', 'structured_outputs'] }] });
        return;
      }
      inferenceCount++;
      const content = selected === 'openai' ? payload.input[0].content : payload.messages[kind === 'shape' ? 0 : 1].content;
      const candidates: SentCandidate[] = kind === 'review' ? content.filter((item: any) => item.text?.includes('Candidate metadata: '))
        .map((item: any) => JSON.parse(item.text.split('Candidate metadata: ')[1])) : [];
      const images = content.filter((item: any) => ['input_image', 'image_url'].includes(item.type));
      expect(images).toHaveLength(kind === 'shape' ? 1 : candidates.length + 1);
      for (const image of images) expect(selected === 'openai' ? image.image_url : image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
      expect(payload.model).toBe(selected === 'openai' ? 'gpt-6-luna' : 'openai/gpt-6-luna');
      if (selected === 'openai') expect(payload.store).toBe(false);
      else expect(payload.provider).toEqual(kind === 'shape' ? { require_parameters: true } : { require_parameters: true, allow_fallbacks: false });
      expect(payload.tools).toBeUndefined(); expect(payload.models).toBeUndefined();
      expect(request.headers().authorization).toBe(`Bearer ${syntheticKeys[selected]}`);
      expect(JSON.stringify(payload)).not.toContain('SYNTHETIC_UNIFIED_BROWSER_TEST_ONLY');
      if (kind === 'review') {
        expect(candidates.length).toBeGreaterThan(0); expect(candidates.length).toBeLessThanOrEqual(4);
        expect(selected === 'openai' ? payload.max_output_tokens : payload.max_completion_tokens).toBe(1200);
        batches.push(candidates);
      }
      const reply = respond(inferenceCount, candidates);
      if (reply.release) await reply.release;
      const text = JSON.stringify(kind === 'shape' ? reply.shape ?? testShape : reply.review ?? testReview(candidates));
      const body = (reply.status ?? 200) >= 400 ? { error: { message: 'TEST_ONLY_PRIVATE_PROVIDER_BODY' } } : selected === 'openai'
        ? { model: 'gpt-6-luna', id: 'test-only-unified-response', status: 'completed', output: [{ content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } }
        : { model: 'openai/gpt-6-luna', id: 'test-only-unified-generation', choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
      if (reply.release) await fulfill(route, body, reply.status).catch(() => {});
      else await fulfill(route, body, reply.status);
      settledResponses++;
    });
  }
  return { calls, batches, inferenceCalls: () => inferenceCount, settledResponses: () => settledResponses };
}
