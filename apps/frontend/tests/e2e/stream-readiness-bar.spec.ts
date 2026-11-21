import type { WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

/**
 * The idle Live bar carries the device's own "not ready" line.
 *
 * The proxy drops the backend's own `stream_readiness` frames, so the bar
 * first renders exactly as it does without the device's answer.
 * Then one frame says an update is installing: the bar turns to the warning
 * tone with that line, Start stays enabled, and nothing overflows the page.
 * A ready frame afterwards brings the ready text back.
 */

const NOT_READY = {
	ready: false,
	live: false,
	reason: { check: "lock", code: "update_in_progress" },
	checks: [
		{ id: "lock", state: "blocked", code: "update_in_progress" },
		{ id: "source", state: "ok" },
		{ id: "receiver", state: "ok" },
		{ id: "uplinks", state: "ok" },
	],
	uplinks: { usable: 2, total: 2 },
	at: 1,
};

const READY = {
	...NOT_READY,
	ready: true,
	reason: undefined,
	checks: NOT_READY.checks.map(({ id }) => ({ id, state: "ok" })),
	at: 2,
};

test("the idle Live bar shows the device's not-ready line", async ({
	page,
}) => {
	let pageWs: WebSocketRoute | null = null;
	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		pageWs = ws;
		const server = ws.connectToServer();
		ws.onMessage((m) => server.send(m));
		server.onMessage((m) => {
			const raw = typeof m === "string" ? m : m.toString();
			try {
				const frame = JSON.parse(raw) as Record<string, unknown>;
				if (frame && "stream_readiness" in frame) return;
			} catch {
				/* non-JSON frame */
			}
			ws.send(m);
		});
	});

	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "live");

	const bar = page.getByTestId("live-bar");
	await expect(bar).toBeVisible({ timeout: 15_000 });
	// The mock starts with no source chosen, which the client itself blocks on.
	await page.getByText("HDMI Input", { exact: true }).first().click();
	await expect(bar).toHaveAttribute("data-state", "ready");
	const before = await bar.getAttribute("data-state");

	const push = (value: unknown) =>
		(pageWs as WebSocketRoute | null)?.send(
			JSON.stringify({ stream_readiness: value }),
		);
	push(NOT_READY);

	if (before === "ready") {
		await expect(bar).toHaveAttribute("data-state", "warn");
		await expect(bar).toContainText("An update is installing.");
		await expect(
			bar.getByRole("button", { name: /start stream/i }),
		).toBeEnabled();
	} else {
		// The client's own blocking reason wins; the device line never replaces it.
		await expect(bar).toHaveAttribute("data-state", "blocked");
		await expect(bar).not.toContainText("An update is installing.");
	}

	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow <= 1, String(overflow)).toBe(true);

	push(READY);
	await expect(bar).toHaveAttribute("data-state", before ?? "ready");
});
