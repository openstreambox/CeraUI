import { isIPv6 } from "node:net";
import type { CellularRoutePlan } from "./cellular-route-plan.ts";
import {
	formatIpv6,
	formatNat64Prefix,
	parseIpv6,
	parseNat64Prefix,
} from "./nat64.ts";

/** One static mapping per uplink. Internal translator addresses do not become
 * host addresses, routes or DNS. No arbitrary configuration directive is passed
 * through from a profile or a modem response.
 */
export function cellularTranslatorConfig(plan: CellularRoutePlan): string {
	const slot = plan.table - 250_000;
	if (
		!Number.isInteger(slot) ||
		slot < 1 ||
		slot > 32 ||
		!plan.translated ||
		plan.tun !== `cclat${slot}` ||
		plan.device !== plan.tun ||
		plan.source !== `198.18.255.${slot}` ||
		!plan.mapped ||
		plan.mapped.includes("%") ||
		!isIPv6(plan.mapped) ||
		!plan.nat64 ||
		plan.nat64.includes("%")
	)
		throw new Error("Invalid translator mapping identity");
	const mapped = parseIpv6(plan.mapped),
		prefix = parseNat64Prefix(plan.nat64);
	if (
		!mapped ||
		!prefix ||
		!mapped.some((byte) => byte !== 0) ||
		(mapped[0] ?? 0) === 0xff
	)
		throw new Error("Invalid translator IPv6 mapping");
	return `tun-device ${plan.tun}\nipv4-addr 192.0.0.${slot * 4 + 1}\nipv6-addr fd00:434c::${slot.toString(16)}\nprefix ${formatNat64Prefix(prefix)}\nmap ${plan.source} ${formatIpv6(mapped)}\n`;
}
