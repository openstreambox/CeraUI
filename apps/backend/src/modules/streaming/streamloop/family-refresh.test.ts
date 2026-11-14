import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createFamilyRefresh } from "./family-refresh.ts";

test("restoration resolves before publishing and owns the same refresh lifecycle", () => {
	const source = readFileSync(
		new URL("../stream-restoration.ts", import.meta.url),
		"utf8",
	);
	expect(source.indexOf("await resolveSrtla(resolved.srtlaAddr)")).toBeLessThan(
		source.indexOf("await prepareSrtlaIpAddresses("),
	);
	expect(source).toContain("attachFamilyRefresh(");
	expect(source).toContain("generation");
});
test("family refresh observes ticks and changes, prevents overlap and disposes both", async () => {
	let tick = () => {},
		change = () => {},
		cleared = 0,
		removed = 0,
		calls = 0;
	const pending = Promise.withResolvers<void>();
	const dispose = createFamilyRefresh(
		async () => {
			calls++;
			await pending.promise;
		},
		{
			interval: (fn, ms) => {
				expect(ms).toBe(2000);
				tick = fn;
				return () => {
					cleared++;
				};
			},
			subscribe: (fn) => {
				change = fn;
				return () => {
					removed++;
				};
			},
		},
	);
	tick();
	change();
	expect(calls).toBe(1);
	pending.resolve();
	await Promise.resolve();
	await Promise.resolve();
	change();
	expect(calls).toBe(2);
	dispose();
	tick();
	change();
	expect(calls).toBe(2);
	expect(cleared).toBe(1);
	expect(removed).toBe(1);
});
