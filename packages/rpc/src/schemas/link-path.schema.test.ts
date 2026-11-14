import { expect, test } from 'bun:test';
import { linkPathsSchema, statusResponseSchema, statusUpdateSchema } from './status.schema';

test('selected paths accept every disposition without requiring older backends to report it', () => {
	const link_paths = {
		a: 'ipv4',
		b: 'ipv6',
		c: 'clat',
		d: 'receiver-ipv4-only',
		e: 'waiting',
		f: 'no-source',
		g: 'incompatible',
		h: 'unknown',
	};
	expect(linkPathsSchema.parse(link_paths)).toEqual(link_paths);
	expect(statusResponseSchema.parse({ link_paths }).link_paths).toEqual(link_paths);
	expect(statusUpdateSchema.parse({ link_paths }).link_paths).toEqual(link_paths);
	expect(statusResponseSchema.parse({})).toEqual({});
	expect(linkPathsSchema.safeParse({ a: 'healthy' }).success).toBe(false);
	expect(statusResponseSchema.parse({ link_paths: {} }).link_paths).toEqual({});
});
