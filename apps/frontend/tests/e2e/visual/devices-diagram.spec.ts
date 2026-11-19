import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, navigateTo, setLocale, setTheme } from '../helpers/index.js';

/**
 * The port-edge diagram, large enough to read, with the contact bars clear of
 * the captions. English at 1280 and 390, light and dark, plus one German phone
 * capture. The default browser gate skips @visual.
 */
const OUT = process.env.PARITY_OUT ?? 'test-results/diagram';

const WIDTH = { desktop: 1280, mobile: 390 } as const;

test.describe('@visual devices diagram', () => {
	test.describe.configure({ timeout: 180_000 });

	for (const project of ['desktop', 'mobile'] as const) {
		test(`diagram ${project}`, async ({ page }, testInfo) => {
			test.skip(testInfo.project.name !== project, 'one layout per project');
			const width = WIDTH[project];
			for (const theme of ['dark', 'light'] as const) {
				await page.setViewportSize({ width, height: project === 'desktop' ? 800 : 844 });
				await page.goto('/');
				await ensureAuthenticated(page);
				await setTheme(page, theme);
				await page.reload();
				await ensureAuthenticated(page);
				await navigateTo(page, 'network');
				await page.getByTestId('open-devices').click();
				const diagram = page.getByTestId('devices-where');
				await expect(diagram).toBeVisible();
				await diagram.scrollIntoViewIfNeeded();
				await diagram.screenshot({ path: `${OUT}/diagram-${width}-${theme}.png` });

				const usbC = page.getByTestId('device-empty');
				await usbC.getByText('Details for helpers').click();
				await expect(usbC).toContainText('VBUS regulator');
				await expect(usbC).toContainText('Enabled');
				await expect(usbC).toContainText('Recovered');
				await expect(usbC).toContainText('Re-arm 2/3');
				await usbC.screenshot({ path: `${OUT}/helper-j11-${width}-${theme}.png` });

				const modem = page
					.locator('[data-testid="device-row"]')
					.filter({ hasText: 'RM520N-GL' })
					.first();
				await expect(modem).toContainText('Stored as 20');
				await expect(modem).toContainText('Back on USB 2');
				await modem.scrollIntoViewIfNeeded();
				await modem.screenshot({ path: `${OUT}/helper-rm520-${width}-${theme}.png` });
			}
		});
	}

	test('diagram de phone dark', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'one phone capture');
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		await ensureAuthenticated(page);
		await setLocale(page, 'de');
		await setTheme(page, 'dark');
		await page.reload();
		await ensureAuthenticated(page);
		await navigateTo(page, 'network');
		await page.getByTestId('open-devices').click();
		const diagram = page.getByTestId('devices-where');
		await expect(diagram).toBeVisible();
		await expect(diagram).toContainText('WLAN');
		await expect(diagram).toContainText('Verteiler');
		await diagram.scrollIntoViewIfNeeded();
		await diagram.screenshot({ path: `${OUT}/diagram-390-dark-de.png` });
	});
});
