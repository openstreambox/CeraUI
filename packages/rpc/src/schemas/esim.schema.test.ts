import { describe, expect, test } from 'bun:test';

import {
	esimOperationInputSchema,
	esimOperationOutputSchema,
	parseEsimActivationCode,
} from './esim.schema';

const code = 'LPA:1$rsp.example.com$TEST-CODE';
const token = 'a'.repeat(64);

describe('consumer eSIM activation input', () => {
	test('plain and confirmation-required codes', () => {
		expect(parseEsimActivationCode(` ${code} `)).toEqual({
			smdpAddress: 'rsp.example.com',
			matchingId: 'TEST-CODE',
			confirmationRequired: false,
		});
		expect(parseEsimActivationCode(`${code}$$1`)?.confirmationRequired).toBe(true);
		expect(parseEsimActivationCode(`${code}$1.2.3$0`)?.confirmationRequired).toBe(false);
	});
	test.each([
		'https://example.com',
		'LPA:2$rsp.example.com$A',
		'LPA:1$127.0.0.1$A',
		'LPA:1$localhost$A',
		'LPA:1$rsp.example.com/path$A',
		'LPA:1$rsp.example.com$',
		`${code}$$2`,
		`${code}$$1$extra`,
		`${code}\nsecret`,
	])('rejects malformed or unsupported activation input %s', (value) => {
		expect(parseEsimActivationCode(value)).toBeUndefined();
	});
	test('all management actions require explicit disruption acknowledgement', () => {
		expect(esimOperationInputSchema.safeParse({ device: '0', action: 'inspect' }).success).toBe(
			false,
		);
		expect(
			esimOperationInputSchema.safeParse({ device: '0', action: 'inspect', acknowledged: true })
				.success,
		).toBe(true);
		expect(
			esimOperationInputSchema.safeParse({
				device: '0',
				action: 'delete',
				acknowledged: true,
				snapshot: token,
				profileId: token,
				iccid: '123',
			}).success,
		).toBe(false);
	});
	test('profile changes carry fresh opaque state and download credentials are input-only', () => {
		expect(
			esimOperationInputSchema.safeParse({
				device: '0',
				action: 'enable',
				acknowledged: true,
				profileId: token,
			}).success,
		).toBe(false);
		const output = esimOperationOutputSchema.parse({
			success: true,
			activationCode: code,
			eid: 'private',
			snapshot: { token, profiles: [], iccid: 'private' },
		});
		expect(output).toEqual({ success: true, snapshot: { token, profiles: [] } });
	});
});
