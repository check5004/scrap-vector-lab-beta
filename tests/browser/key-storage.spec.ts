import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { providerStorageKey } from '../../src/key-storage';
import { legacyReady, openDetailsFor } from './legacy-ui';

// Deliberately synthetic credentials only. All off-origin requests are blocked.
const routerKey = 'sk-or-v1-SYNTHETIC_LOCAL_STORAGE_TEST_ONLY';
const openaiKey = 'sk-proj-SYNTHETIC_LOCAL_STORAGE_TEST_ONLY';
const routerSlot = providerStorageKey('openrouter')!;
const openaiSlot = providerStorageKey('openai')!;
async function openKeys(page: Page) {
  await legacyReady(page);
  await openDetailsFor(page, '#apiKey');
}
test.beforeEach(async ({ context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.routeWebSocket('**/*', socket => socket.close());
});

test('provider-specific keys survive reload, stay masked, never auto-send, and delete independently', async ({ page }) => {
  const network: string[] = [];
  page.on('request', request => { if (/openrouter\.ai|api\.openai\.com/.test(request.url())) network.push(request.url()); });
  await page.goto('/'); await openKeys(page);
  await page.locator('#apiKey').fill(routerKey);
  await expect(page.locator('#keyStorageStatus')).toContainText('保存しました');
  await expect(page.locator('#apiKey')).toHaveAttribute('type', 'password');
  await page.locator('#consent').check();
  await page.reload(); await openKeys(page);
  await expect(page.locator('#apiKey')).toHaveValue(routerKey);
  await expect(page.locator('#consent')).not.toBeChecked();
  await expect(page.locator('#runA')).toBeDisabled();
  await page.locator('#provider').selectOption('openai');
  await expect(page.locator('#apiKey')).toHaveValue('');
  await page.locator('#apiKey').fill(openaiKey);
  await page.locator('#provider').selectOption('openrouter');
  await expect(page.locator('#apiKey')).toHaveValue(routerKey);
  await page.locator('#clearKey').click();
  await expect(page.locator('#apiKey')).toHaveValue('');
  expect(await page.evaluate(slot => localStorage.getItem(slot), routerSlot)).toBeNull();
  await page.reload(); await openKeys(page);
  await expect(page.locator('#apiKey')).toHaveValue('');
  await page.locator('#provider').selectOption('openai');
  await expect(page.locator('#apiKey')).toHaveValue(openaiKey);
  await page.locator('#clearKey').click();
  expect(await page.evaluate(slot => localStorage.getItem(slot), openaiSlot)).toBeNull();
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  expect(network).toEqual([]);
});

test('invalid replacement removes the old saved key; tampered provider records fail closed', async ({ page }) => {
  await page.goto('/'); await openKeys(page);
  await page.locator('#apiKey').fill(routerKey);
  await page.locator('#apiKey').fill(openaiKey);
  await expect(page.locator('#keyValidation')).toContainText('別サービスのキーは送信しません');
  expect(await page.evaluate(slot => localStorage.getItem(slot), routerSlot)).toBeNull();
  await page.reload(); await openKeys(page);
  await expect(page.locator('#apiKey')).toHaveValue('');
  await page.evaluate(({ slot, key }) => localStorage.setItem(slot, JSON.stringify({ version: 1, provider: 'openai', key })), { slot: routerSlot, key: openaiKey });
  await page.reload(); await openKeys(page);
  await expect(page.locator('#apiKey')).toHaveValue('');
  await expect(page.locator('#keyStorageStatus')).toContainText('不正');
  expect(await page.evaluate(slot => localStorage.getItem(slot), routerSlot)).toBeNull();
  await page.evaluate(slot => localStorage.setItem(slot, '{bad JSON'), routerSlot);
  await page.reload(); await openKeys(page);
  await expect(page.locator('#apiKey')).toHaveValue('');
  await expect(page.locator('#runA')).toBeDisabled();
});

test('blocked storage stays usable without false persistence or exception leakage', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw Error('PRIVATE_STORAGE_EXCEPTION'); } }));
  await page.goto('/'); await openKeys(page);
  await expect(page.locator('#keyStorageStatus')).toContainText('保存領域を利用できません');
  await page.locator('#apiKey').fill(routerKey);
  await expect(page.locator('#apiKey')).toHaveValue(routerKey);
  await expect(page.locator('#keyStorageStatus')).toContainText('このタブだけ');
  await page.locator('#clearKey').click();
  await expect(page.locator('#apiKey')).toHaveValue('');
  await expect(page.locator('#keyStorageStatus')).toContainText('削除を確認できません');
  await expect(page.locator('body')).not.toContainText('PRIVATE_STORAGE_EXCEPTION');
  expect(errors).toEqual([]);
});

