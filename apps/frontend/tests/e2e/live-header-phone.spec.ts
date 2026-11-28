import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo, setLocale } from "./helpers/index.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

/**
 * The Live header's state chip is the one label a streamer reads at a glance on
 * a phone. At 390 px the chip used to wrap to "NOT / STREAMING" on two lines.
 * jsdom cannot measure layout, so this checks the rendered geometry: the chip
 * stays on one line and the header never pushes the page sideways. German and
 * Hindi carry the longest idle labels.
 */
const CASES = [
	{ locale: "en", width: 390 },
	{ locale: "en", width: 360 },
	{ locale: "de", width: 390 },
	{ locale: "hi", width: 390 },
] as const;

for (const { locale, width } of CASES) {
	test(`Live header keeps the state chip on one line (${locale}, ${width} px)`, {
		tag: "@mobile-only",
	}, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 });
		await page.goto("/");
		await ensureAuthenticated(page);
		if (locale !== "en") {
			await setLocale(page, locale);
			await page.reload();
			await ensureAuthenticated(page);
		}
		await navigateTo(page, "live");
		const header = page.locator("#main-content header").first();
		await expect(header).toBeVisible();

		const geometry = await header.evaluate((el) => {
			const chip = el.firstElementChild as HTMLElement | null;
			if (!chip) throw new Error("Live header has no state chip");
			const style = getComputedStyle(chip);
			const box = chip.getBoundingClientRect();
			return {
				chipHeight: box.height,
				chipRight: box.right,
				lineHeight: Number.parseFloat(style.lineHeight),
				paddingY:
					Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
				borderY:
					Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth),
				viewport: document.documentElement.clientWidth,
				pageScrollWidth: document.documentElement.scrollWidth,
			};
		});
		const detail = JSON.stringify(geometry);
		// One text line: content height is below two line heights.
		const content = geometry.chipHeight - geometry.paddingY - geometry.borderY;
		expect(content < geometry.lineHeight * 1.5, detail).toBe(true);
		expect(geometry.chipRight <= geometry.viewport + 1, detail).toBe(true);
		expect(geometry.pageScrollWidth <= geometry.viewport + 1, detail).toBe(true);
	});
}
