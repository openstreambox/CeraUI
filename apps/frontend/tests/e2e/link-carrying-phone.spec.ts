import type { WebSocketRoute } from "@playwright/test";

import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated, navigateTo, setLocale } from "./helpers/index.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

/**
 * A link that is in the bond but carries nothing says so on Live, on a phone.
 *
 * srtla_send never runs under the mock, so the proxy below forces
 * `is_streaming` and drops the backend's own `linkTelemetry`; the injected
 * frames are the only telemetry. One link reports `carrying: false` (the
 * backend's verdict after its dwell), the other `carrying: true`. jsdom cannot
 * measure layout, so this checks the rendered line: visible on that row only,
 * inside the row, and never pushing the page sideways. German carries the
 * longest copy.
 */

const LINKS = [
	{
		conn_id: "0",
		iface: "usb0",
		rtt_ms: 38,
		nak_count: 0,
		weight_percent: 0,
		bitrate_bps: 0,
		carrying: false,
		stale: false,
	},
	{
		conn_id: "1",
		iface: "wlan0",
		rtt_ms: 24,
		nak_count: 3,
		weight_percent: 100,
		bitrate_bps: 4_100_000,
		carrying: true,
		stale: false,
	},
];

const CASES = [
	{ locale: "en", width: 390, text: "No stream data on this link" },
	{ locale: "en", width: 360, text: "No stream data on this link" },
	{ locale: "de", width: 390, text: "Keine Streamdaten über diese Verbindung" },
] as const;

for (const { locale, width, text } of CASES) {
	test(`Live names a link that carries nothing (${locale}, ${width} px)`, {
		tag: "@mobile-only",
	}, async ({ page }) => {
		let pageWs: WebSocketRoute | null = null;
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			pageWs = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				const raw = typeof m === "string" ? m : m.toString();
				try {
					const frame = JSON.parse(raw) as { status?: Record<string, unknown> };
					if (frame?.status) {
						frame.status.is_streaming = true;
						delete frame.status.linkTelemetry;
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {
					/* non-JSON frame */
				}
				ws.send(m);
			});
		});

		await page.setViewportSize({ width, height: 844 });
		await page.goto("/");
		await ensureAuthenticated(page);
		if (locale !== "en") {
			await setLocale(page, locale);
			await page.reload();
			await ensureAuthenticated(page);
		}
		await navigateTo(page, "live");
		const push = () =>
			(pageWs as WebSocketRoute | null)?.send(
				JSON.stringify({ status: { is_streaming: true, linkTelemetry: { links: LINKS } } }),
			);
		push();

		const panel = page.getByTestId("ingest-stats");
		await expect(panel).toBeVisible({ timeout: 15_000 });
		const idleRow = panel.locator('[data-testid="ingest-row"][data-iface="usb0"]');
		const busyRow = panel.locator('[data-testid="ingest-row"][data-iface="wlan0"]');
		const line = idleRow.getByTestId("link-carrying-nothing");
		await expect(line).toHaveText(text);
		await expect(busyRow.getByTestId("link-carrying-nothing")).toHaveCount(0);
		// The trend pill would say "Stable" for a link with nothing on it.
		await expect(idleRow.getByTestId("ingest-health")).toHaveCount(0);
		await expect(busyRow.getByTestId("ingest-health")).toHaveCount(1);

		const geometry = await line.evaluate((el) => {
			const row = el.closest("li") as HTMLElement;
			const box = el.getBoundingClientRect();
			const rowBox = row.getBoundingClientRect();
			return {
				lineRight: box.right,
				rowRight: rowBox.right,
				lineHeight: box.height,
				fontLine: Number.parseFloat(getComputedStyle(el).lineHeight),
				viewport: document.documentElement.clientWidth,
				pageScrollWidth: document.documentElement.scrollWidth,
			};
		});
		const detail = JSON.stringify(geometry);
		expect(geometry.lineRight <= geometry.rowRight + 1, detail).toBe(true);
		expect(geometry.lineHeight < geometry.fontLine * 1.5, detail).toBe(true);
		expect(geometry.pageScrollWidth <= geometry.viewport + 1, detail).toBe(true);

		// The backend withdraws its verdict (stale or no claim): the line goes.
		(pageWs as WebSocketRoute | null)?.send(
			JSON.stringify({
				status: {
					is_streaming: true,
					linkTelemetry: { links: LINKS.map(({ carrying: _c, ...link }) => link) },
				},
			}),
		);
		await expect(line).toHaveCount(0);
	});
}
