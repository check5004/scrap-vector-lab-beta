import { expect, type Page } from '@playwright/test';

/** Legacy stage-level regressions deliberately opt into the diagnostic surface.
 * Normal user-path tests must use the primary Analyze control instead.
 */
export async function openDetailsFor(page: Page, selector: string) {
  const ancestors = page.locator('details').filter({ has: page.locator(selector) });
  for (const details of await ancestors.all()) {
    if (await details.evaluate(node => node.hasAttribute('open'))) continue;
    if (await details.getAttribute('id') === 'apiSettings') {
      // Closed API settings are intentionally absent from the layout, including
      // their summary. Use the same visible opener as a person, preserving the
      // chosen analysis method and never starting an analysis or sending data.
      const selectedMethod = await page.locator('[name="analysisMethod"]:checked').inputValue();
      if (await page.locator('#configureKey').isHidden()) await page.locator('#methodA').check();
      await page.locator('#configureKey').click();
      await page.locator(`#method${selectedMethod}`).check();
      await expect(page.locator(`#method${selectedMethod}`)).toBeChecked();
      await expect(details).toHaveAttribute('open', '');
    } else await details.locator(':scope > summary').click();
  }
}
export async function openLegacyDetails(page: Page) {
  await openDetailsFor(page, '#rectify');
  await openDetailsFor(page, '#preset');
  await openDetailsFor(page, '#debugRun');
  await openDetailsFor(page, '#tuneDetails');
  await openDetailsFor(page, '#reviewRun');
  await openDetailsFor(page, '[data-sample="l-shape"]');
}
async function sourceIdle(page: Page, expectedSample?: string) {
  // A previous source's status can remain visible while the next image decodes.
  // Never decide whether calibration is needed until that load is actually idle.
  await expect(page.locator('#analyze')).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#sourceLabel')).not.toContainText('読み込み中');
  if (expectedSample) {
    await expect(page.locator(`[data-sample="${expectedSample}"]`)).toHaveClass(/\bactive\b/);
    await expect(page.locator('#sourceLabel')).toContainText(` / ${expectedSample}`);
  }
}
export async function sourceReady(page: Page, expectedSample?: string) {
  await sourceIdle(page, expectedSample);
  await expect(page.locator('#status')).toContainText('写真を読み込みました', { timeout: 30_000 });
}
export async function startLegacyCalibration(page: Page) {
  await sourceReady(page);
  await openDetailsFor(page, '#rectify');
  await page.locator('#rectify').click();
}
export async function legacyReady(page: Page, expectedSample?: string) {
  await openLegacyDetails(page);
  await sourceIdle(page, expectedSample);
  await expect(page.locator('#status')).toContainText(/写真を読み込みました|平面補正できました/, { timeout: 30_000 });
  if ((await page.locator('#status').textContent())?.includes('写真を読み込みました'))
    await page.locator('#rectify').click();
  await expect(page.locator('#status')).toContainText('平面補正できました', { timeout: 30_000 });
  await expect(page.locator('#runB')).toBeEnabled();
}
export async function openEditor(page: Page) {
  if (await page.locator('#editorSurface').isHidden()) await page.locator('#toggleEditor').click();
}
