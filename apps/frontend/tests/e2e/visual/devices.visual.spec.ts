import { expect, test } from "../fixtures/index.js";
import {
	ensureAuthenticated,
	evidencePath,
	navigateTo,
} from "../helpers/index.js";

/**
 * Phone and desk captures of Network › Devices. Evidence only: the functional
 * spec owns the assertions. The mock backend publishes a fixture tree, so
 * these shots are not the developer machine's USB bus.
 */
test.describe("@visual Network devices", () => {
	for (const project of ["desktop", "mobile"] as const) {
		test(
			`@visual devices page at ${project}`,
			{ tag: "@visual" },
			async ({ page }, testInfo) => {
				test.skip(
					testInfo.project.name !== project,
					"one capture per layout",
				);
				await page.goto("/");
				await ensureAuthenticated(page);
				await navigateTo(page, "network");
				await page.getByTestId("open-devices").click();
				const view = page.getByTestId("devices-page");
				await expect(view.getByText("Upper blue port")).toBeVisible();
				await expect(view.getByTestId("device-empty")).toBeVisible();
				await view.screenshot({
					path: evidencePath(`devices-${project}.png`),
				});
			},
		);
	}
});
