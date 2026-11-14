import path from 'node:path';
import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';

test('heat settings and live client controls @visual', async ({ page, pageRpc }, testInfo) => {
 const shots = process.env.HEAT_SHOTS ?? testInfo.outputDir;
 const shot = (state: string) => page.screenshot({ path: path.join(shots, `${state}-${testInfo.project.name}.png`) });
 await page.goto('/');
 await ensureAuthenticated(page);
 await navigateTo(page, 'settings');
 await page.getByTestId('settings-entry-heat').click();
 const dialog = page.getByRole('dialog', { name: 'Heat', exact: true });
 const toggle = dialog.getByRole('checkbox', { name: 'Suggest only' });
 await expect(toggle).toBeEnabled();
 await expect(toggle).not.toBeChecked();
 await expect(dialog.getByText(/not active on this box yet/)).toBeVisible();
 await shot('after-auto');
 await toggle.click();
 await expect(toggle).toBeChecked();
 await expect.poll(async () => (await pageRpc.call(['streaming', 'getLinkBoxHeat'])).mode).toBe('suggest');
 await shot('after-suggest');
 await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
 await page.getByTestId('settings-entry-heat').click();
 await expect(dialog.getByRole('checkbox', { name: 'Suggest only' })).toBeChecked();
 await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
 await navigateTo(page, 'live');
 expect(await pageRpc.call(['streaming', 'start'], { source: 'usb', max_br: 6000 })).toMatchObject({ success: true });
 const heat = {
  stage: 3, unknown: false, keepQuality: false, ceiling: null, reduced: false,
  cannotReduce: false, error: false, phoneAdvice: false, history: [],
 };
 await pageRpc.call(['dev', 'emit'], { type: 'heat', payload: heat });
 const notice = page.getByRole('complementary', { name: 'Heat', exact: true });
 await expect(notice).toBeVisible();
 await notice.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 80));
 await expect(notice).toBeInViewport();
 await shot('before-controls');
 await pageRpc.call(['dev', 'emit'], { type: 'heat', payload: { ...heat, linkBox: { paused: null, suggestion: 'sample-device' } } });
 await expect(notice.getByRole('button', { name: 'Pause one device' })).toBeVisible();
 await notice.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 80));
 await expect(notice.getByRole('button', { name: 'Pause one device' })).toBeInViewport();
 await shot('after-offer');
 await pageRpc.call(['dev', 'emit'], { type: 'heat', payload: { ...heat, linkBox: { paused: 'sample-device', suggestion: null } } });
 await expect(notice.getByRole('button', { name: 'Let back on' })).toBeVisible();
 await notice.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 80));
 await expect(notice.getByRole('button', { name: 'Let back on' })).toBeInViewport();
 await shot('after-paused');
 expect(await pageRpc.call(['streaming', 'linkBoxHeatAction'], { action: 'restore', id: 'sample-device' })).toEqual({ success: false });
 await pageRpc.call(['dev', 'emit'], { type: 'heat', payload: { ...heat, linkBox: { paused: null, suggestion: 'sample-device' } } });
 // Production has no bound measured owner: a forged UI projection cannot pause traffic.
 await notice.getByRole('button', { name: 'Pause one device' }).click();
 await expect(notice.getByRole('alert')).toContainText('could not be confirmed');

});
