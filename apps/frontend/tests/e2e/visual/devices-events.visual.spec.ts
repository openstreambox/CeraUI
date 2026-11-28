import { expect, type Page, test } from "../fixtures/index.js";
import { ensureAuthenticated, evidencePath, navigateTo } from "../helpers/index.js";

/**
 * Two events from one poll can share a label, a time and a kind. The list
 * must show both. Controller paths stay off the page.
 */
function installStatusHarness(): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__deviceEvents) return;
	const Real = w.WebSocket;
	w.__deviceEvents = {
		socket: null,
		_seq: 0,
		emit(type: string, payload: unknown) {
			const socket = w.__deviceEvents.socket;
			if (socket) {
				socket.__realSend(
					JSON.stringify({
						id: `device-events-${++w.__deviceEvents._seq}`,
						path: ["dev", "emit"],
						input: { type, payload },
					}),
				);
			}
		},
	};
	class HookedWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			w.__deviceEvents.socket = this;
			this.__realSend = Real.prototype.send.bind(this);
		}
	}
	w.WebSocket = HookedWS;
}

function emit(page: Page, type: string, payload: unknown): Promise<void> {
	return page.evaluate(
		([messageType, messagePayload]) =>
			(
				window as unknown as {
					__deviceEvents: { emit(type: string, payload: unknown): void };
				}
			).__deviceEvents.emit(messageType, messagePayload),
		[type, payload] as const,
	);
}

const SAME_LABEL = {
	at: 1_700_000_000_000,
	reason: "left" as const,
	kind: "wifi" as const,
	socketName: "USB port 1",
};

test.describe("duplicate device events", () => {
	test(
		"@visual shows both rows when the labels match",
		{ tag: "@visual" },
		async ({ page }, testInfo) => {
		test.skip(
			testInfo.project.name !== "desktop" && testInfo.project.name !== "mobile",
			"desktop and phone",
		);
		await page.addInitScript(installStatusHarness);
		await page.goto("/");
		await ensureAuthenticated(page);
		await navigateTo(page, "network");
		await emit(page, "status", {
			usb_events: [
				{ seq: 1, ...SAME_LABEL },
				{ seq: 2, ...SAME_LABEL },
			],
		});
		await page.getByTestId("open-devices").click();
		const rows = page.getByTestId("device-event");
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toContainText("USB port 1");
		await expect(rows.nth(1)).toContainText("USB port 1");
		await expect(page.getByTestId("device-events")).not.toContainText("0000:");
		await page.getByTestId("device-events").evaluate((element) => {
			const chrome = document.querySelector("header");
			const offset = chrome?.getBoundingClientRect().bottom ?? 0;
			const top = element.getBoundingClientRect().top + window.scrollY - offset - 12;
			window.scrollTo(0, Math.max(0, top));
		});
		await page.screenshot({
			path: evidencePath(`devices-events-${testInfo.project.name}.png`),
		});
	});
});
