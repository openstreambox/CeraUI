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
 const open=panel.getByTestId('radio-health-open');
 await open.click();
 const details=page.getByTestId('radio-health-details');
 await expect(details).toBeVisible();
 // The read-only body is a tab stop, so the keyboard can scroll it.
 await details.focus();
 await expect(details).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(details).toBeHidden();
 await expect(open).toBeFocused();
 await expect(panel).not.toContainText('Weak signal');
});
