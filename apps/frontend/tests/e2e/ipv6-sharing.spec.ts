import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, navigateTo, evidencePath } from './helpers/index.js';
import { healthyThreeUplinks, installSharingWire } from './helpers/sharing-wire.js';

test("IPv6-only hotspot explanation at mobile and desktop sizes", async ({page, backendRpc}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({width:390,height:900});
  const wire = await installSharingWire(page, healthyThreeUplinks());
  await page.goto('/');
  await ensureAuthenticated(page);
  await navigateTo(page, 'network');
  const wifi = await backendRpc.call<Record<string, Record<string, unknown>>>(['wifi','getStatus']);
  const id = Object.keys(wifi)[0];
  if (!id) throw new Error('No mock Wi-Fi adapter');
  const emit = async (ipv6: boolean) => {
   await wire.emit('status', {wifi:{[id]:{...wifi[id],mode:'hotspot',hotspot:{name:'Demo Wi-Fi',available_channels:{},clients:{count:0,stations:[]}}}}});
   await wire.emit('netif', {wwan0:{enabled:true,tp:0,addresses:ipv6?['fd51::1']:[],...(ipv6?{ipv6:'fd51::1'}:{})},eth0:{ip:'192.0.2.1',enabled:true,tp:0}});
  };
  for (const width of [390, 1280]) {
  await page.setViewportSize({width,height:900});
  await emit(false);
  await wire.publish();
  const section=page.getByTestId('sharing-section');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('sharing-ipv6-only')).toHaveCount(0);
  await section.screenshot({path:evidencePath(`ipv6-sharing-before-${width}.png`)});
  await emit(true);
  const note = page.getByTestId('sharing-ipv6-only');
  await expect(note).toContainText("Devices on the box's Wi-Fi can't reach IPv4 sites through this link yet.");
  await expect(note).toContainText('wwan0');
  await expect(note).not.toContainText(/stream|down|broken/i);
  await section.screenshot({path:evidencePath(`ipv6-sharing-after-${width}.png`)});
  await emit(false);
  await expect(note).toHaveCount(0);
  }
 });
