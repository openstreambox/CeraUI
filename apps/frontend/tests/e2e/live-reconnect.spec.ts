import ar from "../../../../packages/i18n/messages/ar.json" with { type: "json" };
import de from "../../../../packages/i18n/messages/de.json" with { type: "json" };
import en from "../../../../packages/i18n/messages/en.json" with { type: "json" };
import es from "../../../../packages/i18n/messages/es.json" with { type: "json" };
import fr from "../../../../packages/i18n/messages/fr.json" with { type: "json" };
import hi from "../../../../packages/i18n/messages/hi.json" with { type: "json" };
import ja from "../../../../packages/i18n/messages/ja.json" with { type: "json" };
import ko from "../../../../packages/i18n/messages/ko.json" with { type: "json" };
import ptBR from "../../../../packages/i18n/messages/pt-BR.json" with { type: "json" };
import zh from "../../../../packages/i18n/messages/zh.json" with { type: "json" };

import type { StatusResponse } from "@ceraui/rpc/schemas";
import type { Page, WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo, setLocale } from "./helpers/index.js";

/**
 * Live after every link was lost. While the device reconnects, the cockpit holds
 * the session with "Reconnecting the stream · m:ss left", Keep trying and Stop;
 * after the window ran out it says what was missing, still with Keep trying and
 * Stop. Both fit a phone in every locale (the header chip on one line, no
 * sideways scroll), and Keep trying reaches the device, which refuses a window
 * it does not have. Injected frames replace the backend's stream facts.
 */

const COPY = { ar, de, en, es, fr, hi, ja, ko, "pt-BR": ptBR, zh };
const VIEWPORTS = [
	{ width: 320, height: 800 },
	{ width: 390, height: 800 },
	{ width: 1280, height: 800 },
];
const LIVE: StatusResponse = { is_streaming: true, stream_lifecycle: "streaming", connection_restarting: false, stream_reconnect: null };
const RECONNECTING: StatusResponse = {
	is_streaming: false,
	stream_lifecycle: "idle",
	connection_restarting: true,
	stream_reconnect: { state: "reconnecting", remaining_ms: 84_000, token: "window-e2e" },
};
const EXPIRED: StatusResponse = {
	is_streaming: false,
	stream_lifecycle: "idle",
	connection_restarting: false,
	stream_reconnect: { state: "expired", reason: "no_link", token: "window-e2e" },
};
const INJECTED = ["is_streaming", "stream_lifecycle", "connection_restarting", "stream_reconnect"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function openLive(page: Page, locale: string): Promise<void> {
	await page.goto("/");
	await ensureAuthenticated(page);
	await setLocale(page, locale);
	await page.goto("/");
	await ensureAuthenticated(page);
	await expect(page.locator("html")).toHaveAttribute("lang", locale);
	await navigateTo(page, "live");
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function resize(page: Page, viewport: { width: number; height: number }): Promise<void> {
	await page.setViewportSize(viewport);
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

function pageOverflow(page: Page): Promise<number> {
	return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe("Live after every link was lost", { tag: "@desktop-only" }, () => {
	let send: (status: StatusResponse) => void;

	test.beforeEach(async ({ page }) => {
		let socket: WebSocketRoute | undefined;
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			socket = ws;
			ws.connectToServer().onMessage((raw) => {
				if (typeof raw !== "string") return ws.send(raw);
				const value: unknown = JSON.parse(raw);
				if (!isRecord(value) || !isRecord(value.status)) return ws.send(raw);
				for (const field of INJECTED) delete value.status[field];
				ws.send(JSON.stringify(value));
			});
		});
		let seq = 9_000_000;
		send = (status) => {
			if (!socket) throw new Error("Missing Live control socket");
			socket.send(JSON.stringify({ status, seq: ++seq }));
		};
	});

	for (const [locale, copy] of Object.entries(COPY)) {
		test(`${locale}: reconnecting and its end hold the session with Keep trying and Stop, and fit a phone`, async ({ page }) => {
			await openLive(page, locale);
			send(LIVE);
			await expect(page.getByTestId("live-cockpit")).toBeVisible();
			const header = page.locator("header", { has: page.getByRole("heading", { level: 1, name: copy["live.title"], exact: true }) });

			for (const [name, status, chipText, title] of [
				["reconnecting", RECONNECTING, copy["live.reconnectingChip"], copy["live.reconnectingTitle"]],
				["expired", EXPIRED, copy["live.reconnectExpiredChip"], copy["live.reconnectExpiredNoLink"]],
			] as const) {
				send(status);
				const banner = page.getByTestId("live-reconnect-banner");
				await expect(banner).toHaveAttribute("data-state", name);
				await expect(banner).toContainText(title);
				await expect(header.getByTestId("live-header-restarting")).toHaveText(chipText);
				await expect(header.getByText(copy["live.notStreaming"], { exact: true })).toHaveCount(0);
				await expect(page.getByTestId("live-reconnect-keep-trying")).toHaveText(copy["notifications.keepTrying"]);
				await expect(page.getByRole("button", { name: copy["live.stopStream"] })).toBeVisible();
				if (name === "reconnecting") await expect(page.getByTestId("live-reconnect-left")).toContainText("1:2");
				for (const viewport of VIEWPORTS) {
					await resize(page, viewport);
					const where = `${locale} ${name} at ${viewport.width}px`;
					expect.soft(await pageOverflow(page), where).toBeLessThanOrEqual(0);
					const chipLines = await header.getByTestId("live-header-restarting").evaluate((chip) => {
						const rects = [...chip.getClientRects()];
						return rects.length === 1 && chip.scrollWidth <= chip.clientWidth + 1;
					});
					expect.soft(chipLines, where).toBe(true);
				}
				await resize(page, { width: 1280, height: 800 });
			}
		});
	}

	test("Keep trying reaches the device, which refuses a window it does not have", async ({ page }) => {
		await openLive(page, "en");
		send(LIVE);
		send(EXPIRED);
		await page.getByTestId("live-reconnect-keep-trying").click();
		await expect(page.getByText(en["notifications.keepTryingRefused"], { exact: true })).toBeVisible();
	});
});
