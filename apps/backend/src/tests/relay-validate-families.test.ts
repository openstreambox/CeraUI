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
				).toEqual({ valid: true, stage: "probe" });
				expect(lookup).toHaveBeenCalledWith("relay.invalid", { all: true });
				expect(probe.mock.calls.map((args) => args[0])).toEqual(addresses);
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
			{ address: "127.0.0.1", family: 4 },
		] as never);
		const socket = spyOn(Bun, "udpSocket").mockImplementationOnce(() => {
			throw Object.assign(new Error(`${code}: connect`), { code });
		});
		try {
			expect(
				await call(
					relayValidateProcedure,
					{ addr: "relay.invalid", port: server.port },
					{ context: makeContext() },
				),
			).toEqual({ valid: true, stage: "probe" });
			expect(socket).toHaveBeenCalledTimes(2);
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
		).toEqual({ valid: true, stage: "probe" });
		expect(probe).toHaveBeenCalledTimes(1);
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});
