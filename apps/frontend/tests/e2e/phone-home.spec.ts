import { expect, test } from './fixtures/index.js';
import { ensureAuthenticated, evidencePath } from './helpers/index.js';

for (const width of [390,1280,1024]) {
 test(`phone-only Home @visual covers every state at ${width}px`, async ({page,pageRpc})=>{
  await page.setViewportSize({width,height:width===1024?600:900});
  await page.addInitScript(()=>{
   const target=window as typeof window & {phoneTestState:string}; target.phoneTestState='unknown';
   const Native=window.WebSocket;
   class PhoneSocket extends Native {
    set onmessage(handler:((this:WebSocket,event:MessageEvent)=>unknown)|null) {
     if(!handler){super.onmessage=null;return;}
     super.onmessage=(event:MessageEvent)=>{
      let next=event;
      try {const data=JSON.parse(event.data);if(data.status){Object.assign(data.status,{phone_box:true,carrying:{state:target.phoneTestState},box_health:[]});next=new MessageEvent('message',{data:JSON.stringify(data)});}}
      catch { /* Preserve non-status frames. */ }
      handler.call(this,next);
     };
    }
    get onmessage(){return super.onmessage;}
   }
   window.WebSocket=PhoneSocket;
  });
  await page.goto('/');await ensureAuthenticated(page);
  await expect(page.getByRole('heading',{name:'Checking whether your phone uses the box'})).toBeVisible();
  await expect(page.getByTestId('phone-hud')).toHaveText('CHECKING');
  const home=page.getByTestId('phone-home');
  expect(await home.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:evidencePath(`phone-home-checking-${width}.png`),fullPage:true});
  await expect(home).not.toContainText(/engine offline|not live|idle/i);
  for (const [state,heading,badge] of [['streaming',"Carrying your phone's stream",'PHONE STREAM'],['idle','Ready for your phone','READY']] as const) {
   await page.evaluate(value=>{(window as typeof window & {phoneTestState:string}).phoneTestState=value;},state);
   await pageRpc.call(['dev','emit'],{type:'status',payload:{phone_box:true,carrying:{state},box_health:[]}});
   await expect(page.getByRole('heading',{name:heading})).toBeVisible();
   await expect(page.getByTestId('phone-hud')).toHaveText(badge);
   await page.screenshot({path:evidencePath(`phone-home-${state}-${width}.png`),fullPage:true});
  }
  await expect(home.getByRole('button',{name:'Connect your phone'})).toBeVisible();
  await home.getByRole('button',{name:'Connect your phone'}).click();
  await home.getByRole('button',{name:'IRL Pro',exact:true}).click();
  await expect(home.getByRole('button',{name:'Change app'})).toBeVisible();
  await expect(home).toContainText('choose SRT, not SRTLA');
  if(width!==1280) await expect(home.locator('img')).toHaveCount(0);
  expect(await home.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:evidencePath(`phone-connect-srt-${width}.png`),fullPage:true});
 });
}
for(const width of [390,1280,1024]) {
 test(`configured phone connection @visual at ${width}px`,async({page})=>{
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.setViewportSize({width,height:width===1024?600:900});await page.goto('/');await ensureAuthenticated(page);
  await page.evaluate(async()=>{
   const url='/src/tests/fixtures/phone-home-browser.ts';
   const fixture=await import(/* @vite-ignore */ url);
   fixture.mountPhoneHomeFixture(window.innerWidth===1024);
  });
  const home=page.getByTestId('phone-home-fixture');
  await home.getByRole('button',{name:'Connect your phone',exact:true}).click();
  await expect(home.getByText('srt://192.0.2.1:4000',{exact:true})).toBeVisible();
  await expect(home.locator('img')).toHaveCount(width===1280?2:0);
  if(width===1280){
   for(const img of await home.locator('img').all()) await expect(img).toHaveAttribute('src',/^data:image\/png/);
  }
  await expect(home.getByRole('button',{name:'Copy',exact:true})).toHaveCount(3);
  await home.getByRole('button',{name:'Copy',exact:true}).nth(1).click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('srt://192.0.2.1:4000');
  if(width===1280){
   const codes=await page.evaluate(async()=>{const url='/src/tests/fixtures/phone-home-browser.ts';return (await import(/* @vite-ignore */ url)).decodePhoneQrCodes();});
   expect(codes).toContain('srt://192.0.2.1:4000');
   expect(codes[0]).toContain('WIFI:T:WPA;S:Example\\;Wifi;');
   expect(codes.join(' ')).not.toContain('example-passphrase');
  }
  expect(await home.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:evidencePath(`phone-configured-srt-${width}.png`),fullPage:true});
 });
}
