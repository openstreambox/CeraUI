import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo } from './helpers/index.js';
import { installSharingWire } from './helpers/sharing-wire.js';
import type { LinkPaths } from '@ceraui/rpc/schemas';

export const paths: LinkPaths = { wlan0: 'ipv6', wlan1: 'ipv4', usb0: 'clat', usb1: 'receiver-ipv4-only', eth0: 'ipv4' };

test.use({ backendScenario: 'streaming-active' });
test.setTimeout(120_000);

test('receiver paths stay per-link and explain on request', async ({ page }) => {
 // The isolated browser has loopback only; model an online controller explicitly.
 await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true }));
 const wire = await installSharingWire(page);
 await wire.emit('netif', {
  wlan0: { tp: 0, enabled: true, ipv6: '2001:db8:1::3', addresses: ['2001:db8:1::3'] },
  usb0: { tp: 0, enabled: true, ipv6: '2001:db8:2::3', addresses: ['2001:db8:2::3'] },
  usb1: { tp: 0, enabled: true, ipv6: '2001:db8:3::3', addresses: ['2001:db8:3::3'] },
  eth0: { tp: 0, enabled: true, ip: '192.0.2.3', addresses: ['192.0.2.3'] },
 });
 await wire.emit('status', { link_paths: paths });
 await page.goto('/');
 await ensureAuthenticated(page);
 await navigateTo(page, 'network');
 const links = page.getByTestId('bonded-link-card');
 await expect(links).toHaveCount(4);
 const translated = page.locator('[data-link-id="usb0"]');
 await expect(translated.getByTestId('link-path-status')).toContainText('IPv4 through translation (CLAT)');
 await expect(page.locator('[data-link-id="usb1"] summary')).toContainText('Unused: receiver has no IPv6; translation unavailable');
 await expect(page.locator('[data-link-id="wlan0"] summary')).toContainText('Native IPv6');
 await expect(links.locator('[role="alert"]')).toHaveCount(0);
 await translated.getByText('Why this path?').click();
 await expect(translated.getByTestId('link-path-status').locator('p')).toBeVisible();
 await wire.emit('status', { link_paths: { ...paths, usb0: 'receiver-ipv4-only' } });
 await expect(translated.locator('summary')).toContainText('Unused:');
 await wire.emit('status', { link_paths: {} });
 await expect(translated.locator('summary')).toContainText('Receiver path not reported');
});
