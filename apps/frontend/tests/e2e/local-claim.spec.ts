import { createHash } from "node:crypto";
import { type BrowserContext, expect, test } from "@playwright/test";
import { startWorkerBackend } from "./fixtures/backend.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

const code = "1234567890abcdef1234567890abcdef";

async function routeBackend(
	context: BrowserContext,
	baseURL: string | undefined,
	backend: { port: number; proxySecret: string },
) {
	if (process.env.CI === "true") {
		await context.addCookies([{
			name: "ceraui_e2e_backend_port",
			value: `${backend.port}.${backend.proxySecret}`,
			url: baseURL,
			httpOnly: true,
			sameSite: "Strict",
		}]);
	} else {
		await context.addInitScript((port) => {
			(window as Window & { __ceraSocketPort?: number }).__ceraSocketPort = port;
		}, backend.port);
	}
}

test("a fresh box without claim mode still offers password setup", async ({
	baseURL,
	context,
	page,
}, testInfo) => {
	const backend = await startWorkerBackend({ setupAuth: "password" });
	try {
		await routeBackend(context, baseURL, backend);
		await page.goto("/");
		await expect(page.getByLabel("New Password", { exact: true })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByLabel("Setup code")).toHaveCount(0);
		if (process.env.E2E_CAPTURE_SETUP_SCREENS === "1") {
			await page.screenshot({ path: testInfo.outputPath("password-setup.png") });
		}
	} finally {
		await backend.stop();
	}
});

test("a scanned setup code claims a fresh box and remembers the browser", async ({
	baseURL,
	context,
	page,
}, testInfo) => {
	const backend = await startWorkerBackend({
		setupAuth: { claimDigest: createHash("sha256").update(code).digest("hex") },
	});
	try {
		await routeBackend(context, baseURL, backend);
		const setupCode = page.getByLabel("Setup code");
		const submit = page.getByRole("button", { name: "Set up box" });
		await page.goto("/");
		await expect(setupCode).toBeVisible({ timeout: 60_000 });
		await page.evaluate(() => document.getElementById("js-failed")?.remove());
		await expect(page.getByLabel("New Password", { exact: true })).toHaveCount(0);
		if (process.env.E2E_CAPTURE_SETUP_SCREENS === "1") {
			await page.screenshot({ path: testInfo.outputPath("code-setup.png") });
		}
		await setupCode.fill("0".repeat(32));
		await submit.click();
		await expect(page.getByRole("alert")).toContainText("Check the code");
		await expect(setupCode).toBeEmpty();

		// A camera app opens a new document with the code in its URL fragment.
		await page.goto(`/#claim=${code}`);
		await page.reload();
		await expect(submit).toBeEnabled();
		await expect(page).toHaveURL(/\/$/);
		await submit.click();
		await expect(page.locator("header").first()).toBeVisible();
		await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem("auth")))).toBe(true);

		await page.reload();
		await expect(page.locator("header").first()).toBeVisible();
	} finally {
		await backend.stop();
	}
});
