import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated } from './helpers/index.js';

/**
 * The app shell takes the graphite palette and the app typeface: the page
 * scrollbar's thumb and track resolve from --muted-foreground and --background
 * in both themes, and a toast is set in the body's font, not sonner's own
 * system font stack.
 */

for (const scheme of ['dark', 'light'] as const) {
	test(`the page scrollbar is drawn from the graphite tokens in ${scheme}`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.addInitScript((mode) => localStorage.setItem('mode-watcher-mode', mode), scheme);
		await page.goto('/');
		await ensureAuthenticated(page);
		await (scheme === 'dark'
			? expect(page.locator('html')).toHaveClass(/\bdark\b/)
			: expect(page.locator('html')).not.toHaveClass(/\bdark\b/));

		const colors = await page.evaluate(() => {
			const probe = document.createElement('div');
			probe.style.color = 'color-mix(in oklch, var(--muted-foreground) 45%, transparent)';
			probe.style.backgroundColor = 'var(--background)';
			document.body.append(probe);
			const { color, backgroundColor } = getComputedStyle(probe);
			probe.remove();
			return {
				scrollbar: getComputedStyle(document.documentElement).scrollbarColor,
				thumb: color,
				track: backgroundColor,
				page: getComputedStyle(document.body).backgroundColor,
			};
		});
		expect(colors.scrollbar).toBe(`${colors.thumb} ${colors.track}`);
		expect(colors.track).toBe(colors.page);
	});
}

/**
 * The page tells the browser it draws its own themes, so browser auto dark
 * modes and the Dark Reader extension leave it alone: the root's colour scheme
 * matches the painted theme even after mode-watcher writes its inline one, and
 * a light theme says `only light`, which Chromium's auto dark mode honours.
 */
for (const [scheme, display, expected] of [
	['dark', 'lcd', 'dark'],
	['light', 'lcd', 'light only'],
	['dark', 'eink', 'light only'],
] as const) {
	test(`the root declares ${expected} for the ${scheme} mode on ${display}`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.addInitScript((mode) => localStorage.setItem('mode-watcher-mode', mode), scheme);
		await page.goto(`/?display=${display}`);
		await ensureAuthenticated(page);
		const html = page.locator('html');
		await expect(html).toHaveAttribute('data-display', display);
		await expect.poll(() => html.evaluate((root) => root.style.colorScheme)).toBe(scheme);

		expect(await html.evaluate((root) => getComputedStyle(root).colorScheme)).toBe(expected);
		await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'light dark');
		await expect(page.locator('meta[name="darkreader-lock"]')).toHaveCount(1);
	});
}

test('a toast is set in the app typeface', async ({ page, pageRpc }) => {
	await page.goto('/');
	await ensureAuthenticated(page);
	await pageRpc.call(['dev', 'emit'], {
		type: 'notification',
		payload: {
			show: [
				{
					name: 'app-shell-toast-font',
					type: 'info',
					msg: 'App shell toast font',
					is_dismissable: true,
					is_persistent: false,
					duration: 60,
				},
			],
		},
	});
	const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'App shell toast font' });
	await expect(toast).toBeVisible();

	const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
	expect(bodyFont).not.toBe('');
	expect(await toast.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(bodyFont);
});
