import { expect, test } from './fixtures/phone-home.js';
import { ensureAuthenticated, evidencePath } from './helpers/index.js';
import { NetworkPage } from './pages/network.js';

/**
 * D16 S step, in the real rendered app at a phone and a computer width:
 *
 *   - the hotspot dialog's Wi-Fi code is hidden until Show code, with an
 *     empty frame of the same size, and the off-camera line while shown;
 *   - New Wi-Fi password asks first and names the cost;
 *   - on the phone Home's join step, a new device on the roster hides a shown
 *     code and says "A new device joined · just now · Not mine?" in place, and
 *     Not mine opens the same confirmation (with the stream line, because the
 *     fixture says a stream may be going through the box).
 */

for (const width of [390, 1280]) {
	test(`hotspot dialog Wi-Fi code @visual at ${width}px`, async ({ authedPage: page }) => {
		await page.setViewportSize({ width, height: 900 });
		const network = new NetworkPage(page);
		await network.open();
		await network.openHotspot();
		await network.startHotspotThroughGate();

		const dialog = page.getByRole('dialog', { name: 'Configure Hotspot' });
		const card = dialog.getByTestId('wifi-code');
		const frame = card.getByTestId('wifi-code-frame');
		const show = card.getByRole('button', { name: 'Show code', exact: true });
		await expect(show).toHaveAttribute('aria-expanded', 'false');
		await expect(frame.locator('img')).toHaveCount(0);
		const hiddenBox = await frame.boundingBox();
		await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await page.screenshot({ path: evidencePath(`wifi-code-dialog-hidden-${width}.png`) });

		await show.click();
		await expect(frame.locator('img')).toHaveAttribute('src', /^data:image\/png/);
		await expect(card).toContainText('Keep this off camera. It hides itself after 2 minutes.');
		// Nothing moves when it opens: the frame keeps its size.
		const shownBox = await frame.boundingBox();
		expect(shownBox?.width).toBe(hiddenBox?.width);
		expect(shownBox?.height).toBe(hiddenBox?.height);
		await page.screenshot({ path: evidencePath(`wifi-code-dialog-shown-${width}.png`) });

		const hide = card.getByRole('button', { name: 'Hide', exact: true });
		await expect(hide).toHaveAttribute('aria-expanded', 'true');
		await hide.click();
		await expect(frame.locator('img')).toHaveCount(0);

		await card.getByRole('button', { name: 'New Wi-Fi password', exact: true }).click();
		const confirm = card.getByRole('group', { name: 'Make a new Wi-Fi password?' });
		await expect(confirm).toContainText(
			"Every device on the box's Wi-Fi drops and has to join again with the new code.",
		);
		await expect(confirm).not.toContainText(/not live|offline/i);
		await confirm.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await page.screenshot({ path: evidencePath(`wifi-code-dialog-confirm-${width}.png`) });
		await confirm.getByRole('button', { name: 'Keep this one', exact: true }).click();
		await expect(confirm).toBeHidden();

		expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	});

	test(`phone Home join notice @visual at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/');
		await ensureAuthenticated(page);
		await page.evaluate(async () => {
			const fixture = window.PhoneHomeFixture;
			await fixture.preparePhoneHomeFixture();
			fixture.mountPhoneHomeFixture(false, false, true);
			fixture.emitFixtureRoster(['02:00:5e:10:00:01']);
		});
		const home = page.getByTestId('phone-home-fixture');
		await home.getByRole('button', { name: 'Connect your phone', exact: true }).click();
		const card = home.getByTestId('wifi-code');

		if (width === 1280) {
			await card.getByRole('button', { name: 'Show code', exact: true }).click();
			await expect(card.getByTestId('wifi-code-frame').locator('img')).toHaveCount(1);
		} else {
			// A phone gets no QR of the box's own Wi-Fi, only the lines below.
			await expect(card.getByRole('button', { name: 'Show code' })).toHaveCount(0);
		}

		await page.evaluate(async () => {
			const fixture = window.PhoneHomeFixture;
			await fixture.preparePhoneHomeFixture();
			fixture.emitFixtureRoster(['02:00:5e:10:00:01', '02:00:5e:10:00:02']);
		});
		const joined = card.getByTestId('wifi-code-joined');
		await expect(joined).toContainText('A new device joined · just now');
		if (width === 1280) {
			await expect(card.getByTestId('wifi-code-frame').locator('img')).toHaveCount(0);
			await expect(card.getByRole('button', { name: 'Show code', exact: true })).toBeVisible();
		}
		await joined.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await page.screenshot({ path: evidencePath(`wifi-code-joined-${width}.png`) });

		await joined.getByRole('button', { name: 'Not mine?', exact: true }).click();
		const confirm = card.getByRole('group', { name: 'Make a new Wi-Fi password?' });
		await expect(confirm).toContainText(
			'If your phone is streaming through the box, that stream drops',
		);
		await confirm.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await page.screenshot({ path: evidencePath(`wifi-code-not-mine-${width}.png`) });
		expect(await home.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	});
}
