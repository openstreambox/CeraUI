import { expect, test } from 'bun:test';
import { sensorsStatusSchema } from './system.schema';

test('power sensor status survives the shared projection alongside existing sensors', () => {
	const sample = {
		'SoC temperature': '45 °C',
		Power: 'Power data not available',
		'Power sample': '1000',
		'Bank A': 'Temperature unavailable',
		'Bank B': '30 °C',
		'Reserve pack': '40 °C (estimate)',
	};
	expect(sensorsStatusSchema.parse(sample)).toEqual(sample);
	expect(sensorsStatusSchema.safeParse({ ...sample, Power: 123 }).success).toBe(false);
});
test('older sensor producers do not acquire synthesized power values', () => {
	expect(sensorsStatusSchema.parse({ 'SoC temperature': '45 °C' })).toEqual({
		'SoC temperature': '45 °C',
	});
});
