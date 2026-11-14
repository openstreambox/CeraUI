import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';


// Status fixtures exercise the real subscription and live panel. Engine
// mutation and persistence are covered separately by backend contract tests.
test('heat status names the confirmed ceiling and preserves unknown and override warnings', async ({
 page,
 pageRpc,
}) => {
 await page.goto('/');
 await ensureAuthenticated(page);
 await navigateTo(page, 'live');
 expect(await pageRpc.call(['streaming','start'],{source:'usb',max_br:6000})).toMatchObject({success:true});
 await expect(page.getByTestId('live-cockpit')).toBeVisible();
 const heat = {
  stage: 2, unknown: false, keepQuality: false, ceiling: 4500,
  reduced: true, cannotReduce: false, error: false, phoneAdvice: true, history: [],
 };
 const emit = (payload: typeof heat) => pageRpc.call(['dev', 'emit'], { type: 'heat', payload });
 await emit(heat);
 const notice = page.getByRole('complementary', { name: 'Heat', exact: true });
 await expect(notice.getByRole('status')).toHaveText(/bitrate capped at 4.5 Mbit\/s.*Still live/);
 await expect(notice.getByRole('button', { name: 'Keep quality' })).toHaveAttribute('aria-pressed', 'false');
 await emit({ ...heat, unknown: true });
 await expect(notice.getByRole('status')).toHaveText('Temperature unavailable. Heat adjustments are paused.');
 await emit({ ...heat, keepQuality: true, reduced: false, ceiling: 6000 });
 await expect(notice.getByRole('status')).toHaveText(/Keeping full quality.*stays hot/);
 await expect(notice.getByRole('button', { name: 'Keep quality' })).toHaveAttribute('aria-pressed', 'true');
});
