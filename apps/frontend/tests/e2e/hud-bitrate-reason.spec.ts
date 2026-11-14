import fs from "node:fs";
import path from "node:path";
import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated } from "./helpers/index.js";

for (const width of [390, 768, 1280]) {
	test(`bitrate stays readable beside a long health reason at ${width}px`, async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop");
		let route: WebSocketRoute | undefined;
		await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
			route = ws;
			const server = ws.connectToServer();
			ws.onMessage((m) => server.send(m));
			server.onMessage((m) => {
				try {
					const frame = JSON.parse(String(m));
					if (frame.health) return;
					if (frame.sensors) {
						frame.sensors = {
							"SoC temperature": 45,
							"SoC voltage": 5,
							"SoC current": 1,
						};
						ws.send(JSON.stringify(frame));
						return;
					}
					if (frame.status) {
						frame.status.is_streaming = true;
						frame.status.engine_bitrate = { applied_kbps: 12500 };
						ws.send(JSON.stringify(frame));
						return;
					}
				} catch {}
				ws.send(m);
			});
		});
		await page.setViewportSize({ width, height: 844 });
		await page.goto("/");
		await ensureAuthenticated(page);
		await page.addStyleTag({
			content: "#svelte-inspector-host {display:none !important}",
		});
		const strip = page.locator("[data-hud-region]").first();
		await expect(strip).toBeVisible({ timeout: 30000 });
		route?.send(
			JSON.stringify({
				health: {
					state: "degraded",
					reason: {
						component: "frames",
						detail:
							"Die Videobilder werden seit längerer Zeit nicht weiter übertragen und die Verbindung wird überprüft",
					},
					process: { alive: true },
					frames: { advancing: false, count: 0 },
					srt: { reconnecting: false, reconnectCount: 0 },
					bond: { linkCount: 2, activeLinks: 1 },
				},
			}),
		);
		await expect(page.getByTestId("stream-health-reason")).toBeVisible();
		const geometry = await page.getByTestId("hud-bitrate").evaluate((el) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			const text = range.getBoundingClientRect(),
				box = el.getBoundingClientRect();
			return {
				clientWidth: el.clientWidth,
				scrollWidth: el.scrollWidth,
				textRight: text.right,
				boxRight: box.right,
				width: box.width,
			};
		});
		const dir = path.resolve("test-results/hud-reason");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${width}.json`),
			JSON.stringify(geometry, null, 2),
		);
		await strip.screenshot({ path: path.join(dir, `${width}.png`) });
		expect(geometry.width).toBeGreaterThan(40);
		expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
		expect(geometry.textRight).toBeLessThanOrEqual(geometry.boxRight + 1);
	});
}
