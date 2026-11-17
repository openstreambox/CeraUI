import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, setLocale } from "./helpers/index.js";

// The update takeover once carried a decorative wash: an overflow-hidden layer
// of blurred circles larger than the sheet, which a script could scroll. The
// takeover needs no such layer; it must still cover the app and show its phase.
for (const { code, dir } of [
	{ code: "en", dir: "ltr" },
	{ code: "ar", dir: "rtl" },
] as const) {
	test(`the update overlay has no scrollable layer and still blocks the app (${dir})`, async ({
		page,
		pageRpc,
	}) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		await setLocale(page, code);
		await page.goto("/");
		await ensureAuthenticated(page);
		await expect(page.locator("html")).toHaveAttribute("dir", dir);

		// A mid-flight frame: no `result`, so neither terminal state is shown.
		await pageRpc.call(["dev", "emit"], {
			type: "status",
			payload: { updating: { downloading: 2, unpacking: 0, setting_up: 0, total: 6 } },
		});
		const overlay = page.getByTestId("updating-overlay");
		await expect(overlay.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
		// The sheet slides in; measure it at rest.
		await page.evaluate(() =>
			Promise.all(
				document
					.getAnimations()
					.filter(
						(animation) =>
							animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY,
					)
					.map((animation) => animation.finished.catch(() => undefined)),
			),
		);
		await expect(overlay.getByTestId("update-phase")).toBeInViewport({ ratio: 1 });
		await expect(overlay.getByRole("progressbar")).toBeVisible();

		const layout = await overlay.evaluate((root) => {
			const scrollableLayers = [root, ...root.children].flatMap((layer) => {
				layer.scrollTo({ left: 1e6, top: 1e6, behavior: "instant" });
				const ahead = { left: layer.scrollLeft, top: layer.scrollTop };
				layer.scrollTo({ left: -1e6, top: 0, behavior: "instant" });
				const behind = layer.scrollLeft;
				return ahead.left || ahead.top || behind
					? [{ layer: layer.getAttribute("class"), ahead, behind }]
					: [];
			});
			// Every point a pointer can reach lands on the sheet or its backdrop.
			const backdrop = document.querySelector('[data-slot="drawer-overlay"]');
			const exposedApp: string[] = [];
			for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
				for (const fy of [0, 0.25, 0.5, 0.75, 1]) {
					const x = Math.min(fx * window.innerWidth, window.innerWidth - 1);
					const y = Math.min(fy * window.innerHeight, window.innerHeight - 1);
					const hit = document.elementFromPoint(x, y);
					if (hit && !root.contains(hit) && !backdrop?.contains(hit)) {
						exposedApp.push(`${x},${y} ${hit.tagName} ${hit.getAttribute("class")}`);
					}
				}
			}
			return { scrollableLayers, exposedApp };
		});
		const detail = JSON.stringify(layout);
		expect(layout.scrollableLayers, detail).toEqual([]);
		expect(layout.exposedApp, detail).toEqual([]);
		await expect(overlay.getByTestId("update-phase")).toBeInViewport({ ratio: 1 });
	});
}
