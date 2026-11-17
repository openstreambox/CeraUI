import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(
	new URL('../../apps/frontend/tests/e2e/fixtures/phone-home.ts', import.meta.url),
	'utf8',
);

test('phone harness loads only on explicit request in the current document', () => {
	expect(source).not.toContain('auto: true');
	expect(source).not.toContain('addInitScript');
	expect(source).not.toContain('page.route');
	expect(source).toContain('page.addScriptTag');
	expect(source).toContain('page.addStyleTag');
});

test('phone harness uses shipped runtime aliases and checks generated strategy', () => {
	expect(source).toContain('PERSIST_RUNTIME_ALIAS');
	expect(source).toContain('VARIANTS_ALIAS');
	expect(source).toContain('PARAGLIDE_STRATEGY');
	expect(source).toContain('assertPhoneHomeStrategy');
});

const { assertPhoneHomeStrategy } = await import(
	'../../apps/frontend/tests/e2e/fixtures/phone-home-strategy.ts'
);
test('generated runtime rejects cookie strategy, missing strategy and stale alternatives', () => {
	const expected = ['globalVariable', 'baseLocale'];
	expect(() =>
		assertPhoneHomeStrategy('export const strategy = ["globalVariable", "baseLocale"];', expected),
	).not.toThrow();
	for (const source of [
		'',
		'export const strategy = ["cookie","globalVariable","baseLocale"];',
		'export const strategy = ["baseLocale"];',
	]) {
		expect(() => assertPhoneHomeStrategy(source, expected)).toThrow();
	}
});
