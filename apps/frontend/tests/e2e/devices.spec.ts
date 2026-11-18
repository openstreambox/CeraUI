import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

/**
 * Network › Devices, against the mock backend's fixture tree.
 * The empty USB-C row is presence, so it must not read as an unknown device.
 */
test.describe("Network devices page", () => {
	test("opens from Network and shows the ports", async ({ page }) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
		await page.getByTestId("open-devices").click();
		await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
		await expect(page.getByText("Upper blue port")).toBeVisible();
		await expect(page.getByText("Lower blue port")).toBeVisible();
		const empty = page.getByTestId("device-empty");
		await expect(empty).toBeVisible();
		await expect(empty).not.toContainText("Unknown");
		await expect(page.getByTestId("device-hint")).toContainText(
			"Kept at USB 2 on purpose",
		);
		await expect(page.getByText("No serial numbers or addresses.")).toBeVisible();
		await page.getByTestId("devices-back").click();
		await expect(page.getByTestId("open-devices")).toBeVisible();
	});
});
