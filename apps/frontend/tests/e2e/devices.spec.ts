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
		const ports = page.getByTestId("devices-ports");
		await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
		await expect(
			ports.getByRole("heading", { name: "Upper blue port" }),
		).toBeVisible();
		await expect(
			ports.getByRole("heading", { name: "Lower blue port" }),
		).toBeVisible();
		const empty = page.getByTestId("device-empty");
		await expect(empty).toBeVisible();
		await expect(empty).not.toContainText("Unknown");
		const rm520 = ports
			.locator('[data-testid="device-row"]')
			.filter({ hasText: "RM520N-GL" })
			.first();
		await expect(rm520.getByTestId("device-hint")).toContainText(
			"Kept at USB 2 on purpose",
		);
		await expect(page.getByText("No serial numbers or addresses.")).toBeVisible();
		await page.getByTestId("devices-back").click();
		await expect(page.getByTestId("open-devices")).toBeVisible();
	});

	test("indents one step per level and keeps wrapped lines at their start", async ({
		page,
	}) => {
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
		await page.getByTestId("open-devices").click();
		const hub = page.locator(
			'[data-testid="device-port"][data-socket="A3-bot"]',
		);
		await expect(hub.getByTestId("device-row").first()).toBeVisible();
		const layout = await hub.evaluate((group) => {
			const left = (element: Element | null | undefined) =>
				element?.getBoundingClientRect().left ?? Number.NaN;
			const heading = group.querySelector("h3");
			const rows = [...group.querySelectorAll('[data-testid="device-row"]')];
			const titleAt = (depth: string) =>
				left(
					rows
						.find((row) => (row as HTMLElement).dataset.depth === depth)
						?.querySelector('[data-testid="device-title"]'),
				);
			// Every text line of every caption under a title starts where that title starts.
			const drift: number[] = [];
			for (const row of rows) {
				const title = left(row.querySelector('[data-testid="device-title"]'));
				for (const caption of row.querySelectorAll(
					':scope > p:not([data-testid="device-title"])',
				)) {
					const range = document.createRange();
					range.selectNodeContents(caption);
					const lines = [...range.getClientRects()].filter((r) => r.width > 0);
					const first = Math.min(...lines.map((r) => r.left));
					drift.push(Math.abs(first - title));
				}
			}
			return {
				port: left(heading),
				device: titleAt("0"),
				child: titleAt("1"),
				drift,
			};
		});
		const step = layout.device - layout.port;
		expect(step).toBeGreaterThan(8);
		expect(Math.abs(layout.child - layout.device - step)).toBeLessThanOrEqual(1);
		expect(layout.drift.length).toBeGreaterThan(0);
		for (const value of layout.drift) expect(value).toBeLessThanOrEqual(1);

		// Each Details target keeps its own 44 px band; neighbours never overlap.
		const bands = await hub
			.getByTestId("device-details-toggle")
			.evaluateAll((buttons) =>
				buttons
					.map((button) => button.getBoundingClientRect())
					.map((rect) => ({ top: rect.top, bottom: rect.bottom }))
					.sort((a, b) => a.top - b.top),
			);
		expect(bands.length).toBeGreaterThan(1);
		for (let index = 1; index < bands.length; index += 1) {
			expect(bands[index]?.top ?? 0).toBeGreaterThanOrEqual(
				(bands[index - 1]?.bottom ?? 0) - 0.5,
			);
		}

		// Nothing paints over a target: a tap near its lower edge still lands on it.
		const covered = await hub
			.getByTestId("device-details-toggle")
			.evaluateAll((buttons) =>
				buttons.filter((button) => {
					const rect = button.getBoundingClientRect();
					button.scrollIntoView({ block: "center" });
					const box = button.getBoundingClientRect();
					const hit = document.elementFromPoint(
						box.left + box.width / 2,
						box.top + rect.height - 2,
					);
					return hit === null || !button.contains(hit);
				}).length,
			);
		expect(covered).toBe(0);

		const child = hub.locator('[data-testid="device-row"][data-depth="1"]').first();
		const toggle = child.getByRole("button", { name: "Details" });
		const box = await toggle.boundingBox();
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		// The development fixture may open this example; toggle from either state.
		const details = child.getByTestId("device-details");
		const initially = await toggle.getAttribute("aria-expanded");
		await toggle.click();
		const flipped = initially === "true" ? "false" : "true";
		await expect(toggle).toHaveAttribute("aria-expanded", flipped);
		await expect(details).toBeVisible({ visible: flipped === "true" });
		if (flipped === "false") {
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
		}
		await expect(details).toBeVisible();
		const [panelLeft, titleLeft] = await child.evaluate((row) => [
			row.querySelector('[data-testid="device-details"]')?.getBoundingClientRect().left ?? 0,
			row.querySelector('[data-testid="device-title"]')?.getBoundingClientRect().left ?? 0,
		]);
		expect(Math.abs(panelLeft - titleLeft)).toBeLessThanOrEqual(1);
	});
});
