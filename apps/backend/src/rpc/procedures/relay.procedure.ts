/**
 * Relay Procedures
 *
 * `validate` proves a manual custom-relay endpoint is usable WITHOUT starting a
 * stream. It walks ordered stages and returns the first failure so the UI can
 * point the operator at the exact problem:
 *
 *   input    → address/port shape
 *   protocol → a working transport adapter exists for the protocol
 *   endpoint → the transport adapter accepts the config (golden srtla rules)
 *   dns      → the host resolves to an IP
 *   probe    → the resolved IP:port is actually reachable (UDP probe)
 *
 * The endpoint stage reuses the Task 7 transport adapter so validation stays in
 * lock-step with the live resolver. The two-phase design is: stages 1-4 vet the
 * config/DNS statically, then the `probe` stage tries each resolved address
 * with a timeout-bounded UDP reachability check against `addr:port` (see
 * `transport/validate.ts`) — never a full SRT/SRTLA session.
 */

import { lookup } from "node:dns/promises";

import {
	type RelayValidateOutput,
	relayValidateInputSchema,
	relayValidateOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { validatePortNo } from "../../helpers/number.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { resolveMockRelayValidate } from "../../mocks/providers/relay-validate.ts";
import { getAdapter } from "../../modules/streaming/transport/registry.ts";
import {
	NotImplementedError,
	UnknownProtocolError,
} from "../../modules/streaming/transport/types.ts";
import {
	PROBE_TIMEOUT_MS,
	probeReachability,
} from "../../modules/streaming/transport/validate.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

const baseProcedure = os.$context<RPCContext>();
const authedProcedure = baseProcedure.use(authMiddleware);

function fail(
	stage: RelayValidateOutput["stage"],
	reason: string,
): RelayValidateOutput {
	return { valid: false, stage, reason };
}

export const relayValidateProcedure = authedProcedure
	.input(relayValidateInputSchema)
	.output(relayValidateOutputSchema)
	.handler(async ({ input }): Promise<RelayValidateOutput> => {
		const addr = input.addr.trim();
		if (addr === "") return fail("input", "Address is required");
		if (!validatePortNo(input.port))
			return fail("input", "Port must be between 1 and 65535");

		const protocol = input.protocol ?? "srtla";
		let adapter: ReturnType<typeof getAdapter>;
		try {
			adapter = getAdapter(protocol);
		} catch (error) {
			if (error instanceof UnknownProtocolError)
				return fail("protocol", error.message);
			throw error;
		}

		try {
			adapter.validate({
				srtla_addr: addr,
				srtla_port: input.port,
				srt_streamid: input.streamid ?? "",
			});
		} catch (error) {
			const stage =
				error instanceof NotImplementedError ? "protocol" : "endpoint";
			return fail(
				stage,
				error instanceof Error ? error.message : "Invalid endpoint",
			);
		}

		// Test-infra seam (NOT egress): mock mode stubs ONLY the dns+probe network
		// stages below; input/protocol/endpoint above always run. Production
		// (shouldUseMocks() === false) takes the real network path, untouched.
		if (shouldUseMocks()) return resolveMockRelayValidate();

		// Nine seconds includes DNS and leaves 21 seconds before the client RPC
		// timeout. DNS cannot be cancelled, but a late answer never starts probes.
		const deadline = performance.now() + 9000;
		let dnsTimer: ReturnType<typeof setTimeout> | undefined;
		let addresses: { address: string; family: number }[];
		try {
			addresses = await Promise.race([
				lookup(addr, { all: true }),
				new Promise<never>((_, reject) => {
					dnsTimer = setTimeout(() => reject(new Error("DNS deadline")), 9000);
				}),
			]);
		} catch {
			return fail("dns", `Cannot resolve host '${addr}'`);
		} finally {
			clearTimeout(dnsTimer);
		}

		// The live sender prefers IPv4 when available. Preserve order within
		// each family, alternating so a dead family cannot monopolize the budget.
		const v4 = addresses.filter(({ family }) => family === 4);
		const v6 = addresses.filter(({ family }) => family === 6);
		const ordered = Array.from(
			{ length: Math.max(v4.length, v6.length) },
			(_, i) => [v4[i], v6[i]],
		)
			.flat()
			.filter((a) => a !== undefined);
		let reason = "timeout";
		let unexpected: unknown;
		for (const { address, family } of ordered) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) break;
			try {
				const probe = await probeReachability(
					address,
					input.port,
					Math.min(PROBE_TIMEOUT_MS, remaining),
				);
				if (probe.reachable)
					return { valid: true, stage: "probe", reason: `IPv${family}` };
				reason = probe.reason;
			} catch (error) {
				unexpected ??= error;
			}
		}
		if (unexpected !== undefined) throw unexpected;
		return fail("probe", reason);
	});
