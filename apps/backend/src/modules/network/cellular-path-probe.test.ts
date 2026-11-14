import { expect, test } from "bun:test";
import {
	type CellularProbeDeps,
	probeCellularDns,
	probeCellularHttps,
} from "./cellular-path-probe.ts";
import { buildIpv4OnlyArpaQuery } from "./nat64.ts";

test("DNS binds both fields and accepts only its fixed, bounded response", async () => {
	const seen: unknown[] = [];
	const deps: CellularProbeDeps = {
		transactionId: () => 17,
		https: async () => {
			throw new Error("No HTTPS");
		},
		datagram: async (input) => {
			seen.push(input);
			const reply = buildIpv4OnlyArpaQuery(17);
			reply[2] = 0x81;
			reply[3] = 0x80;
			return reply;
		},
	};
	const path = {
		device: "wwan0",
		source: "2001:db8::2",
		dns: ["192.0.2.53", "2001:db8::53"],
	};
	expect(await probeCellularDns(path, deps)).toEqual({ ok: true });
	expect(seen[0]).toMatchObject({
		device: "wwan0",
		source: "2001:db8::2",
		remote: "2001:db8::53",
		maxReplyBytes: 4096,
		timeoutMs: 3000,
	});
	expect(
		await probeCellularDns({ ...path, dns: ["192.0.2.53"] }, deps),
	).toEqual({ ok: false });
	expect(seen.length).toBe(1);
	expect(
		await probeCellularDns(path, {
			...deps,
			datagram: async () => buildIpv4OnlyArpaQuery(18),
		}),
	).toEqual({ ok: false });
});
test("HTTPS carries exact device, source, index and cancellation to the native binding", async () => {
	const path = { device: "cclat1", source: "198.18.255.1", ifindex: 42 },
		seen: unknown[] = [],
		abort = new AbortController();
	const deps: CellularProbeDeps = {
		transactionId: () => 1,
		datagram: async () => undefined,
		https: async (input) => {
			seen.push(input);
			return "ok";
		},
	};
	expect(await probeCellularHttps(path, deps, abort.signal)).toBe("ok");
	expect(seen).toEqual([{ ...path, signal: abort.signal }]);
	abort.abort();
	expect(await probeCellularHttps(path, deps, abort.signal)).toBe(
		"unavailable",
	);
	expect(seen).toHaveLength(1);
});

test("missing probe runtimes are unknown; a bounded transfer timeout is a path failure", async () => {
	const deps: CellularProbeDeps = {
		transactionId: () => 17,
		datagram: async () => {
			throw new Error("socket runtime unavailable");
		},
		https: async () => {
			throw new Error("missing HTTPS runtime");
		},
	};
	expect(
		await probeCellularDns(
			{ device: "wwan0", source: "192.0.2.2", dns: ["192.0.2.53"] },
			deps,
		),
	).toEqual({ ok: false, unavailable: true });
	const path = { device: "wwan0", source: "192.0.2.2" };
	expect(await probeCellularHttps(path, deps)).toBe("unavailable");
	expect(
		await probeCellularHttps(path, { ...deps, https: async () => "failed" }),
	).toBe("failed");
});
