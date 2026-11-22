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

		// A camera app opens a new document with the code in its URL fragment,
		// while the first page stays open on the setup form.
		const scan = await context.newPage();
		await scan.goto(`/#claim=${code}`);
		const scanSubmit = scan.getByRole("button", { name: "Set up box" });
		await expect(scanSubmit).toBeEnabled({ timeout: 60_000 });
		await expect(scan).toHaveURL(/\/$/);
		await scanSubmit.click();
		await expect(scan.locator("header").first()).toBeVisible();
		await expect.poll(() => scan.evaluate(() => Boolean(localStorage.getItem("auth")))).toBe(true);

		// The stale setup page reconnects into the normal sign-in view.
		await expect(page.getByLabel("Password", { exact: true })).toBeVisible({ timeout: 30_000 });
		await expect(setupCode).toHaveCount(0);

		await scan.reload();
		await expect(scan.locator("header").first()).toBeVisible();
	} finally {
		await backend.stop();
	}
});

test("a lost claim reply still signs the browser in", async ({ baseURL, context, page }) => {
	const backend = await startWorkerBackend({
		setupAuth: { claimDigest: createHash("sha256").update(code).digest("hex") },
	});
	try {
		await routeBackend(context, baseURL, backend);
		let dropped = false;
		await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
			const server = socket.connectToServer();
			let claimId: string | undefined;
			socket.onMessage((message) => {
				server.send(message);
				if (typeof message !== "string" || dropped) return;
				const frame = JSON.parse(message);
				if (Array.isArray(frame.path) && frame.path.join(".") === "auth.claimLocalOwner") {
					claimId = frame.id;
				}
			});
			server.onMessage((message) => {
				if (claimId !== undefined && typeof message === "string" && JSON.parse(message).id === claimId) {
					// The box committed; the reply and the link are lost together.
					dropped = true;
					claimId = undefined;
					void socket.close();
					void server.close();
					return;
				}
				socket.send(message);
			});
		});
		await page.goto("/");
		const setupCode = page.getByLabel("Setup code");
		await expect(setupCode).toBeVisible({ timeout: 60_000 });
		await setupCode.fill(code);
		await page.getByRole("button", { name: "Set up box" }).click();
		await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
		expect(dropped).toBe(true);
		await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem("auth")))).toBe(true);
		await page.reload();
		await expect(page.locator("header").first()).toBeVisible();
	} finally {
		await backend.stop();
	}
});
