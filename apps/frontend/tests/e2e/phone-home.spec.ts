import { expect, test } from './fixtures/phone-home.js';
import { ensureAuthenticated, evidencePath } from './helpers/index.js';

for (const width of [390,1280,1024]) {
 test(`phone-only Home @visual covers every state at ${width}px`, async ({page,pageRpc})=>{
  await page.setViewportSize({width,height:width===1024?600:900});
  await page.goto('/');await ensureAuthenticated(page);
  await pageRpc.call(['dev','emit'],{type:'status',payload:{phone_box:true,carrying:{state:'unknown'},box_health:[]}});
  await expect(page.getByRole('heading',{name:'Checking whether a device is sending through the box'})).toBeVisible();
  await expect(page.getByTestId('phone-hud')).toHaveText('CHECKING');
  const home=page.getByTestId('phone-home');
  expect(await home.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:evidencePath(`phone-home-checking-${width}.png`),fullPage:true});
  await expect(home).not.toContainText(/engine offline|not live|idle/i);
  for (const [state,heading,badge] of [['streaming',"Carrying your stream",'CARRYING'],['idle','Ready to carry your stream','READY']] as const) {
   await pageRpc.call(['dev','emit'],{type:'status',payload:{phone_box:true,carrying:{state},box_health:[]}});
   await expect(page.getByRole('heading',{name:heading})).toBeVisible();
   await expect(page.getByTestId('phone-hud')).toHaveText(badge);
   if(state==='streaming') await expect(home).not.toContainText('Checking internet');
   await page.screenshot({path:evidencePath(`phone-home-${state}-${width}.png`),fullPage:true});
   const health=home.locator('section').filter({has:page.getByRole('heading',{name:'Box health',exact:true})});
   await health.evaluate(el=>el.scrollIntoView({block:'center'}));
   await health.screenshot({path:evidencePath(`phone-health-${state}-${width}.png`)});
   await home.getByRole('heading',{name:heading}).evaluate(el=>el.scrollIntoView({block:'start'}));
  }
  await expect(home.getByRole('button',{name:'Connect a device'})).toBeVisible();
  await home.getByRole('button',{name:'Connect a device'}).click();
  await home.getByRole('button',{name:'IRL Pro',exact:true}).click();
  await expect(home.getByRole('button',{name:'Change app'})).toBeVisible();
  await expect(home).toContainText('choose SRT, not SRTLA');
  if(width!==1280) await expect(home.locator('img')).toHaveCount(0);
  expect(await home.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:evidencePath(`phone-connect-srt-${width}.png`),fullPage:true});
  await expect(home).toContainText("Nothing after 30 seconds? Check that your device is on the box's Wi-Fi and that the address and passphrase match.");
  await home.getByRole('button',{name:'Change app',exact:true}).click();
  await home.getByRole('button',{name:'Moblin',exact:true}).click();
  await expect(home.getByLabel("Moblin's password (from Moblin, not the Wi-Fi password)")).toBeVisible();
  await expect(home).not.toContainText('inputs =');
  await page.screenshot({path:evidencePath(`phone-connect-moblin-${width}.png`),fullPage:true});
  const label=home.locator('label');
  await label.evaluate(el=>el.scrollIntoView({block:'center'}));
  await label.screenshot({path:evidencePath(`phone-moblin-label-${width}.png`)});
 });
}
for(const width of [390,1280,1024]) {
 test(`configured phone connection @visual at ${width}px`,async({page,loadPhoneHome})=>{
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.setViewportSize({width,height:width===1024?600:900});await page.goto('/');await ensureAuthenticated(page);
  await loadPhoneHome();
  await page.evaluate(async()=>{
   const fixture=window.PhoneHomeFixture; await fixture.preparePhoneHomeFixture();
   fixture.mountPhoneHomeFixture(window.innerWidth===1024);
  });
  const home=page.getByTestId('phone-home-fixture');
  await home.getByRole('button',{name:'Connect a device',exact:true}).click();
  await expect(home.getByText('srt://192.0.2.1:4000',{exact:true})).toBeVisible();
  // The Wi-Fi code is hidden until Show code (D16); only the address QR is up.
  await expect(home.locator('img')).toHaveCount(width===1280?1:0);
  if(width===1280){
   const show=home.getByRole('button',{name:'Show code',exact:true});
   await expect(show).toHaveAttribute('aria-expanded','false');
   await show.click();
   await expect(home.locator('img')).toHaveCount(2);
   for(const img of await home.locator('img').all()) await expect(img).toHaveAttribute('src',/^data:image\/png/);
  }
  await expect(home.getByRole('button',{name:'Copy',exact:true})).toHaveCount(3);
  await home.getByRole('button',{name:'Copy',exact:true}).nth(1).click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('srt://192.0.2.1:4000');
  if(width===1280){
   const codes=await page.evaluate(async()=>{return (window.PhoneHomeFixture).decodePhoneQrCodes();});
   expect(codes).toContain('srt://192.0.2.1:4000');
   expect(codes[0]).toContain('WIFI:T:WPA;S:Example\\;Wifi;');
   expect(codes.join(' ')).not.toContain('example-passphrase');
  }
  expect(await home.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:evidencePath(`phone-configured-srt-${width}.png`),fullPage:true});
 });
}

