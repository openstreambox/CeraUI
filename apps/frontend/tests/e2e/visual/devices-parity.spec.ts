import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, navigateTo, setTheme } from '../helpers/index.js';

/**
 * Mockup next to the running page, at 1280 and 390, light and dark.
 * The default browser gate skips @visual. Run this file on its own.
 */
const OUT = process.env.PARITY_OUT ?? 'test-results/parity';
const MOCK = process.env.PARITY_MOCK ?? '';

const LIGHT = `
html.light {
	color-scheme: light;
	--background: oklch(0.98 0.004 150);
	--foreground: oklch(0.15 0.015 150);
	--card: oklch(0.96 0.004 150);
	--primary: oklch(0.4 0.18 128);
	--primary-foreground: oklch(0.98 0.003 0);
	--secondary: oklch(0.93 0.005 150);
	--muted: oklch(0.92 0.005 150);
	--muted-foreground: oklch(0.42 0.018 150);
	--accent: oklch(0.9 0.006 150);
	--border: oklch(0.88 0.006 150);
	--status-success: oklch(0.5 0.15 150);
	--status-info: oklch(0.5 0.16 245);
	--status-warning: oklch(0.52 0.13 65);
	--status-error: oklch(0.55 0.22 25);
	--status-neutral: oklch(0.45 0.018 150);
	--status-live: oklch(0.45 0.16 128);
	--status-idle: oklch(0.55 0.01 150);
	--link-1: oklch(0.55 0.17 128);
	--link-2: oklch(0.55 0.15 200);
	--link-3: oklch(0.52 0.16 252);
	--link-4: oklch(0.5 0.18 292);
}
`;

const WIDTH = { desktop: 1280, mobile: 390 } as const;

test.describe('@visual devices mockup parity', () => {
	test.describe.configure({ timeout: 180_000 });

	for (const project of ['desktop', 'mobile'] as const) {
		test(`app ${project}`, async ({ page }, testInfo) => {
			test.skip(testInfo.project.name !== project, 'one layout per project');
			const width = WIDTH[project];
			for (const theme of ['dark', 'light'] as const) {
				await page.setViewportSize({ width, height: project === 'desktop' ? 800 : 844 });
				await page.goto('/');
				await ensureAuthenticated(page);
				await setTheme(page, theme);
				await page.reload();
				await ensureAuthenticated(page);
				await navigateTo(page, 'live');
				await expect(page.getByTestId('device-calm-line')).toBeVisible({ timeout: 15_000 });
				await page.screenshot({
					path: `${OUT}/app-live-${width}-${theme}.png`,
					fullPage: true,
				});
				await navigateTo(page, 'network');
				await expect(page.getByTestId('open-devices')).toBeVisible();
				await page.getByTestId('open-devices').scrollIntoViewIfNeeded();
				await page.getByTestId('open-devices').screenshot({
					path: `${OUT}/app-network-card-${width}-${theme}.png`,
				});
				await page.screenshot({
					path: `${OUT}/app-network-${width}-${theme}.png`,
					fullPage: true,
				});
				await page.getByTestId('open-devices').click();
				await expect(page.getByTestId('devices-summary')).toBeVisible();
				await expect(page.getByTestId('devices-where')).toBeVisible();
				await page.screenshot({
					path: `${OUT}/app-devices-${width}-${theme}.png`,
					fullPage: true,
				});
			}
		});

		test(`mock ${project}`, async ({ page }, testInfo) => {
			test.skip(testInfo.project.name !== project, 'one layout per project');
			test.skip(MOCK.length === 0, 'PARITY_MOCK is the mockup directory');
			const width = WIDTH[project];
			for (const theme of ['dark', 'light'] as const) {
				for (const screen of ['devices', 'live', 'network'] as const) {
					const file = screen === 'devices' ? 'index.html' : `${screen}.html`;
					await page.setViewportSize({ width, height: project === 'desktop' ? 800 : 844 });
					await page.goto(`file://${MOCK}/${file}`);
					if (theme === 'light') {
						await page.evaluate((css) => {
							document.documentElement.classList.remove('dark');
							document.documentElement.classList.add('light');
							const style = document.createElement('style');
							style.textContent = css;
							document.head.appendChild(style);
						}, LIGHT);
					}
					await page.screenshot({
						path: `${OUT}/mock-${screen}-${width}-${theme}.png`,
						fullPage: true,
					});
				}
			}
		});
	}
});
