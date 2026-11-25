import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers';

test('cached radio observations appear in modem details and open their readings without action controls', async ({ authedPage: page }) => {
 await navigateTo(page,'network');
 await page.getByTestId('modem-details-toggle').first().click();
 const panel=page.getByTestId('radio-health').first();
 await expect(panel).toBeVisible({timeout:65000});
 await expect(panel).toContainText('Radio health');
 await expect(panel).toContainText('Unavailable');
 // One button opens the readings; nothing in the panel acts on the modem.
 await expect(panel.locator('input,select')).toHaveCount(0);
 await expect(panel.locator('button')).toHaveCount(1);
 await panel.getByTestId('radio-health-open').click();
 await expect(page.getByTestId('radio-health-details')).toBeVisible();
 await expect(panel).not.toContainText('Weak signal');
});
