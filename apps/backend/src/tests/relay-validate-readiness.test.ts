import { afterEach, expect, it, spyOn } from "bun:test";
import * as dns from "node:dns/promises";
import { call } from "@orpc/server";
import {
	receiverEvidenceFor,
	resetStreamReadinessForTest,
} from "../modules/streaming/stream-readiness.ts";
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

const KEY = "relay.invalid:9000";

afterEach(() => resetStreamReadinessForTest());

async function validate(): Promise<unknown> {
	return await call(
		relayValidateProcedure,
		{ addr: "Relay.invalid", port: 9000 },
		{ context: makeContext() },
	);
}

function resolvesTo(addresses: string[]) {
	return spyOn(dns, "lookup").mockResolvedValue(
		addresses.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		})) as never,
	);
}

it("a reachable test is evidence for the stream-ready flag", async () => {
	const lookup = resolvesTo(["127.0.0.1"]);
	const probe = spyOn(probes, "probeReachability").mockResolvedValue({
		reachable: true,
	});
	try {
		expect(await validate()).toMatchObject({ valid: true });
		expect(receiverEvidenceFor(KEY, Date.now())).toBe("reachable");
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

it("an explicit refusal on every address counts against the receiver", async () => {
	const lookup = resolvesTo(["::1", "127.0.0.1"]);
	const probe = spyOn(probes, "probeReachability").mockResolvedValue({
		reachable: false,
		reason: "refused",
	});
	try {
		expect(await validate()).toMatchObject({ valid: false, stage: "probe" });
		expect(receiverEvidenceFor(KEY, Date.now())).toBe("refused");
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

it("a refusal on one address and silence on another is inconclusive", async () => {
	const lookup = resolvesTo(["::1", "127.0.0.1"]);
	const probe = spyOn(probes, "probeReachability")
		.mockResolvedValueOnce({ reachable: false, reason: "refused" })
		.mockResolvedValueOnce({ reachable: false, reason: "timeout" });
	try {
		expect(await validate()).toMatchObject({ valid: false });
		expect(receiverEvidenceFor(KEY, Date.now())).toBe("inconclusive");
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

it("a probe that failed on this box counts as inconclusive, not refused", async () => {
	const lookup = resolvesTo(["::1"]);
	const probe = spyOn(probes, "probeReachability").mockResolvedValue({
		reachable: false,
		reason: "refused",
		local: true,
	});
	try {
		expect(await validate()).toMatchObject({ valid: false, reason: "refused" });
		expect(receiverEvidenceFor(KEY, Date.now())).toBe("inconclusive");
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

it("a local socket failure is no refusal", async () => {
	const lookup = resolvesTo(["127.0.0.1"]);
	const probe = spyOn(probes, "probeReachability").mockRejectedValue(
		new Error("EAFNOSUPPORT"),
	);
	try {
		await expect(validate()).rejects.toThrow();
		expect(receiverEvidenceFor(KEY, Date.now())).toBe("inconclusive");
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

it("testing another endpoint keeps this one's result", async () => {
	const lookup = resolvesTo(["127.0.0.1"]);
	const probe = spyOn(probes, "probeReachability").mockResolvedValue({
		reachable: true,
	});
	try {
		await validate();
		await call(
			relayValidateProcedure,
			{ addr: "other.invalid", port: 9000 },
			{ context: makeContext() },
		);
		expect(receiverEvidenceFor(KEY, Date.now())).toBe("reachable");
		expect(receiverEvidenceFor("other.invalid:9000", Date.now())).toBe(
			"reachable",
		);
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

it("a silent port is no evidence either way", async () => {
	const lookup = resolvesTo(["127.0.0.1"]);
	const probe = spyOn(probes, "probeReachability").mockResolvedValue({
		reachable: false,
		reason: "timeout",
	});
	try {
		expect(await validate()).toMatchObject({ valid: false, reason: "timeout" });
		expect(receiverEvidenceFor(KEY, Date.now())).toBe("inconclusive");
	} finally {
		lookup.mockRestore();
		probe.mockRestore();
	}
});

it("a name that does not resolve counts against the receiver", async () => {
	const lookup = spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
	try {
		expect(await validate()).toMatchObject({ valid: false, stage: "dns" });
		expect(receiverEvidenceFor(KEY, Date.now())).toBe("unresolved");
	} finally {
		lookup.mockRestore();
	}
});
