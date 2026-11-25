import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers';

// Restart modem under MOCK_SCENARIO: the backend runs the real restart flow with
// the device half replaced (the modem is hidden for 3 s, then listed again).
test('a qualified modem restarts from its Details after the cost is confirmed', async ({ authedPage: page }) => {
	await navigateTo(page, 'network');
	const rm520 = page.locator('[data-testid="modem-row"][data-modem-id="0"]');
	await rm520.getByTestId('modem-details-toggle').click();
	const restart = rm520.getByTestId('modem-restart');
	await expect(restart).toBeVisible({ timeout: 65000 });
	await expect(rm520).toContainText('Offline for about 55 s while it restarts.');

	// The EM7455 has no qualified restart, so it is not offered there.
	const em7455 = page.locator('[data-testid="modem-row"][data-modem-id="1"]');
	await em7455.getByTestId('modem-details-toggle').click();
	await expect(em7455.getByTestId('modem-restart')).toHaveCount(0);

	await restart.click();
	const confirm = page.getByTestId('modem-restart-confirm');
	await expect(confirm).toBeVisible();
	await expect(confirm).toContainText('It drops off for about 55 s while it restarts');
	await page.getByRole('button', { name: 'Restart', exact: true }).click();

	const status = page.getByTestId('modem-restart-status');
	await expect(status).toHaveAttribute('data-phase', 'restarting');
	await expect(status).toContainText('Restarting');
	await expect(status).toHaveAttribute('data-outcome', 'back_connected', { timeout: 30000 });
	await expect(status).toContainText('is back and connected after');

	// The cooldown is the backend's: a second restart right away is refused calmly.
	await page.getByTestId('modem-restart-dismiss').click();
	await expect(status).toHaveCount(0);
	await rm520.getByTestId('modem-restart').click();
	await page.getByRole('button', { name: 'Restart', exact: true }).click();
	await expect(page.getByTestId('modem-restart-status')).toContainText('This modem restarted a moment ago.');
});
