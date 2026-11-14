import type { WebSocketRoute } from '@playwright/test';
import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, evidencePath, navigateTo } from './helpers/index.js';

test('Live quiet-link notice with synthetic telemetry @gallery', async ({ page }) => {
 let socket: WebSocketRoute | undefined;
 await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
  socket = ws;
  const server = ws.connectToServer();
  ws.onMessage(m => server.send(m));
  server.onMessage(m => {
   const frame = JSON.parse(String(m));
   if (frame.status) {
    frame.status.is_streaming = true;
    delete frame.status.linkTelemetry;
   }
   // Keep the synthetic eligible bond stable through backend mock ticks.
   delete frame.netif;
   ws.send(JSON.stringify(frame));
  });
 });
 await page.goto('/');
 await ensureAuthenticated(page);
 await navigateTo(page, 'live');
 for (let t = 0; t <= 22000; t += 5500) {
  socket!.send(JSON.stringify({
   netif: { eth0: { enabled: true, ip: '192.0.2.2', error: '', tp: 0 }, eth1: { enabled: true, ip: '192.0.2.3', error: '', tp: 1000 } },
   status: { is_streaming: true, linkTelemetry: { lastReadMs: t, links: [
    { iface: 'eth0', conn_id: '0', bitrate_bps: 0, rtt_ms: 20, nak_count: 0, weight_percent: 50, stale: false },
    { iface: 'eth1', conn_id: '1', bitrate_bps: 1000000, rtt_ms: 20, nak_count: 0, weight_percent: 50, stale: false },
   ] } },
  }));
  // A browser round trip lets each distinct mocked observation reach Svelte.
  await page.evaluate(() => new Promise(requestAnimationFrame));
 }
 const notice = page.getByTestId('live-connected-idle-notice');
 await expect(notice).toBeVisible();
 await notice.locator('summary').click();
 await expect(notice).toContainText('still live on other links');
 await page.screenshot({ path: evidencePath(`connected-idle-live-${test.info().project.name}.png`), fullPage: true });
});
