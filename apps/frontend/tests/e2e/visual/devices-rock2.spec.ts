import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "../fixtures/index.js";
import { ensureAuthenticated, navigateTo, setTheme } from "../helpers/index.js";

/**
 * The image 3 tree, next to the mockups. Skipped unless CERAUI_USB_SYSFS
 * points at that fixture. ROCK2_EXPECT_FOLD=1 checks the controllers are
 * not their own port headings.
 */
const OUT = process.env.ROCK2_OUT ?? "test-results/rock2";
const MOCK = process.env.PARITY_MOCK ?? "";
const LABEL = process.env.ROCK2_LABEL ?? "after";

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

test.describe("@visual image 3 devices", () => {
	test.describe.configure({ timeout: 180_000 });
	test.skip(
		!process.env.CERAUI_USB_SYSFS,
		"CERAUI_USB_SYSFS is the image 3 sysfs fixture",
	);

	for (const project of ["desktop", "mobile"] as const) {
		test(`app ${project}`, async ({ page }, testInfo) => {
			test.skip(testInfo.project.name !== project, "one layout per project");
			mkdirSync(OUT, { recursive: true });
			const width = WIDTH[project];
			for (const theme of ["dark", "light"] as const) {
				await page.setViewportSize({
					width,
					height: project === "desktop" ? 800 : 844,
				});
				await page.goto("/");
				await ensureAuthenticated(page);
				await setTheme(page, theme);
				await page.reload();
				await ensureAuthenticated(page);
				await navigateTo(page, "network");
				await page.getByTestId("open-devices").click();
				await expect(page.getByTestId("devices-ports")).toBeVisible();
				await expect(
					page.getByRole("heading", { name: "Lower blue port" }),
				).toBeVisible({ timeout: 20_000 });
				const hubs = page.getByRole("heading", { name: "USB root hub" });
				if (process.env.ROCK2_EXPECT_FOLD === "1") {
					await expect(hubs).toHaveCount(0);
					await expect(
						page.getByRole("heading", { name: "Built in" }),
					).toBeVisible();
					await expect(page.getByText("Bluetooth Radio")).toBeVisible();
					const internals = page.getByTestId("device-internals");
					await expect(internals).toBeVisible();
					await expect(internals).not.toHaveAttribute("open");
				}
				const closed = await page.evaluate(
					() => document.documentElement.scrollHeight,
				);
				await page.screenshot({
					path: path.join(OUT, `${LABEL}-${width}-${theme}.png`),
					fullPage: true,
				});
				await page.locator("details").evaluateAll((nodes) => {
					for (const node of nodes) node.setAttribute("open", "");
				});
				const toggles = page.getByRole("button", { name: "Details" });
				expect(await toggles.count()).toBeGreaterThan(0);
				for (const toggle of await toggles.all()) {
					if ((await toggle.getAttribute("aria-expanded")) !== "true") {
						await toggle.click();
					}
					await expect(toggle).toHaveAttribute("aria-expanded", "true");
					const panel = await toggle.getAttribute("aria-controls");
					await expect(page.locator(`[id="${panel}"]`)).toBeVisible();
				}
				const opened = await page.evaluate(
					() => document.documentElement.scrollHeight,
				);
				appendFileSync(
					path.join(OUT, "heights.txt"),
					`${LABEL} ${width} ${theme} closed ${closed} opened ${opened}\n`,
				);
			}
		});

		test(`mock ${project}`, async ({ page }, testInfo) => {
			test.skip(testInfo.project.name !== project, "one layout per project");
			test.skip(MOCK.length === 0, "PARITY_MOCK is the mockup directory");
			test.skip(LABEL !== "after", "mockups are captured once");
			mkdirSync(OUT, { recursive: true });
			const width = WIDTH[project];
			for (const theme of ["dark", "light"] as const) {
				await page.setViewportSize({
					width,
					height: project === "desktop" ? 800 : 844,
				});
				await page.goto(`file://${MOCK}/index.html`);
				if (theme === "light") {
					await page.evaluate((css) => {
						document.documentElement.classList.remove("dark");
						document.documentElement.classList.add("light");
						const style = document.createElement("style");
						style.textContent = css;
						document.head.appendChild(style);
					}, LIGHT);
				}
				await page.screenshot({
					path: path.join(OUT, `mock-${width}-${theme}.png`),
					fullPage: true,
				});
			}
		});
	}
});
