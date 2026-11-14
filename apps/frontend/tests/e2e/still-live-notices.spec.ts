import { expect } from "@playwright/test";
import { test } from "./fixtures/index.js";
import { settleBackendHealthBroadcast } from "./helpers/backend-health.js";
import { ensureAuthenticated, navigateTo } from "./helpers/index.js";

test.use({ backendScenario: "streaming-active" });

// Synthetic notifications exercise the authenticated subscription and persistent
// notice surfaces. Detector timing and owner attribution have separate unit tests.
test("still-live notices remain visible without preview and clear on recovery", async ({ page, pageRpc }, testInfo) => {
	test.skip(testInfo.project.name !== "desktop", "one mock-data desktop integration proof");
	await page.goto("/");
	await ensureAuthenticated(page);
	await navigateTo(page, "live");
	await expect.poll(async () => {
		await pageRpc.call(["dev", "emit"], { type: "status", payload: {
			is_streaming: true, stream_lifecycle: "streaming",
			active_encode: { codec: "h264", resolution: "1920x1080", framerate: 30, active_input: "hdmi" },
		} });
		return page.getByTestId("live-cockpit").isVisible();
	}).toBe(true);
	await settleBackendHealthBroadcast(pageRpc);
	await page.clock.install();
	const notices = [
		["camera", "notifications.stillLiveNetwork", "Network camera feed stopped. You're still live. Check the camera's network connection."],
		["silence", "notifications.stillLiveSilence", "No sound in your stream for 10 s. You're still live. Check the mic."],
	];
	for (const [kind, key, msg] of notices) {
		await pageRpc.call(["dev", "emit"], { type: "notification", payload: { show: [{ name: `still-live-${kind}`, key, msg, type: "warning", duration: 0, revision: 1, is_persistent: true, is_dismissable: true }] } });
		const notice = page.locator(`[data-testid="persistent-notice"][data-notification="still-live-${kind}"]`);
		await expect(notice).toBeVisible();
		await expect(notice.locator("p")).toHaveText(msg);
		if (kind === "camera") {
			// The old cockpit timer duplicated this exact camera sentence after 5 s.
			await pageRpc.call(["dev", "emit"], { type: "health", payload: {
				state: "degraded", reason: { component: "frames", detail: "No frames advancing" },
				process: { alive: true }, frames: { advancing: false, count: 1500 },
				srt: { reconnecting: null, reconnectCount: 0 }, bond: { linkCount: 1, activeLinks: 1 },
			} });
			await page.clock.runFor(5500);
			await expect(page.getByTestId("video-signal-lost-banner")).toHaveCount(0);
			await expect(page.getByText(msg, { exact: true })).toHaveCount(1);
		}
	}
	for (const [kind] of notices) {
		await pageRpc.call(["dev", "emit"], { type: "notification", payload: { remove: [{ id: `still-live-${kind}`, revision: 2 }] } });
		await expect(page.locator(`[data-testid="persistent-notice"][data-notification="still-live-${kind}"]`)).toHaveCount(0);
	}
});
