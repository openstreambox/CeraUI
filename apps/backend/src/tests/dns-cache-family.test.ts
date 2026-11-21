import { afterEach, expect, spyOn, test } from "bun:test";
import * as textFiles from "../helpers/text-files.ts";
import {
	dnsCacheResolve,
	dnsCacheValidate,
	setDnsCacheEntryForTest,
	setDnsResolverFactoryForTest,
} from "../modules/network/dns.ts";

const name = "family-cache.test.invalid";
afterEach(() => {
	setDnsCacheEntryForTest(name, null);
	setDnsResolverFactoryForTest(null);
});

for (const family of ["a", "aaaa"] as const) {
	test(`a live ${family} answer replaces only its cached family`, async () => {
		setDnsCacheEntryForTest(name, [
			"192.0.2.10",
			"192.0.2.11",
			"fd51::2",
			"fd51::3",
		]);
		setDnsResolverFactoryForTest(() => ({
			cancel() {},
			resolve4(host, cb) {
				queueMicrotask(() =>
					cb(
						null,
						host === "wellknown.belabox.net" ? ["127.1.33.7"] : ["192.0.2.20"],
					),
				);
			},
			resolve6(_host, cb) {
				queueMicrotask(() => cb(null, ["fd51::9"]));
			},
		}));
		expect((await dnsCacheResolve(name, family)).fromCache).toBe(false);
		await dnsCacheValidate(name);
		setDnsResolverFactoryForTest(() => ({
			cancel() {},
			resolve4(_host, cb) {
				queueMicrotask(() => cb(new Error("offline"), []));
			},
			resolve6(_host, cb) {
				queueMicrotask(() => cb(new Error("offline"), []));
			},
		}));
		const cached = await dnsCacheResolve(name);
		expect(cached.fromCache).toBe(true);
		expect(cached.addrs).toEqual(
			family === "a"
				? ["192.0.2.20", "fd51::2", "fd51::3"]
				: ["192.0.2.10", "192.0.2.11", "fd51::9"],
		);
	});
}

for (const emptyFamily of [undefined, "a", "aaaa"] as const) {
	test(`an empty live answer never creates a cache (${emptyFamily})`, async () => {
		const writer = spyOn(textFiles, "writeTextFileAtomic").mockReturnValue(
			true,
		);
		setDnsResolverFactoryForTest(() => ({
			cancel() {},
			resolve4(host, cb) {
				queueMicrotask(() =>
					cb(null, host === "wellknown.belabox.net" ? ["127.1.33.7"] : []),
				);
			},
			resolve6(_host, cb) {
				queueMicrotask(() => cb(null, []));
			},
		}));
		try {
			await dnsCacheResolve(name, "a");
			await dnsCacheValidate(name, emptyFamily);
			expect(writer).not.toHaveBeenCalled();
		} finally {
			writer.mockRestore();
		}
	});
}
