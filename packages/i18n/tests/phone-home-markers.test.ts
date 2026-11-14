import { expect, test } from 'bun:test';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import hi from '../messages/hi.json';
for (const [locale, catalog] of Object.entries({ar, es, hi})) {
 test(`${locale} marks untranslated phone health and checking copy`, () => {
  for (const key of ['live.phone.healthReady','live.phone.healthActive','live.phone.healthMoblin','live.phone.healthRestartParts','live.phone.carryingChecking'] as const) {
   expect(catalog[key]).not.toBe(en[key]);
  }
 });
}
