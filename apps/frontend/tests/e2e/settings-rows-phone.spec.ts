import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo, setLocale } from "./helpers/index.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

/**
 * Settings rows pair a title with a one-sentence description. At 390 px the
 * description was truncated to one line, which hid most of each sentence,
 * including the "what happens next" half of the remote-control status
 * ("Paired, but the control channel is offline. Rec…"). jsdom cannot measure
 * layout, so this checks the rendered rows: no description is clipped.
 */
for (const locale of ["en", "de"] as const) {
	test(`Settings row descriptions are readable in full on a phone (${locale})`, {
		tag: "@mobile-only",
	}, async ({ page }) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		if (locale !== "en") {
			await setLocale(page, locale);
			await page.reload();
			await ensureAuthenticated(page);
		}
		await navigateTo(page, "settings");
		await expect(page.getByTestId("remote-control-status")).toBeVisible();

		const descriptions = await page.evaluate(() => {
			const rows = [
				...document.querySelectorAll('[data-testid^="settings-entry-"]'),
				...document.querySelectorAll('[data-testid="remote-control-status"]'),
			];
			return rows.flatMap((row) =>
				Array.from(row.querySelectorAll("span.text-muted-foreground.text-xs"), (el) => ({
					row: row.getAttribute("data-testid"),
					text: el.textContent?.trim() ?? "",
					clipped: el.scrollWidth > el.clientWidth + 1,
				})),
			);
		});
		expect(descriptions.length).toBeGreaterThan(5);
		expect(
			descriptions.filter((d) => d.clipped),
			JSON.stringify(descriptions.filter((d) => d.clipped)),
		).toEqual([]);
	});
}
