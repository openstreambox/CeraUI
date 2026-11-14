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
			expect(catalog[key]).not.toMatch(/not live|not streaming|offline|nicht live|nicht auf Sendung|hors ligne|pas en direct|sin conexión|no está en directo|fora do ar|não está ao vivo|غير مباشر|लाइव नहीं|ライブではない|방송 중이 아|未直播|不在直播/i);
			if (file !== 'en.json' && catalog[key] === en[key] && key !== 'network.path.ipv4') {
				expect(catalog[key]).toStartWith('[EN] ');
			}
		}
	}

});

test('cached receiver copy describes the address in use', () => {
	const en = JSON.parse(readFileSync(join(import.meta.dir, '../messages/en.json'), 'utf8'));
	expect(en['network.path.receiver-ipv4-only']).toBe('Unused: receiver address in use is IPv4; translation unavailable');
	expect(en['network.path.receiver-ipv4-onlyWhy']).toContain('receiver address in use');
	expect(en['network.path.ipv4Why']).not.toMatch(/family|retained/);
	expect(en['network.path.unknownWhy']).not.toMatch(/backend|source list/);
	expect(en['network.path.staleWhy']).toContain('device');
});

test('Hindi CLAT copy uses address conversion terminology', () => {
	const hi = JSON.parse(readFileSync(join(import.meta.dir, '../messages/hi.json'), 'utf8'));
	expect(hi['network.path.clatWhy']).toContain('पता परिवर्तक');
	expect(hi['network.path.clatWhy']).not.toContain('रूपांतरणक');
});