for (const width of [390, 1280, 1024]) {
 test(`Moblin credential label and cleared field @visual at ${width}px`, async ({ page, loadPhoneHome }) => {
  await page.setViewportSize({ width, height: width === 1024 ? 600 : 900 });
  await page.goto('/'); await ensureAuthenticated(page);
  await loadPhoneHome();
  await page.evaluate(async () => {
   await window.PhoneHomeFixture.preparePhoneHomeFixture();
   window.PhoneHomeFixture.mountPhoneHomeFixture(window.innerWidth === 1024, true);
  });
  const home = page.getByTestId('phone-home-fixture');
  await home.getByRole('button', { name: 'Connect a device', exact: true }).click();
  const input = home.getByLabel("Moblin's password (from Moblin, not the Wi-Fi password)");
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute('autocomplete', 'off');
  await expect(input).toHaveAttribute('data-1p-ignore', '');
  await expect(input).toHaveAttribute('data-lpignore', 'true');
  await expect(input).toHaveAttribute('data-bwignore', '');
  await expect(input).toHaveAttribute('data-form-type', 'other');
  await expect(home).not.toContainText(/inputs =|experimentalStaticLocale/);
  await input.fill('synthetic-phone-password');
  await home.getByRole('button', { name: 'Save Moblin password' }).click();
  await expect(input).toHaveValue('');
  await expect(home).toContainText('saving does not confirm a connection');
  expect(await home.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: evidencePath(`phone-connect-moblin-${width}.png`), fullPage: true });
 });
}

test('phone harness @visual stays absent from real app documents and frames', async ({ authedPage: page }) => {
 await expect(page.getByTestId('phone-home-fixture')).toHaveCount(0);
 expect(await page.evaluate(() => typeof window.PhoneHomeFixture)).toBe('undefined');
 await page.evaluate(() => {
  const frame = document.createElement('iframe');
  frame.name = 'fixture-isolation';
  frame.srcdoc = '<p>Independent frame</p>';
  document.body.append(frame);
 });
 const frame = page.frameLocator('iframe[name="fixture-isolation"]');
 await expect(frame.getByText('Independent frame')).toBeVisible();
 expect(await frame.locator('body').evaluate(() => typeof window.PhoneHomeFixture)).toBe('undefined');
 await page.reload();
 await ensureAuthenticated(page);
 expect(await page.evaluate(() => typeof window.PhoneHomeFixture)).toBe('undefined');
});

test('phone harness @visual loads after boot with inline styles and no locale cookie', async ({ authedPage: page, loadPhoneHome }) => {
 expect(await page.evaluate(() => typeof window.PhoneHomeFixture)).toBe('undefined');
 await loadPhoneHome();
 await page.evaluate(async () => {
  await window.PhoneHomeFixture.preparePhoneHomeFixture();
  window.PhoneHomeFixture.mountPhoneHomeFixture();
 });
 await expect(page.getByTestId('phone-home-fixture')).toBeVisible();
 expect((await page.context().cookies()).some(cookie => cookie.name === 'PARAGLIDE_LOCALE')).toBe(false);
 expect(await page.getByTestId('phone-home-fixture').locator('section').first().evaluate(el => getComputedStyle(el).paddingTop)).toBe('20px');
 await page.reload();
 await ensureAuthenticated(page);
 expect(await page.evaluate(() => typeof window.PhoneHomeFixture)).toBe('undefined');
});
