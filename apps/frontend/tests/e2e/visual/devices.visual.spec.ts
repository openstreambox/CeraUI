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
				const ports = page.getByTestId("devices-ports");
				const upper = ports.getByRole("heading", { name: "Upper blue port" });
				const usbC = ports.getByRole("heading", { name: "USB-C data port" });
				await expect(upper).toBeVisible();
				await expect(ports.getByTestId("device-empty")).toBeVisible();
				await page.screenshot({
					path: evidencePath(`devices-${project}-top.png`),
				});
				await usbC.evaluate((element) => {
					const chrome = document.querySelector("header");
					const offset = chrome?.getBoundingClientRect().bottom ?? 0;
					const top =
						element.getBoundingClientRect().top + window.scrollY - offset - 12;
					window.scrollTo(0, Math.max(0, top));
				});
				await expect(usbC).toBeVisible();
				await page.screenshot({
					path: evidencePath(`devices-${project}-usbc.png`),
				});
			},
		);
	}
});