test('quota failure removes stale saved key; deletion failure warns and suppresses restoration in this tab', async ({ page }) => {
  await page.goto('/'); await openKeys(page);
  await page.locator('#apiKey').fill(routerKey);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw Error('PRIVATE_QUOTA_ERROR'); }; });
  await page.locator('#apiKey').fill(routerKey + '_NEW');
  await expect(page.locator('#keyStorageStatus')).toContainText('保存できませんでした');
  expect(await page.evaluate(slot => localStorage.getItem(slot), routerSlot)).toBeNull();
  await page.reload(); await openKeys(page);
  await expect(page.locator('#apiKey')).toHaveValue('');
  await page.locator('#apiKey').fill(routerKey);
  await page.evaluate(() => { Storage.prototype.removeItem = () => { throw Error('PRIVATE_REMOVE_ERROR'); }; });
  await page.locator('#clearKey').click();
  await expect(page.locator('#keyStorageStatus')).toContainText('削除を確認できません');
  await expect(page.locator('#apiKey')).toHaveValue('');
  await page.locator('#provider').selectOption('openai');
  await page.locator('#provider').selectOption('openrouter');
  await expect(page.locator('#apiKey')).toHaveValue('');
  await expect(page.locator('#runA')).toBeDisabled();
  await expect(page.locator('body')).not.toContainText('PRIVATE_REMOVE_ERROR');
  // A failed browser deletion cannot promise durability: after reload it can return.
  await page.reload(); await openKeys(page);
  await expect(page.locator('#apiKey')).toHaveValue(routerKey);
  await page.locator('#clearKey').click();
  await page.reload(); await openKeys(page);
  await expect(page.locator('#apiKey')).toHaveValue('');
});

test('deletion in another tab clears the selected key and consent without touching other apps', async ({ page, context }) => {
  await page.goto('/'); await openKeys(page);
  await page.evaluate(() => localStorage.setItem('unrelated-app-data', 'keep'));
  await page.locator('#apiKey').fill(routerKey);
  const second = await context.newPage();
  await second.goto('/'); await openKeys(second);
  await expect(second.locator('#apiKey')).toHaveValue(routerKey);
  await second.locator('#consent').check();
  await page.locator('#clearKey').click();
  await expect(second.locator('#apiKey')).toHaveValue('');
  await expect(second.locator('#consent')).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('unrelated-app-data'))).toBe('keep');
  await second.close();
});

test('saved keys stay out of visible text, logs, URLs, geometry and diagnostic exports', async ({ page }) => {
  const logs: string[] = [], requests: string[] = [];
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => logs.push(error.message));
  page.on('request', request => requests.push(request.url() + (request.postData() ?? '') + JSON.stringify(request.headers())));
  await page.goto('/'); await openKeys(page);
  await page.locator('#apiKey').fill(routerKey);
  await page.locator('#provider').selectOption('openai');
  await page.locator('#apiKey').fill(openaiKey);
  await page.locator('#provider').selectOption('openrouter');
  await page.locator('#runB').click();
  await expect(page.locator('#status')).toContainText('実際のU²-NetP推論が完了', { timeout: 150000 });
  for (const id of ['exportJson', 'exportSvg', 'exportDxf', 'debugExport']) {
    const pending = page.waitForEvent('download');
    await page.locator('#' + id).click();
    const downloaded = await pending;
    const text = await readFile((await downloaded.path())!, 'utf8');
    expect(text).not.toContain(routerKey); expect(text).not.toContain(openaiKey);
  }
  for (const text of [await page.locator('body').innerText(), page.url(), logs.join('\n'), requests.join('\n')]) {
    expect(text).not.toContain(routerKey); expect(text).not.toContain(openaiKey);
  }
});

test('clear saved key aborts a pending mocked authentication before inference', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => release = resolve);
  const calls: string[] = [];
  await page.route('https://openrouter.ai/**', async route => {
    calls.push(route.request().url());
    await pending;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }) }).catch(() => {});
  });
  await page.goto('/'); await openKeys(page);
  await page.locator('#apiKey').fill(routerKey);
  await page.locator('#consent').check();
  await page.locator('#runA').click();
  await expect.poll(() => calls.length).toBe(1);
  await page.locator('#clearKey').click();
  release();
  await expect(page.locator('#runB')).toBeEnabled();
  expect(calls).toEqual(['https://openrouter.ai/api/v1/key']);
  expect(await page.evaluate(slot => localStorage.getItem(slot), routerSlot)).toBeNull();
  await expect(page.locator('#apiKey')).toHaveValue('');
});
