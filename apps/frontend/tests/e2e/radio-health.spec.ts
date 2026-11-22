import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers';

test('cached radio observations appear in modem details without action controls', async ({ authedPage: page }) => {
 await navigateTo(page,'network');
 await page.getByTestId('modem-details-toggle').first().click();
 const panel=page.getByTestId('radio-health').first();
 await expect(panel).toBeVisible({timeout:65000});
 await expect(panel).toContainText('Radio health');
 await expect(panel).toContainText('Unavailable');
 await expect(panel.locator('button,input,select')).toHaveCount(0);
 await expect(panel).not.toContainText('Weak signal');
});
