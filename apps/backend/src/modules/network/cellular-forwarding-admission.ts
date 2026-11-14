import { readFile } from "node:fs/promises";
import {
	type CellularScopedLink,
	readScopedCellularSysctl,
} from "./cellular-host-identity.ts";
import { isSafeIfname } from "./safe-ifname.ts";

export type CellularForwardingAdmission =
	| {
			readonly ok: false;
			readonly reason: "identity-unavailable" | "forwarding-unavailable";
	  }
	| {
			readonly ok: true;
			readonly mode: "per-link";
			readonly original: readonly ["0" | "1", "0" | "1"];
	  };
export interface CellularForwardingIO {
	readonly global: () => Promise<string>;
	readonly force: (link: CellularScopedLink) => Promise<string | undefined>;
}
const io: CellularForwardingIO = {
	global: async () =>
		(await readFile("/proc/sys/net/ipv6/conf/all/forwarding", "utf8")).trim(),
	force: async (link) => {
		try {
			return await readScopedCellularSysctl(link, "force_forwarding");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		}
	},
};
/** Read-only prerequisite for the two ingress directions. Per-device
 * forwarding alone is insufficient on older kernels. This function never
 * enables global forwarding or treats a missing per-link capability as yes.
 * The returned baselines must be journalled before per-link effects; admission
 * does not claim the forwarding/filter/RA policy has been physically qualified.
 */
export async function admitCellularForwarding(
	physical: CellularScopedLink,
	translator: CellularScopedLink,
	deps: CellularForwardingIO = io,
): Promise<CellularForwardingAdmission> {
	for (const link of [physical, translator])
		if (
			!isSafeIfname(link.ifname) ||
			["all", "default", "lo", ".", ".."].includes(link.ifname)
		)
			throw new Error("Invalid forwarding instance");
	if (physical.ifname === translator.ifname)
		throw new Error("Forwarding instances overlap");
	const current = async () => {
		try {
			return (await physical.current()) && (await translator.current());
		} catch {
			return false;
		}
	};
	if (!(await current())) return { ok: false, reason: "identity-unavailable" };
	try {
		const global = await deps.global();
		if (global !== "0" && global !== "1")
			return { ok: false, reason: "forwarding-unavailable" };
		const first = await deps.force(physical),
			second = await deps.force(translator);
		if (!(await current()))
			return { ok: false, reason: "identity-unavailable" };
		if (
			(first !== "0" && first !== "1") ||
			(second !== "0" && second !== "1") ||
			(await deps.global()) !== global
		)
			return { ok: false, reason: "forwarding-unavailable" };
		if (!(await current()))
			return { ok: false, reason: "identity-unavailable" };
		return { ok: true, mode: "per-link", original: [first, second] };
	} catch {
		return { ok: false, reason: "forwarding-unavailable" };
	}
}
