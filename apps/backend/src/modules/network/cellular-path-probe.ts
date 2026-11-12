import { randomInt } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import {
	type BoundDatagram,
	exchangeSourceBoundDatagram,
} from "../../helpers/source-bound-datagram.ts";
import {
	probeSourceBoundHttps,
	type SourceBoundHttpsPath,
	type SourceBoundHttpsResult,
} from "../../helpers/source-bound-https.ts";
import {
	buildIpv4OnlyArpaQuery,
	formatNat64Prefix,
	parseAaaaResponse,
	pref64FromIpv4OnlyArpa,
} from "./nat64.ts";
import { isSafeIfname } from "./safe-ifname.ts";

export interface CellularProbePath {
	readonly device: string;
	readonly source: string;
	readonly dns: readonly string[];
	readonly ifindex?: number;
}
export interface CellularProbeDeps {
	readonly datagram: (input: BoundDatagram) => Promise<Uint8Array | undefined>;
	readonly https: (
		path: SourceBoundHttpsPath,
	) => Promise<SourceBoundHttpsResult>;
	readonly transactionId: () => number;
}
export const defaultCellularProbeDeps: CellularProbeDeps = {
	datagram: exchangeSourceBoundDatagram,
	https: probeSourceBoundHttps,
	transactionId: () => randomInt(65536),
};
export type CellularDnsResult =
	| { readonly ok: false; readonly unavailable?: true }
	| { readonly ok: true; readonly nat64?: string };
/** The actual grant's resolver only, same-family literal endpoints, one packet
 * each way, fixed question, no system DNS or cross-uplink fallback.
 */
export async function probeCellularDns(
	path: CellularProbePath,
	deps: CellularProbeDeps = defaultCellularProbeDeps,
	signal?: AbortSignal,
): Promise<CellularDnsResult> {
	if (
		!isSafeIfname(path.device) ||
		(!isIPv4(path.source) && !isIPv6(path.source))
	)
		throw new Error("Invalid cellular DNS binding");
	const resolver = path.dns.find((address) =>
		isIPv4(path.source) ? isIPv4(address) : isIPv6(address),
	);
	if (!resolver || signal?.aborted) return { ok: false };
	const id = deps.transactionId(),
		payload = buildIpv4OnlyArpaQuery(id);
	let reply: Uint8Array | undefined;
	try {
		reply = await deps.datagram({
			device: path.device,
			...(path.ifindex !== undefined ? { ifindex: path.ifindex } : {}),
			source: path.source,
			remote: resolver,
			port: 53,
			payload,
			timeoutMs: 3000,
			maxReplyBytes: 4096,
			...(signal ? { signal } : {}),
		});
	} catch {
		return { ok: false, unavailable: true };
	}
	const answers = reply ? parseAaaaResponse(reply, id) : undefined;
	if (!answers || signal?.aborted) return { ok: false };
	const prefix = pref64FromIpv4OnlyArpa(answers);
	return { ok: true, ...(prefix ? { nat64: formatNat64Prefix(prefix) } : {}) };
}
/** The native helper binds the literal source and kernel device index. It has
 * no process, proxy, resolver, redirect or source-only fallback.
 */
export async function probeCellularHttps(
	path: Pick<CellularProbePath, "device" | "source" | "ifindex">,
	deps: CellularProbeDeps = defaultCellularProbeDeps,
	signal?: AbortSignal,
): Promise<SourceBoundHttpsResult> {
	if (!isSafeIfname(path.device) || !isIPv4(path.source))
		throw new Error("Invalid cellular HTTPS binding");
	if (signal?.aborted) return "unavailable";
	try {
		return await deps.https({ ...path, ...(signal ? { signal } : {}) });
	} catch {
		return "unavailable";
	}
}
