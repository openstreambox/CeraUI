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

test("lost claim and login replies keep the browser able to sign in", async ({
	baseURL,
	context,
	page,
}, testInfo) => {
	const backend = await startWorkerBackend({
		setupAuth: { claimDigest: createHash("sha256").update(code).digest("hex") },
	});
	try {
		await routeBackend(context, baseURL, backend);
		let claimDropped = false;
		let holdLogins = true;
		let loginsDropped = 0;
		await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
			const server = socket.connectToServer();
			const dropIds = new Set<string>();
			socket.onMessage((message) => {
				server.send(message);
				if (typeof message !== "string") return;
				const frame = JSON.parse(message);
				const path = Array.isArray(frame.path) ? frame.path.join(".") : "";
				if (path === "auth.claimLocalOwner" && !claimDropped) dropIds.add(frame.id);
				if (path === "auth.login" && holdLogins) dropIds.add(frame.id);
			});
			server.onMessage((message) => {
				const id = typeof message === "string" ? JSON.parse(message).id : undefined;
				if (id !== undefined && dropIds.has(id)) {
					// The box answered; the reply and the link are lost together.
					if (!claimDropped) claimDropped = true;
					else loginsDropped += 1;
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

		// The box committed, so the page must not blame the code.
		const retry = page.getByRole("button", { name: "Try again" });
		await expect(retry).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText("did not confirm setup")).toBeVisible();
		await expect(page.getByText("Check the code")).toHaveCount(0);
		expect(claimDropped).toBe(true);
		expect(loginsDropped).toBeGreaterThan(0);
		if (process.env.E2E_CAPTURE_SETUP_SCREENS === "1") {
			await page.evaluate(() => document.getElementById("js-failed")?.remove());
			await page.screenshot({ path: testInfo.outputPath("code-unconfirmed.png") });
		}

		holdLogins = false;
		await retry.click();
		await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem("auth")))).toBe(true);
		await page.reload();
		await expect(page.locator("header").first()).toBeVisible();
	} finally {
		await backend.stop();
	}
});

test("a browser that refuses token storage stays signed in for the visit", async ({
	baseURL,
	context,
	page,
}, testInfo) => {
	const backend = await startWorkerBackend({
		setupAuth: { claimDigest: createHash("sha256").update(code).digest("hex") },
	});
	try {
		await routeBackend(context, baseURL, backend);
		// Site storage works for the probe but refuses the sign-in token.
		await context.addInitScript(() => {
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				if (key === "auth") throw new DOMException("denied", "QuotaExceededError");
				return setItem.call(this, key, value);
			};
		});
		let live: { close: () => Promise<void> } | undefined;
		let connections = 0;
		let replays = 0;
		await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
			const server = socket.connectToServer();
			connections += 1;
			socket.onMessage((message) => {
				server.send(message);
				if (typeof message !== "string") return;
				const frame = JSON.parse(message);
				if (Array.isArray(frame.path) && frame.path.join(".") === "auth.login" && frame.input?.token)
					replays += 1;
			});
			live = {
				close: async () => {
					await socket.close();
					await server.close();
				},
			};
		});
		await page.goto("/");
		const setupCode = page.getByLabel("Setup code");
		await expect(setupCode).toBeVisible({ timeout: 60_000 });
		await setupCode.fill(code);
		await page.getByRole("button", { name: "Set up box" }).click();
		await expect(page.locator("header").first()).toBeVisible({ timeout: 30_000 });

		// The warning sits in the page flow, not on the toast layer.
		const notice = page.locator('[data-notification="local-claim-not-remembered"]');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText("did not keep the sign-in");
		await expect(page.locator("[data-sonner-toast]", { hasText: "did not keep the sign-in" })).toHaveCount(0);
		expect(await page.evaluate(() => localStorage.getItem("auth"))).toBeNull();
		if (process.env.E2E_CAPTURE_SETUP_SCREENS === "1") {
			await page.screenshot({ path: testInfo.outputPath("code-session-only.png") });
		}

		// A dropped link reconnects into the same session, twice.
		for (let drop = 1; drop <= 2; drop += 1) {
			const before = connections;
			await live?.close();
			await expect.poll(() => connections, { timeout: 30_000 }).toBeGreaterThan(before);
			await expect.poll(() => replays, { timeout: 30_000 }).toBe(drop);
			await expect(page.locator("header").first()).toBeVisible();
			await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
		}
		await expect(notice).toBeVisible();
	} finally {
		await backend.stop();
	}
});
