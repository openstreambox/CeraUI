import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

type Frame = Record<string, unknown>;

/**
 * With no usable source and no server, the Live bar used to name only the
 * source problem, with no button, and Start did nothing. Now both blockers
 * show at once with a button each, and a tap on the blocked Start leads to
 * them. Runs against the real frontend and the worker's mock backend; the
 * config frames are rewritten so both gates are blocked whatever the worker
 * was seeded with.
 */
async function blockSourceAndServer(page: Page) {
	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				const frame = JSON.parse(text) as Frame;
				const config = frame.config as Frame | undefined;
				if (config) {
					config.source = "e2e-unknown-source";
					config.relay_server = "";
					config.srtla_addr = "";
					delete config.selected_ingest_endpoint;
				}
				ws.send(JSON.stringify(frame));
			} catch {
				ws.send(message);
			}
		});
	});
}

test.describe("A blocked Start lists what to fix", () => {
	test.beforeEach(({ browserName }) => {
		test.skip(browserName !== "chromium", "single-browser layout check");
	});

	test("both blockers show with a button each, and Start leads to them", async ({ page }) => {
		await blockSourceAndServer(page);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");

		const bar = page.getByTestId("live-bar");
		await expect(bar).toContainText("Fix these before you go live");
		const fixes = bar.locator("button[data-fix]");
		await expect(fixes).toHaveText(["Choose source", "Choose destination"]);
		for (const fix of await fixes.all()) {
			const box = await fix.boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}

		const start = bar.getByRole("button", { name: /start stream/i });
		await expect(start).toBeDisabled();
		await start.click();
		await expect(fixes.first()).toBeFocused();

		await fixes.nth(1).click();
		await expect(page.getByRole("dialog")).toBeVisible();
	});

	test("@mobile-only the bar stays inside a phone screen", async ({ page }) => {
		await blockSourceAndServer(page);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "live");
		const bar = page.getByTestId("live-bar");
		await expect(bar.locator("button[data-fix]")).toHaveCount(2);
		const box = await bar.boundingBox();
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	});
});
