import { expect, it, spyOn } from "bun:test";
import * as dns from "node:dns/promises";
import { call } from "@orpc/server";
import * as probes from "../modules/streaming/transport/validate.ts";
import { relayValidateProcedure } from "../rpc/procedures/relay.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

for (const addresses of [
	["::1", "127.0.0.1"],
	["127.0.0.1", "::1"],
]) {
	for (const reason of ["refused", "timeout"] as const) {
		it(`tries the next address after ${reason}, first ${addresses[0]}`, async () => {
			const lookup = spyOn(dns, "lookup").mockResolvedValue(
				addresses.map((address) => ({
					address,
					family: address.includes(":") ? 6 : 4,
				})) as never,
			);
			const probe = spyOn(probes, "probeReachability")
				.mockResolvedValueOnce({ reachable: false, reason })
				.mockResolvedValueOnce({ reachable: true });
			try {
				expect(
					await call(
						relayValidateProcedure,
						{ addr: "relay.invalid", port: 9000 },
						{ context: makeContext() },
					),
				).toEqual({ valid: true, stage: "probe", reason: "IPv6" });
				expect(lookup).toHaveBeenCalledWith("relay.invalid", { all: true });
				expect(probe.mock.calls.map((args) => args[0])).toEqual([
					"127.0.0.1",
					"::1",
				]);
			} finally {
				lookup.mockRestore();
				probe.mockRestore();
			}
		});
	}
}
it("returns a probe failure only after all addresses fail", async () => {
	const lookup = spyOn(dns, "lookup").mockResolvedValue([
		{ address: "::1", family: 6 },
		{ address: "127.0.0.1", family: 4 },
	] as never);
	const probe = spyOn(probes, "probeReachability").mockResolvedValue({
		reachable: false,
		reason: "refused",
	});
	try {
		expect(
			await call(
				relayValidateProcedure,
				{ addr: "relay.invalid", port: 9000 },
				{ context: makeContext() },
			),
		).toEqual({ valid: false, stage: "probe", reason: "refused" });
		expect(probe).toHaveBeenCalledTimes(2);
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

for (const code of ["EAFNOSUPPORT", "EADDRNOTAVAIL"]) {
	it(`falls back to a real IPv4 peer after ${code} on the AAAA answer`, async () => {
		const server = await Bun.udpSocket({
			hostname: "127.0.0.1",
			socket: {
				data(socket, _buf, port, addr) {
					socket.send("pong", port, addr);
				},
			},
		});
		const lookup = spyOn(dns, "lookup").mockResolvedValue([
			{ address: "::1", family: 6 },
			{ address: "127.0.0.2", family: 4 },
			{ address: "127.0.0.1", family: 4 },
		] as never);
		const original = Bun.udpSocket;
		const socket = spyOn(Bun, "udpSocket").mockImplementation((options) => {
			if (options.hostname === "::")
				throw Object.assign(new Error(`${code}: connect`), { code });
			return original(options);
		});
		try {
			expect(
				await call(
					relayValidateProcedure,
					{ addr: "relay.invalid", port: server.port },
					{ context: makeContext() },
				),
			).toEqual({ valid: true, stage: "probe", reason: "IPv4" });
			expect(socket).toHaveBeenCalledTimes(3);
		} finally {
			socket.mockRestore();
			lookup.mockRestore();
			server.close();
		}
	});
}

it("stops after the first reachable address", async () => {
	const lookup = spyOn(dns, "lookup").mockResolvedValue([
		{ address: "::1", family: 6 },
		{ address: "127.0.0.1", family: 4 },
	] as never);
	const probe = spyOn(probes, "probeReachability").mockResolvedValue({
		reachable: true,
	});
	try {
		expect(
			await call(
				relayValidateProcedure,
				{ addr: "relay.invalid", port: 9000 },
				{ context: makeContext() },
			),
		).toEqual({ valid: true, stage: "probe", reason: "IPv4" });
		expect(probe).toHaveBeenCalledTimes(1);
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

it("interleaves families starting with IPv4", async () => {
	const lookup = spyOn(dns, "lookup").mockResolvedValue([
		{ address: "::1", family: 6 },
		{ address: "::2", family: 6 },
		{ address: "127.0.0.1", family: 4 },
		{ address: "127.0.0.2", family: 4 },
	] as never);
	const probe = spyOn(probes, "probeReachability").mockResolvedValue({
		reachable: false,
		reason: "refused",
	});
	try {
		await call(
			relayValidateProcedure,
			{ addr: "relay.invalid", port: 9000 },
			{ context: makeContext() },
		);
		expect(probe.mock.calls.map((args) => args[0])).toEqual([
			"127.0.0.1",
			"::1",
			"127.0.0.2",
			"::2",
		]);
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

// A monotonic test clock advances only when the simulated network consumes time.
it("bounds many silent answers including DNS to nine seconds", async () => {
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	const lookup = spyOn(dns, "lookup").mockImplementation(async () => {
		now += 1000;
		return Array.from({ length: 10 }, (_, i) => ({
			address: `127.0.0.${i + 1}`,
			family: 4,
		})) as never;
	});
	const probe = spyOn(probes, "probeReachability").mockImplementation(
		async (_ip, _port, timeout = 3000) => {
			now += timeout;
			return { reachable: false, reason: "timeout" };
		},
	);
	try {
		expect(
			await call(
				relayValidateProcedure,
				{ addr: "relay.invalid", port: 9000 },
				{ context: makeContext() },
			),
		).toEqual({ valid: false, stage: "probe", reason: "timeout" });
		expect(now).toBe(9000);
		expect(probe.mock.calls.map((args) => args[2])).toEqual([3000, 3000, 2000]);
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
		clock.mockRestore();
	}
});

it("continues after unexpected setup failure and reports the family that answered", async () => {
	const lookup = spyOn(dns, "lookup").mockResolvedValue([
		{ address: "127.0.0.1", family: 4 },
		{ address: "::1", family: 6 },
	] as never);
	const probe = spyOn(probes, "probeReachability")
		.mockRejectedValueOnce(new Error("unexpected setup"))
		.mockResolvedValueOnce({ reachable: true });
	try {
		expect(
			await call(
				relayValidateProcedure,
				{ addr: "relay.invalid", port: 9000 },
				{ context: makeContext() },
			),
		).toEqual({ valid: true, stage: "probe", reason: "IPv6" });
		expect(probe).toHaveBeenCalledTimes(2);
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

it("does not probe a DNS answer delivered after its deadline", async () => {
	let deliver!: (value: never) => void;
	const lookup = spyOn(dns, "lookup").mockImplementation(
		() =>
			new Promise((resolve) => {
				deliver = resolve;
			}) as never,
	);
	const probe = spyOn(probes, "probeReachability");
	const original = globalThis.setTimeout;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay: number,
	) => original(callback, delay === 9000 ? 0 : delay)) as typeof setTimeout);
	try {
		expect(
			await call(
				relayValidateProcedure,
				{ addr: "relay.invalid", port: 9000 },
				{ context: makeContext() },
			),
		).toEqual({
			valid: false,
			stage: "dns",
			reason: "Cannot resolve host 'relay.invalid'",
		});
		deliver([{ address: "127.0.0.1", family: 4 }] as never);
		await Promise.resolve();
		expect(probe).not.toHaveBeenCalled();
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
		timer.mockRestore();
	}
});

it("surfaces an unexpected error only after all remaining addresses fail", async () => {
	const lookup = spyOn(dns, "lookup").mockResolvedValue([
		{ address: "127.0.0.1", family: 4 },
		{ address: "::1", family: 6 },
	] as never);
	const probe = spyOn(probes, "probeReachability")
		.mockRejectedValueOnce(new Error("unexpected setup"))
		.mockResolvedValueOnce({ reachable: false, reason: "refused" });
	try {
		await expect(
			call(
				relayValidateProcedure,
				{ addr: "relay.invalid", port: 9000 },
				{ context: makeContext() },
			),
		).rejects.toThrow("unexpected setup");
		expect(probe).toHaveBeenCalledTimes(2);
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});
