import { expect, test } from '../fixtures/index.js';
import { ensureAuthenticated, navigateTo, evidencePath } from '../helpers/index.js';
import { installSharingWire } from '../helpers/sharing-wire.js';
import type { LinkPaths } from '@ceraui/rpc/schemas';

test.use({ backendScenario: 'streaming-active' });
test.setTimeout(120_000);

test('@visual receiver path evidence', async ({ page }, testInfo) => {
	// The isolated browser has loopback only; model an online controller explicitly.
	await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true }));
	const viewport = page.viewportSize();
	if (viewport) await page.setViewportSize({ ...viewport, height: 1400 });
	const wire = await installSharingWire(page);
	await wire.emit('netif', {
		wlan0: { tp: 0, enabled: true, ipv6: '2001:db8:1::3', addresses: ['2001:db8:1::3'] },
		usb0: { tp: 0, enabled: true, ipv6: '2001:db8:2::3', addresses: ['2001:db8:2::3'] },
		usb1: { tp: 0, enabled: true, ipv6: '2001:db8:3::3', addresses: ['2001:db8:3::3'] },
		eth0: { tp: 0, enabled: true, ip: '192.0.2.3', addresses: ['192.0.2.3'] },
	});
	const link_paths: LinkPaths = { wlan0: 'ipv6', wlan1: 'ipv4', usb0: 'clat', usb1: 'receiver-ipv4-only', eth0: 'ipv4' };
	await wire.emit('status', { link_paths });
	await page.goto('/');
	await ensureAuthenticated(page);
	await navigateTo(page, 'network');
	const section = page.getByRole('region', { name: 'Bonded Links' });
	await expect(page.getByTestId('bonded-link-card')).toHaveCount(4);
	await expect(page.locator('[data-link-id="usb0"]')).toContainText('IPv4 through translation');
	await page.addStyleTag({ content: '[data-testid="link-telemetry"] dd{visibility:hidden} [data-live-value]{visibility:hidden}' });
	await section.screenshot({ path: evidencePath(`paths-after-${testInfo.project.name}.png`) });
	await page.locator('[data-link-id="usb0"] summary').click();
	await section.screenshot({ path: evidencePath(`paths-why-${testInfo.project.name}.png`) });
});
