import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

test('receiver-path copy covers every locale and never equates a link path with broadcast health', () => {
 const dir = join(import.meta.dir, '../messages');
 const en = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'));
 const keys = Object.keys(en).filter(key => key.startsWith('network.path.'));
 expect(keys).toHaveLength(19);
 for (const file of readdirSync(dir).filter(file => file.endsWith('.json'))) {
  const catalog = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  for (const key of keys) {
   expect(typeof catalog[key]).toBe('string');
   expect(catalog[key].trim().length).toBeGreaterThan(0);
   if (file !== 'en.json' && catalog[key] === en[key] && key !== 'network.path.ipv4') {
    expect(catalog[key]).toStartWith('[EN] ');
   }
  }
 }
 for (const key of keys) expect(en[key]).not.toMatch(/not live|not streaming|offline/i);
});
