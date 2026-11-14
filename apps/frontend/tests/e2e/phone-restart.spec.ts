import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, evidencePath } from './helpers/index.js';

// Restart is never a dead end on a phone-only box. While it carries a
// phone's stream, Restart opens the power dialog, which asks for a hold (or the
// plain alternative) and then a confirmation that names the cost.
for (const width of [390, 1280]) {
	test(`restart while carrying @visual asks for a hold and names the cost at ${width}px`, async ({
		page,
		pageRpc,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/');
		await ensureAuthenticated(page);
		await pageRpc.call(['system', 'setPhoneWay'], 'srt');
		await page.reload();
		await ensureAuthenticated(page);
		await pageRpc.call(['dev', 'emit'], {
			type: 'status',
			payload: {
				phone_box: true,
				carrying: { state: 'streaming', startup: false },
				box_health: [{ part: 'cellular', since: Date.now() }],
			},
		});
		const home = page.getByTestId('phone-home');
		await expect(home.getByRole('heading', { name: "Carrying your phone's stream" })).toBeVisible();
		const restart = home.getByRole('button', { name: 'Restart the box', exact: true });
		await expect(restart).toBeEnabled();
		await expect(home).toContainText('You can still restart. The box asks first and says what stops.');
		const health = home.locator('section').filter({ has: page.getByRole('heading', { name: 'Box health', exact: true }) });
		await health.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await health.screenshot({ path: evidencePath(`phone-restart-health-${width}.png`) });

		await restart.click();
		const power = page.getByRole('dialog', { name: 'Reboot / Power' });
		const hold = power.getByRole('button', { name: 'Hold to restart' });
		await expect(hold).toBeVisible();
		await expect(power.getByRole('button', { name: 'Restart without holding' })).toBeVisible();
		await expect(power).toContainText('With IRL Pro or another SRT app, your stream stops');
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await page.screenshot({ path: evidencePath(`phone-restart-dialog-${width}.png`) });

		// A short tap only explains the hold.
		await hold.click();
		await expect(power).toContainText('Hold the button for a second, or use Restart without holding.');
		await expect(page.getByRole('dialog', { name: 'Restart the box now?' })).toHaveCount(0);

		// A real one-second hold opens the confirmation.
		const box = await hold.boundingBox();
		if (!box) throw new Error('hold button has no box');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.waitForTimeout(1200);
		await page.mouse.up();
		const confirm = page.getByRole('dialog', { name: 'Restart the box now?' });
		await expect(confirm).toBeVisible();
		await expect(confirm.getByRole('button', { name: 'Restart anyway' })).toBeVisible();
		await expect(confirm).toContainText('your stream stops until the box is back');
		await page.screenshot({ path: evidencePath(`phone-restart-confirm-${width}.png`) });
	});
}
