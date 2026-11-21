import {expect,test} from "bun:test";
import {POWER_COPY,localizePowerText,powerText} from "../src/power-copy.ts";
test("all catalogs cover every power sentence and parameter", async()=> {
 for (const file of new Bun.Glob("*.json").scanSync({cwd:new URL("../messages",import.meta.url).pathname})) {
  const catalog=await Bun.file(new URL(`../messages/${file}`,import.meta.url)).json();
  for (const [key,text] of Object.entries(POWER_COPY)) {
   expect(catalog[`notifications.power.${key}`]).toBeString();
   expect(catalog[`notifications.power.${key}`].match(/\{\w+\}/g) ?? []).toEqual(text.match(/\{\w+\}/g) ?? []);
  }
 }
});
test("composed bank and feed copy localizes each part once with parameters",()=> {
 const seen:unknown[]=[];
 expect(localizePowerText(`${powerText("restingHot",{bank:"A"})} ${powerText("peer",{bank:"B"})}`, (key,params)=>{seen.push([key,params]); return params.bank === "A" ? "A descansa." : "B alimenta.";})).toBe("A descansa. B alimenta.");
 expect(seen).toEqual([["notifications.power.restingHot",{bank:"A"}],["notifications.power.peer",{bank:"B"}]]);
});
